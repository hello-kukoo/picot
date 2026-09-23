/**
 * Provider quota probe unit tests (spec 2026-09-22): vendor parser shapes
 * borrowed from opencodex's production probes, selector baseUrl guard,
 * cache TTL, and consume idempotency.
 */
import { describe, expect, test, vi } from "vitest";
import {
  consumeCodexResetCredit,
  createQuotaProbeCache,
  LAST_GOOD_RETENTION_MS,
  originOfBaseUrl,
  parseDeepseekBalance,
  parseMinimaxRemains,
  parseMoonshotBalance,
  parseOllamaUsage,
  parseOpencodeUsage,
  parseWhamUsage,
  parseZaiQuota,
  providersOfInterest,
  QUOTA_CACHE_TTL_MS,
} from "./provider-quota.ts";

/** A response stand-in carrying a real byte stream, so the probe's
 * streaming body cap is exercised instead of bypassed by the mock. */
function streamResponse(text: string, ok = true, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok,
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    text: async () => text,
  } as unknown as Response;
}

describe("parseWhamUsage", () => {
  test("maps weekly/5h/monthly windows and reset credits", () => {
    const json = {
      rate_limit: {
        primary_window: { used_percent: 42, reset_at: 1790000000, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 80, reset_at: 1790000100, limit_window_seconds: 18000 },
        tertiary_window: { used_percent: 10, reset_at: 1790000200, limit_window_seconds: 2419200 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    };
    const parsed = parseWhamUsage(json);
    expect(parsed.weeklyPercent).toBe(42);
    expect(parsed.fiveHourPercent).toBe(80);
    expect(parsed.monthlyPercent).toBe(10);
    expect(parsed.resetCredits).toBe(2);
    expect(parsed.fiveHourResetAt).toBe(1790000100 * 1000);
  });

  test("skips short burst windows and maps a >=28-day primary as monthly", () => {
    const json = {
      rate_limit: {
        primary_window: { used_percent: 5, reset_at: 1, limit_window_seconds: 600 },
        secondary_window: { used_percent: 55, reset_at: 2, limit_window_seconds: 18000 },
      },
    };
    const parsed = parseWhamUsage(json);
    expect(parsed.fiveHourPercent).toBe(55);
    expect(parsed.weeklyPercent).toBeUndefined();
  });
});

describe("parseZaiQuota", () => {
  test("decodes unit/number window labels and ignores TIME_LIMIT rows", () => {
    const parsed = parseZaiQuota({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 30, nextResetTime: 1790000000 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 12 },
          { type: "TIME_LIMIT", unit: 6, number: 1, percentage: 99 },
        ],
      },
    });
    expect(parsed.customWindows).toEqual([
      { label: "5h", percent: 30, resetAt: 1790000000 * 1000 },
      { label: "week", percent: 12, resetAt: undefined },
    ]);
  });
});

test("parseOpencodeUsage reads rolling/weekly/monthly", () => {
  const parsed = parseOpencodeUsage({
    usage: {
      rolling: { percent: 20, resetsAt: 1790000000 },
      weekly: { percent: 40, resetsAt: 1790000500 },
      monthly: { percent: 60 },
    },
  });
  expect(parsed.fiveHourPercent).toBe(20);
  expect(parsed.weeklyResetAt).toBe(1790000500 * 1000);
  expect(parsed.monthlyPercent).toBe(60);
});

test("parseDeepseekBalance renders balance labels without faking percents", () => {
  const parsed = parseDeepseekBalance({
    balance_infos: [
      { currency: "CNY", total_balance: 10.5, granted_balance: 5, topped_up_balance: 5.5 },
      { currency: "USD", total_balance: 2.25 },
    ],
  });
  expect(parsed.customWindows).toEqual([
    { label: "CNY 10.50", percent: 0 },
    { label: "USD 2.25", percent: 0 },
  ]);
});

test("parseMinimaxRemains computes a used percent with total, degrades to a label without", () => {
  expect(
    parseMinimaxRemains({ data: { remains_time: 7_200_000, total_time: 36_000_000 } }),
  ).toEqual({
    customWindows: [{ label: "5h", percent: 80 }],
  });
  expect(parseMinimaxRemains({ data: { remains_time: 7_200_000 } })).toEqual({
    customWindows: [{ label: "剩余 2h", percent: 0 }],
  });
});

test("parseMoonshotBalance formats the available balance", () => {
  expect(parseMoonshotBalance({ data: { available_balance: 12.3, voucher_balance: 1 } })).toEqual({
    customWindows: [{ label: "$12.30", percent: 0 }],
  });
});

test("parseOllamaUsage maps weekly/monthly/session usage", () => {
  const parsed = parseOllamaUsage({
    limits: {
      weekly: { usage: { used_percent: 33 } },
      monthly: { usage: { used_percent: 11 } },
      session: { usage: { used_percent: 5 } },
    },
  });
  expect(parsed.weeklyPercent).toBe(33);
  expect(parsed.monthlyPercent).toBe(11);
  expect(parsed.customWindows).toEqual([{ label: "session", percent: 5 }]);
});

describe("originOfBaseUrl", () => {
  test("reduces a versioned baseUrl to its origin so the spec path stays correct", () => {
    expect(originOfBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe("https://api.z.ai");
    expect(originOfBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(
      "https://open.bigmodel.cn",
    );
    expect(originOfBaseUrl("https://api.moonshot.ai/v1")).toBe("https://api.moonshot.ai");
    expect(originOfBaseUrl(undefined)).toBe("");
    expect(originOfBaseUrl("not a url")).toBe("");
  });
});

describe("probe isolation", () => {
  test("a spec that throws while building its request fails one report, not the run", async () => {
    const cache = createQuotaProbeCache();
    const report = await cache.report(
      "zai",
      {
        source: "zai:quota-limit",
        canonicalBaseUrls: ["https://api.z.ai"],
        buildRequest: () => {
          throw new TypeError("url.trim is not a function");
        },
        parse: () => ({}),
      } as never,
      { providerId: "zai", baseUrl: "", apiKey: "k" },
      true,
    );
    expect(report.failure).toBe("response_unusable");
  });
});

describe("parseDeepseekBalance", () => {
  test("reads balances that arrive as numeric strings", () => {
    const parsed = parseDeepseekBalance({
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "642.65",
          granted_balance: "0.00",
          topped_up_balance: "642.65",
        },
      ],
    });
    expect(parsed.customWindows).toEqual([{ label: "CNY 642.65", percent: 0 }]);
  });
});

describe("providersOfInterest", () => {
  test("matches canonical hosts even when the provider endpoint carries a path", () => {
    const picked = providersOfInterest({
      // pi's real provider list: every one of these carries a path.
      providers: [
        { providerId: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
        { providerId: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
        { providerId: "zai-coding-cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
        { providerId: "opencode-go", baseUrl: "https://opencode.ai/zen/go" },
        { providerId: "deepseek", baseUrl: "https://api.deepseek.com" },
      ],
    });
    expect(picked.map((entry) => entry.providerId).sort()).toEqual([
      "deepseek",
      "openai-codex",
      "opencode-go",
      "zai",
      "zai-coding-cn",
    ]);
    expect(picked.find((entry) => entry.providerId === "openai-codex")?.spec.source).toBe(
      "openai-codex:wham",
    );
  });

  test("still refuses a look-alike host and a provider without a baseUrl", () => {
    const picked = providersOfInterest({
      providers: [
        { providerId: "my-relay", baseUrl: "https://open.bigmodel.cn.evil.example/api" },
        { providerId: "no-url" },
      ],
      modelsJsonProviders: { "relay-without-key": { baseUrl: "https://ollama.com" } },
    });
    expect(picked).toEqual([]);
  });

  test("keeps a custom models.json provider that carries its own apiKey", () => {
    const picked = providersOfInterest({
      modelsJsonProviders: { "my-ollama": { baseUrl: "https://ollama.com/v1", apiKey: "k" } },
    });
    expect(picked.map((entry) => entry.providerId)).toEqual(["my-ollama"]);
  });
});

describe("createQuotaProbeCache", () => {
  const spec = {
    source: "test:probe",
    canonicalBaseUrls: [],
    buildRequest: ({ apiKey }: { apiKey?: string }) =>
      apiKey
        ? {
            url: "https://example.test/usage",
            init: { headers: { authorization: `Bearer ${apiKey}` } },
          }
        : null,
    parse: () => ({}),
  };

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return streamResponse(JSON.stringify(body), ok, status);
  }

  test("a body past the cap fails closed while streaming", async () => {
    // 300 KiB: past the 256 KiB cap. The cap must trip during the read, not
    // after the whole body has already been buffered in memory.
    const oversized = `{"pad":"${"x".repeat(300 * 1024)}"}`;
    const fetchImpl = vi.fn(async () => streamResponse(oversized));
    const cache = createQuotaProbeCache({ fetchImpl, now: () => 1_000_000 });
    const instance = { providerId: "p", baseUrl: "https://example.test", apiKey: "k" };
    const report = await cache.report("p", spec, instance);
    expect(report.failure).toBe("response_unusable");
    expect(report.provider).toBe("p");
  });

  test("serves from cache within TTL and refetches after it", async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const cache = createQuotaProbeCache({ fetchImpl, now: () => clock });
    const instance = { providerId: "p", baseUrl: "https://example.test", apiKey: "k" };
    await cache.report("p", spec, instance);
    await cache.report("p", spec, instance);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += QUOTA_CACHE_TTL_MS + 1;
    await cache.report("p", spec, instance);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("force bypasses the cache", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const cache = createQuotaProbeCache({ fetchImpl });
    const instance = { providerId: "p", baseUrl: "https://example.test", apiKey: "k" };
    await cache.report("p", spec, instance);
    await cache.report("p", spec, instance, true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("upstream errors keep the last-good row within the retention window", async () => {
    let clock = 1_000_000;
    let ok = true;
    const fetchImpl = vi.fn(async () =>
      ok ? jsonResponse({ a: 1 }) : jsonResponse({ error: "x" }, false, 500),
    );
    const cache = createQuotaProbeCache({ fetchImpl, now: () => clock });
    const instance = { providerId: "p", baseUrl: "https://example.test", apiKey: "k" };
    await cache.report("p", spec, instance);
    ok = false;
    clock += 1000;
    const failing = await cache.report("p", spec, instance, true);
    expect(failing.quota).toBeDefined();
    expect(failing.failure).toBe("upstream_error");
    clock += LAST_GOOD_RETENTION_MS + 1;
    const dropped = await cache.report("p", spec, instance, true);
    expect(dropped.quota).toBeUndefined();
    expect(dropped.failure).toBe("upstream_error");
  });
});

describe("consumeCodexResetCredit", () => {
  test("rejects a concurrent duplicate operationId and reports ambiguous on garbage", async () => {
    const fetchImpl = vi.fn(
      async () =>
        // Reject quickly: stands in for the 8s probe timeout aborting.
        Promise.reject(new Error("network down")) as unknown as Promise<Response>,
    );
    const first = consumeCodexResetCredit({
      operationId: "op-1",
      accessToken: "t",
      fetchImpl,
    });
    const second = await consumeCodexResetCredit({
      operationId: "op-1",
      accessToken: "t",
      fetchImpl,
    });
    expect(second).toEqual({ ok: false, error: "operation_in_flight" });
    const settled = await first;
    expect(settled).toEqual({ ok: false, error: "ambiguous" });
  });

  test("returns the upstream code on success", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse200({ code: "reset", available_count: 1 });
    });
    const result = await consumeCodexResetCredit({
      operationId: "op-2",
      accessToken: "t",
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, code: "reset", availableCount: 1 });
    const body = JSON.parse((capturedInit as RequestInit).body as string);
    expect(body).toEqual({ redeem_request_id: "op-2" });
  });

  function jsonResponse200(body: unknown): Response {
    return streamResponse(JSON.stringify(body));
  }
});
