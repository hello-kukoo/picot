const DEFAULT_MIN_WIDTH = 260;
const DEFAULT_MAX_WIDTH = 560;
const ARROW_STEP = 12;
const SHIFT_ARROW_STEP = 32;
const VALID_SIDES = new Set(["left", "right"]);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readStoredWidth(storageKey) {
  if (!storageKey) return null;
  const stored = Number.parseInt(localStorage.getItem(storageKey) || "", 10);
  return Number.isFinite(stored) ? stored : null;
}

/** Apply only the live CSS variable; never touch storage during a drag. */
function applyLiveWidth(panel, width) {
  panel.style.setProperty("--panel-width", `${Math.round(width)}px`);
}

/** Persist the final width exactly once at gesture completion. */
function persistPanelWidth(panel, storageKey) {
  if (!storageKey) return;
  const px = panel.style.getPropertyValue("--panel-width");
  if (px) localStorage.setItem(storageKey, String(Math.round(Number.parseFloat(px))));
}

export function setupResizablePanel(
  panel,
  {
    storageKey,
    defaultWidth,
    minWidth = DEFAULT_MIN_WIDTH,
    maxWidth = DEFAULT_MAX_WIDTH,
    side = "left",
  } = {},
) {
  if (!panel) return () => {};
  if (!VALID_SIDES.has(side)) {
    throw new Error(`Invalid resize side "${side}" — expected "left" or "right"`);
  }

  panel.classList.add("app-side-panel", "is-resizable");
  const initialWidth = clamp(readStoredWidth(storageKey) ?? defaultWidth, minWidth, maxWidth);

  const handle =
    panel.querySelector(".app-side-panel-resize-handle") || document.createElement("div");
  handle.className = "app-side-panel-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.tabIndex = 0;
  handle.setAttribute("aria-valuemin", String(minWidth));
  handle.setAttribute("aria-valuemax", String(maxWidth));
  handle.setAttribute("aria-valuenow", String(initialWidth));
  handle.setAttribute("title", "Resize panel");
  handle.style.left = side === "right" ? "auto" : "-2px";
  handle.style.right = side === "right" ? "-2px" : "auto";
  if (!handle.parentElement) panel.prepend(handle);

  // Initialise CSS + one-time initial persist.
  applyLiveWidth(panel, initialWidth);
  if (storageKey) localStorage.setItem(storageKey, String(Math.round(initialWidth)));

  let startX = 0;
  let startWidth = initialWidth;
  let dragging = false;
  const onPointerMove = (event) => {
    if (!dragging) return;
    const delta = side === "right" ? event.clientX - startX : startX - event.clientX;
    applyLiveWidth(panel, clamp(startWidth + delta, minWidth, maxWidth));
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("pointermove", onPointerMove);
    document.body.classList.remove("is-resizing-side-panel");
    persistPanelWidth(panel, storageKey);
    const now = Number.parseFloat(panel.style.getPropertyValue("--panel-width")) || initialWidth;
    handle.setAttribute("aria-valuenow", String(Math.round(now)));
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = Number.parseFloat(panel.style.getPropertyValue("--panel-width")) || initialWidth;
    dragging = true;
    document.body.classList.add("is-resizing-side-panel");
    document.addEventListener("pointermove", onPointerMove);
  };

  const onBlur = () => endDrag();
  const onVisibility = () => {
    if (document.hidden) endDrag();
  };

  handle.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  handle.addEventListener("keydown", (event) => {
    const current =
      Number.parseFloat(panel.style.getPropertyValue("--panel-width")) || initialWidth;
    let next = current;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        next = clamp(
          current + (event.shiftKey ? SHIFT_ARROW_STEP : ARROW_STEP),
          minWidth,
          maxWidth,
        );
        break;
      case "Home":
        next = minWidth;
        break;
      case "End":
        next = maxWidth;
        break;
      case "Enter":
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    applyLiveWidth(panel, next);
    handle.setAttribute("aria-valuenow", String(Math.round(next)));
    persistPanelWidth(panel, storageKey);
  });

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", endDrag);
    document.removeEventListener("lostpointercapture", endDrag);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    document.body.classList.remove("is-resizing-side-panel");
  };
}
