// ABOUTME: Injects native desktop capability into same-origin host requests only.
// ABOUTME: Keeps bearer capability out of URLs, browser storage, and remote requests.

export const NATIVE_CAPABILITY_GLOBAL = "__PICOT_NATIVE_CAPABILITY__";
export const NATIVE_CAPABILITY_HEADER = "X-Picot-Desktop-Capability";

export function readInjectedCapability(env = globalThis) {
  try {
    const value = env?.[NATIVE_CAPABILITY_GLOBAL];
    return typeof value === "string" && value ? value : null;
  } catch {
    // Treat unavailable host globals as a non-native caller.
    return null;
  }
}

export function consumeInjectedCapability(env = globalThis) {
  const value = readInjectedCapability(env);
  if (!value) return null;
  try {
    env[NATIVE_CAPABILITY_GLOBAL] = undefined;
    delete env[NATIVE_CAPABILITY_GLOBAL];
  } catch {
    // Ignore non-configurable host globals.
  }
  return value;
}

function isHostOriginRequest(input, env = globalThis.window || globalThis) {
  const location = env?.location || globalThis.location;
  const pathname = typeof location?.pathname === "string" ? location.pathname : "";
  if (!pathname.startsWith("/workspaces/")) return false;

  try {
    const url = new URL(typeof input === "string" ? input : input?.url, location?.href);
    return url.origin === location?.origin;
  } catch {
    return false;
  }
}

export function installHostOriginFetch(env = globalThis) {
  if (env.__PICOT_HOST_FETCH_INSTALLED__) return;
  const originalFetch = env.fetch?.bind(env);
  if (!originalFetch) return;
  // Capture once before WebSocket hello consumes host global. Capability stays
  // in closure only; never enters URL, storage, or logs.
  const capability = readInjectedCapability(env);

  env.fetch = (input, init = {}) => {
    if (!isHostOriginRequest(input, env)) return originalFetch(input, init);
    if (!capability) return originalFetch(input, init);
    try {
      env[NATIVE_CAPABILITY_GLOBAL] = undefined;
      delete env[NATIVE_CAPABILITY_GLOBAL];
    } catch {
      // Ignore non-configurable host globals.
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set(NATIVE_CAPABILITY_HEADER, capability);
    return originalFetch(input, { ...init, headers });
  };
  Object.defineProperty(env, "__PICOT_HOST_FETCH_INSTALLED__", { value: true });
}
