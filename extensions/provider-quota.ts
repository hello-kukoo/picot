/**
 * Provider quota probes (spec 2026-09-22): in-process usage probes for
 * configured providers, keyed by canonical baseUrl — never by provider id.
 *
 * Discipline: `redirect: "error"`, 8s timeout, 256KB response cap, closed
 * failure codes; credentials never leave this process. Endpoint semantics
 * are borrowed from opencodex's production probes.
 */

export type QuotaWindow = { label: string; percent: number; resetAt?: number };

export type QuotaFailureCode =
  | "not_configured"
  | "needs_login"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "response_unusable"
  | "destination_blocked";

export type QuotaReport = {
  provider: string;
  source: string;
  quota?: {
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    monthlyPercent?: number;
    monthlyResetAt?: number;
    customWindows?: QuotaWindow[];
    resetCredits?: number;
    updatedAt: number;
  };
  failure?: QuotaFailureCode;
};

const PROBE_TIMEOUT_MS = 8000;
const RESPONSE_BODY_CAP_BYTES = 256 * 1024;
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
/** Transient failures keep the last-good row for 30 minutes (opencodex rule). */
export const LAST_GOOD_RETENTION_MS = 30 * 60 * 1000;

/** Structural fetch substitute: a single-signature function is enough for
 * probes; tests inject plain mocks without the DOM overloads. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type NowLike = () => number;

type ProviderSpec = {
  /** Stable probe source label surfaced in reports. */
  source: string;
  /** Canonical baseUrls this probe may ever talk to (guard rail). */
  canonicalBaseUrls: string[];
  /** Builds the request for a configured provider instance. */
  buildRequest: (instance: ProviderInstance) => { url: string; init: RequestInit } | null;
  /** Parses the vendor JSON into the normalized quota shape. */
  parse: (json: unknown) => Partial<NonNullable<QuotaReport["quota"]>>;
};

export type ProviderInstance = {
  providerId: string;
  baseUrl: string;
  /** API key resolved at call time (auth.json or models.json entry). */
  apiKey?: string;
  /** openai-codex only: live OAuth access token + account id. */
  accessToken?: string;
  accountId?: string;
};

// ─── Vendor probes ─────────────────────────────────────────────────────────

const DAY_SECONDS = 24 * 60 * 60;
const MONTH_SECONDS = 28 * DAY_SECONDS;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Upstreams disagree on numeric encoding: WHAM sends numbers, deepseek sends
  // numeric strings ("642.65"). Coercing beats dropping the datum — parsed as
  // "missing" it rendered a card with no windows.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function epochSecondsToMs(value: unknown): number | undefined {
  const seconds = numberOr(value);
  if (seconds === undefined) return undefined;
  // Some vendors already send milliseconds; heuristic threshold 1e12.
  return seconds > 1e12 ? seconds : seconds * 1000;
}

/** opencodex WHAM window mapping, copied verbatim in semantics. */
export function parseWhamUsage(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const root = asRecord(json);
  const rateLimit = asRecord(root?.rate_limit);
  if (!rateLimit) return {};
  type Window = { percent?: number; resetAt?: number };
  const readWindow = (raw: unknown): Window | null => {
    const window = asRecord(raw);
    if (!window) return null;
    const percent = numberOr(window.used_percent);
    if (percent === undefined) return null;
    return {
      percent,
      resetAt: epochSecondsToMs(window.reset_at),
    };
  };
  const windows: { seconds: number; window: Window }[] = [];
  // Two observed wire shapes: rate_limit.primary and rate_limit.primary_window.
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const raw = asRecord(rateLimit[key]) ?? asRecord(rateLimit[`${key}_window`]);
    if (!raw) continue;
    const seconds = numberOr(raw.limit_window_seconds);
    const window = readWindow(raw);
    if (seconds === undefined || !window) continue;
    windows.push({ seconds, window });
  }
  // Role-based mapping (opencodex parseUsageQuota semantics): the window's
  // POSITION names its role; only the primary window may be a short burst
  // (skipped) or a monthly window by its own duration.
  const byRole: { fiveHour?: Window; weekly?: Window; monthly?: Window } = {};
  const primary = windows[0];
  if (primary) {
    if (primary.seconds >= MONTH_SECONDS) {
      byRole.monthly = primary.window;
    } else if (primary.seconds < DAY_SECONDS) {
      // Short burst window: skip; the 5h secondary window speaks instead.
    } else {
      byRole.weekly = primary.window;
    }
  }
  const secondary = windows[1];
  if (secondary) byRole.fiveHour ??= secondary.window;
  const tertiary = windows[2];
  if (tertiary) byRole.monthly ??= tertiary.window;
  const resetCredits = numberOr(asRecord(root?.rate_limit_reset_credits)?.available_count);
  return {
    fiveHourPercent: byRole.fiveHour?.percent,
    fiveHourResetAt: byRole.fiveHour?.resetAt,
    weeklyPercent: byRole.weekly?.percent,
    weeklyResetAt: byRole.weekly?.resetAt,
    monthlyPercent: byRole.monthly?.percent,
    monthlyResetAt: byRole.monthly?.resetAt,
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  };
}

/** zai quota rows: unit/number encode the window (unit3+number5 = 5h, unit6+number1 = week). */
export function parseZaiQuota(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const data = asRecord(asRecord(json)?.data);
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const result: Partial<NonNullable<QuotaReport["quota"]>> = { customWindows: [] };
  for (const raw of limits) {
    const limit = asRecord(raw);
    if (!limit) continue;
    const type = String(limit.type ?? "");
    if (type === "TIME_LIMIT") continue; // MCP monthly quota, not model quota
    const unit = numberOr(limit.unit);
    const number = numberOr(limit.number);
    let label = "";
    if (unit === 3 && number === 5) label = "5h";
    else if (unit === 6 && number === 1) label = "week";
    else label = `${number ?? "?"}`;
    const percent =
      numberOr(limit.percentage) ??
      (numberOr(limit.currentValue) !== undefined && numberOr(limit.usage) === 100
        ? 100
        : undefined);
    const resetAt = epochSecondsToMs(limit.nextResetTime);
    if (percent === undefined) continue;
    result.customWindows?.push({ label, percent, resetAt });
  }
  return result;
}

export function parseOpencodeUsage(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const usage = asRecord(asRecord(json)?.usage);
  if (!usage) return {};
  const read = (raw: unknown): { percent: number; resetAt?: number } | null => {
    const window = asRecord(raw);
    const percent = numberOr(window?.percent);
    if (percent === undefined) return null;
    return { percent, resetAt: epochSecondsToMs(window?.resetsAt) };
  };
  const rolling = read(usage.rolling);
  const weekly = read(usage.weekly);
  const monthly = read(usage.monthly);
  return {
    fiveHourPercent: rolling?.percent,
    fiveHourResetAt: rolling?.resetAt,
    weeklyPercent: weekly?.percent,
    weeklyResetAt: weekly?.resetAt,
    monthlyPercent: monthly?.percent,
    monthlyResetAt: monthly?.resetAt,
  };
}

/** Balance-style providers never fake a percent; they render a label bar. */
export function parseDeepseekBalance(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const root = asRecord(json);
  const infos = Array.isArray(root?.balance_infos) ? root.balance_infos : [];
  const labels: QuotaWindow[] = [];
  for (const raw of infos) {
    const info = asRecord(raw);
    const total = numberOr(info?.total_balance);
    if (total === undefined) continue;
    const currency = String(info?.currency ?? "").toUpperCase();
    labels.push({ label: `${currency} ${total.toFixed(2)}`, percent: 0 });
  }
  return labels.length > 0 ? { customWindows: labels } : {};
}

export function parseMinimaxRemains(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const data = asRecord(asRecord(json)?.data);
  const remainsMs = numberOr(data?.remains_time);
  const totalMs = numberOr(data?.total_time);
  if (totalMs !== undefined && remainsMs !== undefined && totalMs > 0) {
    const percent = Math.round(((totalMs - remainsMs) / totalMs) * 100);
    return { customWindows: [{ label: "5h", percent }] };
  }
  if (remainsMs !== undefined) {
    return {
      customWindows: [{ label: `剩余 ${Math.round(remainsMs / 3_600_000)}h`, percent: 0 }],
    };
  }
  return {};
}

export function parseMoonshotBalance(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const data = asRecord(asRecord(json)?.data);
  const available = numberOr(data?.available_balance);
  if (available === undefined) return {};
  return { customWindows: [{ label: `$${available.toFixed(2)}`, percent: 0 }] };
}

export function parseOllamaUsage(json: unknown): Partial<NonNullable<QuotaReport["quota"]>> {
  const limits = asRecord(asRecord(json)?.limits);
  if (!limits) return {};
  const result: Partial<NonNullable<QuotaReport["quota"]>> = {};
  const read = (raw: unknown) => {
    const entry = asRecord(asRecord(raw)?.usage);
    return numberOr(entry?.used_percent ?? entry?.percent);
  };
  const weekly = read(limits.weekly);
  const monthly = read(limits.monthly);
  const session = read(limits.session);
  result.weeklyPercent = weekly;
  result.monthlyPercent = monthly;
  if (session !== undefined) {
    result.customWindows = [{ label: "session", percent: session }];
  }
  return result;
}

// ─── Probe registry ────────────────────────────────────────────────────────

/** Canonical matching is by HOST. The specs list canonical hosts, while a live
 * provider's baseUrl carries a path (coding-plan gateways, `/backend-api`,
 * `/zen/go`), so comparing whole URLs dropped every provider whose endpoint
 * has a path — codex, zai and opencode-go all failed to match. */
/** Specs append their own path to a canonical host, so a provider whose own
 * baseUrl carries a version path (`.../api/coding/paas/v4`) must be reduced to
 * its origin: pasting the full baseUrl in front of the spec's path produced
 * `/v4/api/monitor/...` and a 404 for zai, moonshot and minimax. */
export function originOfBaseUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url.trim()).origin;
  } catch {
    return "";
  }
}

function baseUrlHost(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

const SPECS: ProviderSpec[] = [
  {
    source: "openai-codex:wham",
    canonicalBaseUrls: ["https://chatgpt.com"],
    buildRequest: ({ accessToken, accountId }) => {
      if (!accessToken) return null;
      return {
        url: "https://chatgpt.com/backend-api/wham/usage",
        init: {
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...(accountId ? { "chatgpt-account-id": accountId } : {}),
          },
        },
      };
    },
    parse: parseWhamUsage,
  },
  {
    source: "zai:quota-limit",
    canonicalBaseUrls: ["https://api.z.ai", "https://open.bigmodel.cn"],
    buildRequest: ({ baseUrl, apiKey }) => {
      if (!apiKey) return null;
      const isCn = normalizeBaseUrl(baseUrl).includes("bigmodel.cn");
      const headers: Record<string, string> = isCn
        ? { "x-api-key": apiKey }
        : { authorization: `Bearer ${apiKey}` };
      return {
        url: `${normalizeBaseUrl(baseUrl)}/api/monitor/usage/quota/limit`,
        init: { headers },
      };
    },
    parse: parseZaiQuota,
  },
  {
    source: "opencode-go:usage",
    canonicalBaseUrls: ["https://opencode.ai"],
    buildRequest: ({ apiKey }) =>
      apiKey
        ? {
            url: "https://opencode.ai/zen/go/v1/usage",
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: parseOpencodeUsage,
  },
  {
    source: "deepseek:balance",
    canonicalBaseUrls: ["https://api.deepseek.com"],
    buildRequest: ({ apiKey }) =>
      apiKey
        ? {
            url: "https://api.deepseek.com/user/balance",
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: parseDeepseekBalance,
  },
  {
    source: "minimax:token-plan",
    canonicalBaseUrls: ["https://www.minimax.io", "https://api.minimaxi.com"],
    buildRequest: ({ baseUrl, apiKey }) =>
      apiKey
        ? {
            url: `${normalizeBaseUrl(baseUrl)}/v1/token_plan/remains`,
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: parseMinimaxRemains,
  },
  {
    source: "moonshot:balance",
    canonicalBaseUrls: ["https://api.moonshot.ai", "https://api.moonshot.cn"],
    buildRequest: ({ baseUrl, apiKey }) =>
      apiKey
        ? {
            url: `${normalizeBaseUrl(baseUrl)}/v1/users/me/balance`,
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: parseMoonshotBalance,
  },
  {
    source: "ollama-cloud:usage",
    canonicalBaseUrls: ["https://ollama.com"],
    buildRequest: ({ apiKey }) =>
      apiKey
        ? {
            url: "https://ollama.com/api/usage",
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: parseOllamaUsage,
  },
];

/** Pure selector: which configured providers produce probes this run.
 *
 * The candidate list comes from pi's own provider list (`ModelRuntime`), not
 * from the model catalog: a provider exists whether or not one of its models
 * happens to carry a baseUrl, and `codex`/`opencode-go`/`zai-coding-cn` only
 * ever appear as providers. The canonical-host match stays (it is the
 * anti-spoof guard, not an id→endpoint map); being *configured* is not decided
 * here — pi reports an auth mechanism for every api-key provider, so that
 * predicate cannot distinguish a stored key from none. The probe decides:
 * with no resolvable credential it returns `not_configured`, and the UI hides
 * that provider (spec: 未配置的 provider 配额区不显示). */
export function providersOfInterest(input: {
  /** Providers from pi's provider list: id + its own baseUrl. */
  providers?: Array<{ providerId: string; baseUrl?: string }>;
  /** Custom provider entries from models.json (id → {baseUrl, apiKey?}); their
   * credential is the entry's own apiKey, not an auth.json provider entry. */
  modelsJsonProviders?: Record<string, { baseUrl?: string; apiKey?: string }>;
}): Array<{ providerId: string; spec: ProviderSpec }> {
  const out: Array<{ providerId: string; spec: ProviderSpec }> = [];
  const seen = new Set<string>();
  const consider = (providerId: string, baseUrl: string | undefined) => {
    if (!baseUrl) return;
    const host = baseUrlHost(baseUrl);
    if (!host) return;
    const spec = SPECS.find((candidate) =>
      candidate.canonicalBaseUrls.some((canonical) => baseUrlHost(canonical) === host),
    );
    if (!spec) return;
    const key = `${providerId}:${spec.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ providerId, spec });
  };
  for (const { providerId, baseUrl } of input.providers ?? []) {
    consider(providerId, baseUrl);
  }
  for (const [providerId, entry] of Object.entries(input.modelsJsonProviders ?? {})) {
    if (!entry?.apiKey) continue;
    consider(providerId, entry?.baseUrl);
  }
  return out;
}

// ─── Probe runner with cache ───────────────────────────────────────────────

export type QuotaProbeDeps = {
  fetchImpl?: FetchLike;
  now?: NowLike;
  /** Resolved credential for one provider id (injected by the op layer). */
  resolveInstance?: (providerId: string, spec: ProviderSpec) => Promise<ProviderInstance | null>;
};

export function createQuotaProbeCache(deps: QuotaProbeDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { report: QuotaReport; at: number }>();
  const inFlight = new Map<string, Promise<QuotaReport>>();
  const lastGood = new Map<string, { report: QuotaReport; at: number }>();

  async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, {
      ...init,
      // `manual` rather than `error`: a redirect is a blocked destination we
      // can name, not an opaque transport failure miscoded as a timeout.
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error("redirect_blocked"), { code: "destination_blocked" });
    }
    if (response.status === 429)
      throw Object.assign(new Error("rate_limited"), { code: "rate_limited" });
    if (!response.ok)
      throw Object.assign(new Error(`upstream_${response.status}`), { code: "upstream_error" });
    const text = await readCappedText(response, RESPONSE_BODY_CAP_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("bad_json"), { code: "response_unusable" });
    }
  }

  async function probeOne(
    providerId: string,
    spec: ProviderSpec,
    instance: ProviderInstance | null,
  ): Promise<QuotaReport> {
    if (!instance) {
      return { provider: providerId, source: spec.source, failure: "not_configured" };
    }
    let request: { url: string; init?: RequestInit } | null = null;
    try {
      request = spec.buildRequest(instance);
    } catch {
      // A spec bug or an unusable baseUrl must cost one card, not the whole
      // report: this throw used to escape and blank the entire section.
      return { provider: providerId, source: spec.source, failure: "response_unusable" };
    }
    if (!request) {
      // openai-codex without a live OAuth token needs a re-login.
      return {
        provider: providerId,
        source: spec.source,
        failure: providerId === "openai-codex" ? "needs_login" : "not_configured",
      };
    }
    try {
      const json = await fetchJson(request.url, request.init);
      const quota = spec.parse(json);
      const report: QuotaReport = {
        provider: providerId,
        source: spec.source,
        quota: { ...quota, updatedAt: now() },
      };
      lastGood.set(providerId, { report, at: now() });
      return report;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "timeout";
      const failure = (
        ["rate_limited", "upstream_error", "timeout", "response_unusable"].includes(code)
          ? code
          : "upstream_error"
      ) as QuotaFailureCode;
      // Transient failures keep the last-good row for a grace window;
      // response_unusable (and destination_blocked) drop it.
      if (failure === "rate_limited" || failure === "upstream_error" || failure === "timeout") {
        const good = lastGood.get(providerId);
        if (good && now() - good.at <= LAST_GOOD_RETENTION_MS) {
          return { ...good.report, failure };
        }
      }
      return { provider: providerId, source: spec.source, failure };
    }
  }

  return {
    async report(
      providerId: string,
      spec: ProviderSpec,
      instance: ProviderInstance | null,
      force = false,
    ) {
      const cached = cache.get(providerId);
      if (!force && cached && now() - cached.at < QUOTA_CACHE_TTL_MS) {
        return cached.report;
      }
      const pending = inFlight.get(providerId);
      if (pending) return pending;
      const task = probeOne(providerId, spec, instance).then((report) => {
        cache.set(providerId, { report, at: now() });
        return report;
      });
      inFlight.set(providerId, task);
      try {
        return await task;
      } finally {
        inFlight.delete(providerId);
      }
    },
    invalidate(providerId: string) {
      cache.delete(providerId);
    },
  };
}

// ─── Codex reset-credit consume (idempotency-keyed POST) ───────────────────

/** Read a response body with a hard byte cap. `fetch` buffers the whole body
 * for `text()`/`json()`, so the cap has to be enforced while streaming —
 * otherwise a hostile or runaway endpoint exhausts memory before any length
 * check can run. */
async function readCappedText(response: Response, cap: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("response_too_large"), { code: "response_unusable" });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Capped JSON body: same discipline as the probe path, shared by the Codex
 * reset-credit endpoints (whose responses are also upstream-controlled). */
async function readCappedJson(response: Response, cap: number): Promise<unknown> {
  const text = await readCappedText(response, cap);
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON keeps the closed failure code callers already handle.
    throw Object.assign(new Error("bad_json"), { code: "response_unusable" });
  }
}

const consumeInFlight = new Set<string>();

export async function consumeCodexResetCredit(input: {
  operationId: string;
  accessToken: string;
  accountId?: string;
  fetchImpl?: FetchLike;
}): Promise<
  | { ok: true; code: string; availableCount?: number }
  | { ok: false; error: "operation_in_flight" | "ambiguous" }
> {
  if (consumeInFlight.has(input.operationId)) {
    return { ok: false, error: "operation_in_flight" };
  }
  consumeInFlight.add(input.operationId);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.accessToken}`,
          ...(input.accountId ? { "chatgpt-account-id": input.accountId } : {}),
        },
        body: JSON.stringify({ redeem_request_id: input.operationId }),
        redirect: "error",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    const json = (await readCappedJson(response, RESPONSE_BODY_CAP_BYTES).catch(
      () => null,
    )) as Record<string, unknown> | null;
    if (!response.ok || !json || typeof json.code !== "string") {
      return { ok: false, error: "ambiguous" };
    }
    return {
      ok: true,
      code: json.code,
      availableCount: numberOr(json.available_count),
    };
  } catch {
    return { ok: false, error: "ambiguous" };
  } finally {
    consumeInFlight.delete(input.operationId);
  }
}

export async function inspectCodexResetCredits(input: {
  accessToken: string;
  accountId?: string;
  fetchImpl?: FetchLike;
}): Promise<{ credits: Array<{ grantedAt?: number; expiresAt?: number }> } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      {
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          ...(input.accountId ? { "chatgpt-account-id": input.accountId } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    const json = (await readCappedJson(response, RESPONSE_BODY_CAP_BYTES).catch(
      () => null,
    )) as Record<string, unknown> | null;
    const credits = Array.isArray(json?.credits) ? json.credits : null;
    if (!credits) return null;
    return {
      credits: credits.map((raw) => {
        const credit = asRecord(raw) ?? {};
        return {
          grantedAt: epochSecondsToMs(credit.granted_at),
          expiresAt: epochSecondsToMs(credit.expires_at),
        };
      }),
    };
  } catch {
    return null;
  }
}
