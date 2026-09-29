// ABOUTME: Keeps the composer toolbar inside its card as the chat column narrows.
// ABOUTME: Raises a fit level only when the row actually overflows, so controls
// ABOUTME: disappear on measured need instead of a fixed viewport breakpoint.

/**
 * Cumulative degradation levels. Level N applies every class from 0..N.
 * Order is by dispensability, mirroring what the user asked to keep longest:
 * the aggregate cluster, then the toolbox, then the mic, then the model label's
 * width. Attach, donut, model, thinking, queue and send are never hidden — at
 * the tightest level the row still fits them.
 */
export const COMPOSER_FIT_LEVELS = [
  [],
  ["composer-fit--hide-usage"],
  ["composer-fit--hide-toolbox"],
  ["composer-fit--hide-mic"],
  ["composer-fit--shrink-model"],
];

export const COMPOSER_FIT_MAX_LEVEL = COMPOSER_FIT_LEVELS.length - 1;

/** Slack kept when stepping back down, so the row does not flap at a boundary. */
const RELEASE_SLACK_PX = 8;

export function composerFitClasses(level) {
  const classes = new Set();
  for (let i = 0; i <= level; i++) {
    for (const name of COMPOSER_FIT_LEVELS[i]) classes.add(name);
  }
  return classes;
}

/**
 * Stepper core, free of DOM measurement so it stays unit-testable.
 *
 * `overflowPx(level)` applies the level's classes and returns how far the row
 * overflows (negative = spare room). It starts from the level already applied,
 * so a steady row costs one measurement per resize tick; only a genuine change
 * walks further (each step is one measurement).
 *
 * @param {{current:number, overflowPx:(level:number)=>number}} input
 * @returns {number} the level to keep
 */
export function nextComposerFitLevel({ current, overflowPx }) {
  let level = Math.min(Math.max(0, Math.round(current) || 0), COMPOSER_FIT_MAX_LEVEL);
  let overflow = overflowPx(level);
  while (overflow > 0 && level < COMPOSER_FIT_MAX_LEVEL) {
    level += 1;
    overflow = overflowPx(level);
  }
  // Release as far as the slack allows in this same call: the observer only
  // fires on a size change, so a stalled release would never get a second tick.
  // The 8px margin keeps a row sitting on a boundary from oscillating.
  while (level > 0 && overflowPx(level - 1) <= -RELEASE_SLACK_PX) level -= 1;
  return level;
}

/**
 * Wire the stepper to a live composer.
 *
 * @param {{card:HTMLElement, toolbar:HTMLElement, view?:Window, onLevel?:(level:number)=>void}} deps
 * @returns {{destroy:()=>void, level:number, sync:()=>void}}
 */
export function setupComposerFit({ card, toolbar, view = globalThis, onLevel = null }) {
  const inert = { destroy: () => {}, level: 0, sync: () => {} };
  if (!card || !toolbar) return inert;
  let level = 0;
  let lastWidth = -1;

  const applyLevel = (next) => {
    const wanted = composerFitClasses(next);
    for (const name of composerFitClasses(COMPOSER_FIT_MAX_LEVEL)) {
      if (!wanted.has(name)) card.classList.remove(name);
    }
    for (const name of wanted) card.classList.add(name);
    level = next;
    onLevel?.(next);
  };

  /**
   * Required width minus available width; negative means spare room.
   *
   * Deliberately not `scrollWidth - clientWidth`: scrollWidth is never less
   * than clientWidth, so that probe reported 0 at best and the release step
   * could never fire (the row ratcheted up and stayed there). Summing the
   * controls' own widths is symmetric — it goes negative once there is room.
   */
  const requiredWidth = () => {
    const win = toolbar.ownerDocument?.defaultView ?? globalThis;
    const gapOf = (el) => Number.parseFloat(win.getComputedStyle?.(el)?.columnGap) || 0;
    const groups = [...toolbar.children];
    let total = gapOf(toolbar) * Math.max(0, groups.length - 1);
    for (const group of groups) {
      const items = [...group.children];
      total += items.reduce((sum, el) => sum + el.offsetWidth, 0);
      total += gapOf(group) * Math.max(0, items.length - 1);
    }
    return total;
  };

  const measure = (candidate) => {
    applyLevel(candidate);
    const available = toolbar.clientWidth;
    // Layout not ready (hidden panel, boot): report "fits" instead of pinning
    // the tightest level from a zero-width measurement.
    if (available <= 0) return -1;
    return requiredWidth() - available;
  };

  /** Recompute now. A caller-invoked sync must take effect immediately. */
  const sync = () => {
    // Guard on the row's own available width — the input the decision actually
    // depends on. The card's width can stay identical while this one moves.
    const available = toolbar.clientWidth;
    if (available === lastWidth) return;
    lastWidth = available;
    applyLevel(nextComposerFitLevel({ current: level, overflowPx: measure }));
  };

  /** Coalesce observer storms (a drag fires per frame) into one recompute. */
  // Applied synchronously: ResizeObserver callbacks run before paint, so the
  // row is already at the right level for the frame that shows the new width.
  // That is what lets the toolbar stay unclipped (a clip would eat the model
  // dropdown, which opens upward out of this row).
  const schedule = () => sync();

  applyLevel(0);
  sync();
  const observer =
    typeof view.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
  observer?.observe(card);
  view.addEventListener?.("resize", schedule);

  return {
    destroy() {
      observer?.disconnect();
      view.removeEventListener?.("resize", schedule);
    },
    get level() {
      return level;
    },
    sync,
  };
}
