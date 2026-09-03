// ABOUTME: Per-runtime-target readiness gate for startup configuration reads.
// ABOUTME: The eager Settings/Skills surfaces fire config reads at startup;
// this gate keeps them deferred until the CURRENT routing triple's first
// foreground runtime snapshot proves that runtime live — and re-arms whenever
// an in-page session adoption swaps the triple, so requests never target a
// runtime that is still spawning.

export function createConfigReadiness({ targetKeyOf }) {
  let readyKey = null;
  const waiters = new Map(); // key -> { resolve, reject }

  function waitUntilReady() {
    const key = targetKeyOf();
    if (!key) {
      return Promise.reject(new Error("No active session for configuration request"));
    }
    if (readyKey === key) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waiters.set(key, { resolve, reject });
    });
  }

  // A foreground snapshot for the CURRENT target just rendered: that target is
  // live. Release its waiter; fail fast every stale waiter whose key the
  // routing has already moved past (ConfigGateway has no timeout before the
  // request dispatches, so hanging waiters would stall callers forever).
  function noteForegroundSnapshot() {
    const key = targetKeyOf();
    if (!key) return;
    readyKey = key;
    for (const [waiterKey, waiter] of [...waiters]) {
      waiters.delete(waiterKey);
      if (waiterKey === key) waiter.resolve();
      else waiter.reject(new Error("Runtime target changed before configuration was sent"));
    }
  }

  return { waitUntilReady, noteForegroundSnapshot };
}
