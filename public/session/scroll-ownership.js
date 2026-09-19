// ABOUTME: Scroll ownership for the chat viewport — did the page scroll, or
// ABOUTME: did the user? One authority replaces the renderers' 100px boolean.

/**
 * Create the scroll owner for a scroll container.
 *
 * The defect this removes: a single `isNearBottom` boolean recomputed on every
 * scroll event cannot distinguish a scroll the page caused (content growth,
 * programmatic follow) from one the user caused (wheel, touch, keys, scrollbar
 * drag) — so smooth-scroll settling and markdown re-layout could re-arm
 * auto-follow while the user was reading history.
 *
 * Rules (spec P3):
 * 1. A scroll event matching a recorded programmatic target within
 *    `tolerancePx` inside `ttlMs` is self-caused and never changes follow
 *    state; a mismatch only clears the recorded target.
 * 2. Only user-intent inputs (wheel / touchstart / keydown on the container,
 *    pointerdown on the scrollbar) arm the "user-caused" window. A bare
 *    scroll event never suspends following.
 * 3. Programmatic writes pin `scroll-behavior: auto` for the duration of the
 *    write so the recorded target is reached deterministically; smooth
 *    scrolling is reserved for user-initiated jumps.
 * 4. Content growth above the viewport changes nothing.
 * 5. Follow re-arms explicitly: distance-to-bottom under `thresholdPx` on a
 *    user-caused scroll, or the scroll-to-bottom control (`followBottom`).
 */
export function createScrollOwner({
  container,
  thresholdPx = 100,
  tolerancePx = 2,
  ttlMs = 600,
  now = () => Date.now(),
} = {}) {
  if (!container) throw new Error("createScrollOwner requires a container element");
  let following = true;
  let programmatic = null; // { target, at }
  let userIntentAt = Number.NEGATIVE_INFINITY; // no user intent has occurred

  const distanceToBottom = () =>
    container.scrollHeight - container.scrollTop - container.clientHeight;

  const matchesProgrammatic = (top, at) =>
    Boolean(programmatic) &&
    Math.abs(top - programmatic.target) <= tolerancePx &&
    at - programmatic.at <= ttlMs;

  const noteProgrammaticTarget = (target) => {
    programmatic = {
      target: Math.max(0, typeof target === "number" ? target : container.scrollHeight),
      at: now(),
    };
  };

  function handleScroll() {
    const at = now();
    const top = container.scrollTop;
    if (programmatic && matchesProgrammatic(top, at)) {
      programmatic = null; // self-caused: consumed, no state change
      return;
    }
    if (programmatic) programmatic = null; // diverged: clear the token only
    if (at - userIntentAt <= ttlMs) {
      following = distanceToBottom() < thresholdPx;
    }
    // Otherwise: no user intent — content growth, momentum, or settling.
  }

  const onUserIntentInput = () => {
    userIntentAt = now();
  };

  // A pointerdown on the container element itself (not its content) is the
  // scrollbar-drag approximation: browsers do not expose the scrollbar.
  const onPointerDown = (event) => {
    if (event.target === container) onUserIntentInput();
  };

  container.addEventListener("scroll", handleScroll);
  container.addEventListener("wheel", onUserIntentInput, { passive: true });
  container.addEventListener("touchstart", onUserIntentInput, { passive: true });
  container.addEventListener("keydown", onUserIntentInput);
  container.addEventListener("pointerdown", onPointerDown);

  return {
    /** Record a page-initiated scroll target (call immediately BEFORE the write). */
    noteProgrammatic(target) {
      noteProgrammaticTarget(target);
    },

    /** True only for input-initiated scrolls (spec rule 2). */
    isUserScrollEvent() {
      const at = now();
      return (
        at - userIntentAt <= ttlMs &&
        !(programmatic && matchesProgrammatic(container.scrollTop, at))
      );
    },

    /** Should new content follow the bottom? */
    isFollowing: () => following,

    /** Register a user-intent callback (wheel / touch / key / scrollbar). */
    onUserIntent(fn) {
      if (typeof fn === "function") {
        container.addEventListener("wheel", fn, { passive: true });
        container.addEventListener("touchstart", fn, { passive: true });
      }
      return () => {
        container.removeEventListener("wheel", fn);
        container.removeEventListener("touchstart", fn);
      };
    },

    /**
     * Follow-the-bottom write. No-op while following is suspended; returns
     * whether a scroll happened. Instant (behavior pinned to auto) because
     * this fires on every streaming update.
     */
    scrollToBottom() {
      if (!following) return false;
      const target = container.scrollHeight;
      noteProgrammaticTarget(target);
      const previousBehavior = container.style.scrollBehavior;
      container.style.scrollBehavior = "auto";
      container.scrollTop = target;
      container.style.scrollBehavior = previousBehavior;
      return true;
    },

    /** User-initiated jump: smooth, token-recorded, never changes follow state. */
    scrollTo(top, { smooth = true } = {}) {
      noteProgrammaticTarget(top);
      const previousBehavior = container.style.scrollBehavior;
      if (!smooth) container.style.scrollBehavior = "auto";
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      } else {
        // Engines without Element.scrollTo (test documents) still jump.
        container.scrollTop = top;
      }
      container.style.scrollBehavior = previousBehavior;
    },

    /**
     * The scroll-to-bottom control: re-arm following, then jump. This is the
     * user-initiated jump, so it animates (spec rule 3: smooth is reserved
     * for user-initiated jumps; content-follow stays instant).
     */
    followBottom() {
      following = true;
      this.scrollTo(container.scrollHeight, { smooth: true });
      return true;
    },

    destroy() {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", onUserIntentInput);
      container.removeEventListener("touchstart", onUserIntentInput);
      container.removeEventListener("keydown", onUserIntentInput);
      container.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
