// ABOUTME: Toggles an `is-scrolling` class on the main-window scroll panes so
// ABOUTME: their thumb is drawn only while scrolling, then hidden again.
// ABOUTME: Scroll events do not bubble, so one capture listener on the document
// ABOUTME: covers panes that are created lazily by their panels.

/** Panes whose scrollbar thumb should appear only while scrolling. The list is
 * mirrored by the `:is(...)::-webkit-scrollbar` rules in public/style.css. */
export const SCROLL_AUTO_HIDE_SELECTOR =
  ".messages, .file-list, .git-subtab-pane, .git-history-section, .git-diff-columns.wrap-lines, .git-diff-column, .git-diff-fallback";

/** How long a pane keeps its thumb after the last scroll event. */
export const SCROLL_AUTO_HIDE_IDLE_MS = 900;

const idleTimers = new WeakMap();

/**
 * Show the thumb of every watched pane while it scrolls. Returns a teardown
 * that removes the listener and clears pending timers.
 */
export function setupScrollbarAutoHide(target = document) {
  const onScroll = (event) => {
    const pane = event.target;
    if (!(pane instanceof Element) || !pane.matches(SCROLL_AUTO_HIDE_SELECTOR)) return;
    pane.classList.add("is-scrolling");
    clearTimeout(idleTimers.get(pane));
    idleTimers.set(
      pane,
      setTimeout(() => pane.classList.remove("is-scrolling"), SCROLL_AUTO_HIDE_IDLE_MS),
    );
  };
  target.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => target.removeEventListener("scroll", onScroll, { capture: true });
}
