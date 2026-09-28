/**
 * Reusable drag-handle between a sidebar and the main content area.
 *
 * Behavior:
 * - Creates a thin vertical handle element next to `sidebarEl`.
 * - Drag updates a CSS custom property on the sidebar element so layout follows.
 * - Persists final width to localStorage under `storageKey`.
 * - Hidden on screens <= 768px (mobile slide-over mode).
 *
 * Required config:
 *   sidebarEl   Element the handle sits next to (must be in the DOM).
 *   side        "left" | "right" — affects which CSS variable is updated.
 *   storageKey  Unique localStorage key for this sidebar's width.
 *
 * Optional config:
 *   minWidth             Default 180.
 *   maxWidth             Default 500; may be a function, re-read on every clamp
 *                        and on viewport resize so a panel can never starve the
 *                        chat column (the app derives it from --chat-min).
 *   cssVar               Override the CSS variable name (defaults: --sidebar-width or --file-sidebar-width).
 *   initialWidth         Override initial width (defaults: persisted value, then sidebarEl offset).
 *
 * The handle is a focusable separator: ArrowLeft/ArrowRight resize it
 * (Shift for a larger step) and aria-valuenow tracks the live width, so the
 * same element serves pointer and keyboard users.
 */

const MOBILE_MAX_WIDTH = 768;
const DEFAULT_MIN = 180;
const DEFAULT_MAX = 500;
const ARROW_STEP = 12;
const SHIFT_ARROW_STEP = 32;

function resolveWidth(el) {
  if (!el) return 0;
  const rect = el.getBoundingClientRect?.();
  if (rect?.width) return rect.width;
  return el.offsetWidth || 0;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * The main left sidebar's resize contract: one width key and bounds shared by
 * the landing page and the workspace page, so a sidebar widened on either
 * stays that width on both.
 */
export function createMainSidebarResizer(sidebarEl, { maxWidth = 500 } = {}) {
  return createSidebarResizer({
    sidebarEl,
    side: "left",
    storageKey: "picot-sidebar-width",
    minWidth: 200,
    maxWidth,
  });
}

export function createSidebarResizer({
  sidebarEl,
  side,
  storageKey,
  minWidth = DEFAULT_MIN,
  maxWidth = DEFAULT_MAX,
  cssVar,
  initialWidth,
}) {
  if (!sidebarEl || !storageKey) return null;
  if (side !== "left" && side !== "right") {
    throw new Error(`createSidebarResizer: side must be "left" or "right", got "${side}"`);
  }

  const variableName = cssVar || (side === "left" ? "--sidebar-width" : "--file-sidebar-width");
  const resolveMax = () => {
    const value = typeof maxWidth === "function" ? maxWidth() : maxWidth;
    return Number.isFinite(value) ? value : DEFAULT_MAX;
  };

  const handle = document.createElement("div");
  handle.className = "sidebar-resizer";
  handle.dataset.side = side;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.tabIndex = 0;
  handle.setAttribute("aria-valuemin", String(minWidth));
  handle.setAttribute("aria-valuemax", String(resolveMax()));
  const siblingMethod = side === "left" ? "afterend" : "beforebegin";
  sidebarEl.insertAdjacentElement(siblingMethod, handle);

  let dragging = false;
  let startCursorX = 0;
  let startWidth = 0;

  const applyWidth = (width) => {
    const max = resolveMax();
    const clamped = clamp(width, Math.min(minWidth, max), max);
    sidebarEl.style.setProperty(variableName, `${clamped}px`);
    handle.setAttribute("aria-valuenow", String(Math.round(clamped)));
    handle.setAttribute("aria-valuemax", String(Math.round(max)));
    return clamped;
  };

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  const persist = (width) => {
    try {
      localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      /* localStorage may be unavailable; failure is non-fatal */
    }
  };

  const onMouseMove = (event) => {
    if (!dragging) return;
    const delta = event.clientX - startCursorX;
    const next = side === "left" ? startWidth + delta : startWidth - delta;
    applyWidth(next);
    event.preventDefault();
  };

  const onMouseUp = (event) => {
    if (!dragging) return;
    const delta = event.clientX - startCursorX;
    const next = side === "left" ? startWidth + delta : startWidth - delta;
    const finalWidth = applyWidth(next);
    persist(finalWidth);
    stopDrag();
  };

  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (window.innerWidth <= MOBILE_MAX_WIDTH) return;
    dragging = true;
    startCursorX = event.clientX;
    startWidth = resolveWidth(sidebarEl);
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    event.preventDefault();
  });

  const onKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const step = event.shiftKey ? SHIFT_ARROW_STEP : ARROW_STEP;
    // ArrowRight always means "towards the content": wider for a left
    // sidebar, narrower for a right-hand panel whose handle is on its left.
    const towardsContent = event.key === "ArrowRight";
    const direction = side === "left" ? 1 : -1;
    const delta = direction * (towardsContent ? step : -step);
    event.preventDefault();
    persist(applyWidth(resolveWidth(sidebarEl) + delta));
  };
  handle.addEventListener("keydown", onKeyDown);

  const syncForViewport = () => {
    if (window.innerWidth <= MOBILE_MAX_WIDTH) {
      // Mobile turns the sidebar into a fixed slide-over (width: 80%), so the
      // stored px width is out of the picture until the desktop layout returns.
      handle.style.display = "none";
      return;
    }
    handle.style.display = "";
    // A shrinking window can invalidate a stored width that used to fit: re-clamp
    // it so the chat column keeps its minimum instead of the row overflowing.
    const current = resolveWidth(sidebarEl);
    if (current > resolveMax()) persist(applyWidth(current));
  };

  window.addEventListener("resize", syncForViewport);
  syncForViewport();

  // Initialize the sidebar width from `initialWidth`, localStorage, or current DOM width.
  if (typeof initialWidth === "number" && !Number.isNaN(initialWidth)) {
    applyWidth(initialWidth);
  } else {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) {
        const parsed = Number.parseFloat(stored);
        if (!Number.isNaN(parsed)) {
          applyWidth(parsed);
        } else {
          applyWidth(resolveWidth(sidebarEl));
        }
      } else {
        applyWidth(resolveWidth(sidebarEl));
      }
    } catch {
      applyWidth(resolveWidth(sidebarEl));
    }
  }

  return {
    element: handle,
    get width() {
      return resolveWidth(sidebarEl);
    },
    setWidth(width) {
      const applied = applyWidth(width);
      persist(applied);
      return applied;
    },
    destroy() {
      window.removeEventListener("resize", syncForViewport);
      handle.removeEventListener("keydown", onKeyDown);
      stopDrag();
      handle.remove();
    },
  };
}
