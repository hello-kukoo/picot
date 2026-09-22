// ABOUTME: Auto-reveals folded history turns when the gate control scrolls
// ABOUTME: near the viewport top (spec: history gate scroll auto-load).
// One module-level observer at a time: the gate is a singleton per session.

/** Distance from the viewport top that triggers a reveal batch (Paseo value). */
export const AUTO_REVEAL_THRESHOLD_PX = 96;

let observer = null;
let intersecting = false;
let chainToken = 0;

/**
 * Observe the gate control against its scroller. `reveal` mounts one batch
 * and returns the remaining folded-turn count; while the control stays
 * connected and intersecting (the batch did not fill the viewport) the
 * chain continues one batch per animation frame, serially. Re-observing
 * replaces the previous observer and cancels its chain.
 */
export function observeGateAutoReveal(control, root, reveal) {
  disconnectGateAutoReveal();
  if (!control || typeof IntersectionObserver === "undefined") return;
  const token = ++chainToken;
  intersecting = false;

  const continueChain = () => {
    const remaining = reveal();
    if (typeof remaining !== "number" || remaining <= 0) return;
    requestAnimationFrame(() => {
      if (token !== chainToken) return;
      if (!control.isConnected || !intersecting) return;
      continueChain();
    });
  };

  observer = new IntersectionObserver(
    (entries) => {
      intersecting = entries.at(-1)?.isIntersecting ?? false;
      if (intersecting && token === chainToken) continueChain();
    },
    { root, rootMargin: `${AUTO_REVEAL_THRESHOLD_PX}px 0px 0px 0px` },
  );
  observer.observe(control);
}

/** Drop the observer and cancel any queued continuation. */
export function disconnectGateAutoReveal() {
  chainToken += 1;
  intersecting = false;
  observer?.disconnect();
  observer = null;
}
