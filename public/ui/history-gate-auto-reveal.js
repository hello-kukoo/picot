// ABOUTME: Auto-reveals folded history turns when the scroller rolls within
// ABOUTME: AUTO_REVEAL_THRESHOLD_PX of the transcript top (Paseo's rule).
// ABOUTME: Position-based, not IntersectionObserver: the gate control is the
// ABOUTME: transcript's first element and never leaves an observer's zone
// ABOUTME: after a batch, so visibility transitions cannot express "the reader
// ABOUTME: is still scrolling up at the top".

/** Distance from the transcript top that triggers a reveal batch (Paseo value). */
export const AUTO_REVEAL_THRESHOLD_PX = 96;

let scroller = null;
let reveal = null;
let chainToken = 0;

const onScroll = () => {
  if (!scroller || !reveal) return;
  if (scroller.scrollTop > AUTO_REVEAL_THRESHOLD_PX) return;
  // One batch per scroll arrival. While the transcript still does not fill
  // the viewport the chain continues one batch per animation frame, serially;
  // a later arrival invalidates the chain via the token.
  const token = ++chainToken;
  const step = () => {
    const remaining = reveal();
    if (typeof remaining !== "number" || remaining <= 0) return;
    requestAnimationFrame(() => {
      if (token !== chainToken || !scroller) return;
      if (scroller.scrollHeight > scroller.clientHeight) return;
      step();
    });
  };
  step();
};

/**
 * Listen for reveal arrivals on the transcript scroller. `reveal` mounts one
 * batch and returns the remaining folded-turn count. Re-observing replaces
 * the previous listener and cancels its chain.
 */
export function observeGateAutoReveal(root, revealFn) {
  disconnectGateAutoReveal();
  if (!root || typeof revealFn !== "function") return;
  scroller = root;
  reveal = revealFn;
  root.addEventListener("scroll", onScroll, { passive: true });
}

/** Drop the listener and cancel any queued continuation. */
export function disconnectGateAutoReveal() {
  chainToken += 1;
  scroller?.removeEventListener("scroll", onScroll);
  scroller = null;
  reveal = null;
}
