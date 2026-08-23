// ABOUTME: Renders `ctx.ui.setWidget()` content from extensions around the composer.
// ABOUTME: Generic fallback for widgets Picot has no purpose-built native mirror for.

// pi's RPC mode forwards `setWidget` as plain pre-rendered terminal lines
// (`widgetLines`), keyed by `widgetKey`, with an `aboveEditor` / `belowEditor`
// placement. Passing `undefined` lines removes the widget. Without a renderer
// every extension that publishes a status panel this way is silently dropped,
// so this module is the catch-all; extensions Picot mirrors natively (rpiv-todo)
// opt out before reaching here.

const PLACEMENTS = new Set(["aboveEditor", "belowEditor"]);
const DEFAULT_PLACEMENT = "belowEditor";
// Widget lines carry SGR colour for a terminal. Picot styles them with its own
// theme instead, so the codes are stripped rather than parsed.
const SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripAnsi(text) {
  return String(text ?? "").replace(SGR_PATTERN, "");
}

export class ExtensionWidgets {
  #widgets = new Map();
  #containers;

  /**
   * @param {{ aboveEditor: HTMLElement|null, belowEditor: HTMLElement|null }} containers
   */
  constructor(containers) {
    this.#containers = containers;
  }

  /** Apply one `setWidget` extension-UI request. */
  apply(request) {
    const key = request?.widgetKey;
    if (typeof key !== "string" || !key) return;
    const lines = request.widgetLines;
    if (!Array.isArray(lines) || lines.length === 0) {
      this.#widgets.delete(key);
    } else {
      const placement = PLACEMENTS.has(request.widgetPlacement)
        ? request.widgetPlacement
        : DEFAULT_PLACEMENT;
      this.#widgets.set(key, { placement, lines });
    }
    this.render();
  }

  /** Drop every widget, e.g. when switching sessions. */
  clear() {
    if (this.#widgets.size === 0) return;
    this.#widgets.clear();
    this.render();
  }

  render() {
    for (const placement of PLACEMENTS) {
      const container = this.#containers[placement];
      if (!container) continue;
      container.textContent = "";
      let count = 0;
      // Map iteration order is insertion order, which keeps a widget from
      // jumping around as unrelated widgets update.
      for (const [key, widget] of this.#widgets) {
        if (widget.placement !== placement) continue;
        container.appendChild(createWidgetElement(key, widget.lines));
        count += 1;
      }
      container.classList.toggle("hidden", count === 0);
    }
  }
}

function createWidgetElement(key, lines) {
  const element = document.createElement("div");
  element.className = "extension-widget";
  element.dataset.widgetKey = key;
  // textContent, never innerHTML: widget lines are extension-controlled.
  element.textContent = lines.map(stripAnsi).join("\n");
  return element;
}
