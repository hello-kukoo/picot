// ABOUTME: Host-origin WS URL/base resolution and brokerWs removal policy for the adapter.
// ABOUTME: Validates adapter URLs against the host origin and strips legacy discovery carry.

// Production contract being prototyped (Gate D §3/§5.2, D-GAP-05): under the
// host origin the page connects to exactly one WS — the host `/v2/ws` adapter
// endpoint. The legacy `?brokerWs=` query param (and its sessionStorage carry)
// must be removed so a stale Pi-origin broker can never be rediscovered, and
// any candidate broker URL that does not match the host origin must be
// rejected rather than trusted.

const BROKER_WS_STORAGE_KEY = "pi-studio:broker-ws-url";

/** Canonical host-origin WS endpoint for the page's current origin. */
export function hostOriginWsUrl(env = globalThis.window || globalThis) {
  const loc = env?.location;
  const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc?.host || "127.0.0.1"}/v2/ws`;
}

/** Remove the legacy brokerWs discovery carry: the query param and the
 * sessionStorage entry. Returns what was removed (for caller-scan evidence). */
export function stripBrokerWs(env = globalThis.window || globalThis) {
  const removed = { query: null, storage: null };
  try {
    const loc = env?.location;
    const search = loc?.search || "";
    const fromUrl = new URLSearchParams(search).get("brokerWs");
    if (fromUrl) {
      removed.query = fromUrl;
      const params = new URLSearchParams(search);
      params.delete("brokerWs");
      const remaining = params.toString();
      loc?.replace?.(`${loc.pathname}${remaining ? `?${remaining}` : ""}${loc.hash || ""}`);
    }
    if (env?.sessionStorage?.getItem?.(BROKER_WS_STORAGE_KEY)) {
      removed.storage = env.sessionStorage.getItem(BROKER_WS_STORAGE_KEY);
      env.sessionStorage.removeItem?.(BROKER_WS_STORAGE_KEY);
    }
  } catch {
    // Sanitization must never crash boot; removal report may stay empty.
  }
  return removed;
}

/** Validate a brokerWs candidate under host-origin policy: only URLs whose
 * origin matches the page's host origin may be used (the server-side adapter
 * endpoint). A Pi-origin or foreign URL is rejected — never silently dialed. */
export function validateBrokerWsCandidate(candidateUrl, env = globalThis.window || globalThis) {
  try {
    const parsed = new URL(candidateUrl);
    const pageHost = env?.location?.host;
    if (!pageHost) return { ok: false, reason: "unknown_page_origin" };
    if (parsed.host !== pageHost) {
      return { ok: false, reason: "foreign_origin", host: parsed.host };
    }
    if (parsed.pathname !== "/v2/ws") {
      return { ok: false, reason: "not_adapter_endpoint", pathname: parsed.pathname };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

/** Resolve `href` the way the WebView would under `<base href="/v/<fp>/" />`:
 * proves root-relative API paths stay on the host origin while relative
 * assets resolve under the fingerprint namespace (Gate D §3 static facts). */
export function resolveWithBase(href, baseHref, origin = "http://127.0.0.1:47821") {
  return new URL(href, new URL(baseHref, origin)).toString();
}
