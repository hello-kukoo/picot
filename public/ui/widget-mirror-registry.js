// ABOUTME: Routes Pi setWidget/tool output to runtime-owned native mirror panels.
// ABOUTME: Keeps ambient widget panels isolated by runtime and tolerant of bad payloads.

const DEFAULT_PLACEMENT = "aboveEditor";
const VALID_PLACEMENTS = new Set(["aboveEditor", "belowEditor"]);

export function runtimeIdForTarget(target) {
  if (!target || typeof target !== "object") return null;
  const { workspaceId, sessionId, instanceId } = target;
  if (typeof workspaceId !== "string" || typeof sessionId !== "string") return null;
  return [workspaceId, sessionId, typeof instanceId === "string" ? instanceId : "primary"].join(
    "\u0000",
  );
}

class DefaultTextPanel {
  constructor({ widgetKey, container, placement }) {
    this.widgetKey = widgetKey;
    this.element = document.createElement("section");
    this.element.className = "widget-mirror-panel";
    this.element.dataset.widgetKey = widgetKey;
    const title = document.createElement("div");
    title.className = "widget-mirror-panel__title";
    title.textContent = widgetKey;
    this.body = document.createElement("pre");
    this.body.className = "widget-mirror-panel__body";
    this.setLines([]);
    this.setPlacement(container, placement);
    this.title = title;
    this.element.replaceChildren(title, this.body);
  }

  setPlacement(container, placement) {
    const form = container?.querySelector("form");
    if (!container || !form) return;
    if (placement === "belowEditor") form.insertAdjacentElement("afterend", this.element);
    else form.insertAdjacentElement("beforebegin", this.element);
  }

  setLines(lines) {
    this.body.textContent = lines.join("\n");
    this.element.classList.toggle("hidden", lines.length === 0);
  }
}

export class WidgetMirrorRegistry {
  #container;
  #renderers = new Map();
  #panels = new Map();
  #activeRuntimeId = null;

  constructor({ container } = {}) {
    this.#container = container;
  }

  registerRenderer(config) {
    if (!config || typeof config.widgetKey !== "string" || !config.widgetKey) {
      throw new TypeError("widgetKey is required");
    }
    if (typeof config.createPanel !== "function") throw new TypeError("createPanel is required");
    this.#renderers.set(config.widgetKey, {
      ...config,
      toolNames: new Set(config.toolNames || []),
    });
    return () => this.#renderers.delete(config.widgetKey);
  }

  handleWidgetRequest(request, runtimeId = request?.__runtimeId ?? this.#activeRuntimeId) {
    if (request?.method !== "setWidget" || typeof request.widgetKey !== "string") return false;
    const widgetKey = request.widgetKey.trim();
    if (!widgetKey) return false;
    if (request.widgetLines !== undefined && !isStringArray(request.widgetLines)) return false;
    const placement = VALID_PLACEMENTS.has(request.widgetPlacement)
      ? request.widgetPlacement
      : DEFAULT_PLACEMENT;
    const key = panelKey(widgetKey, runtimeId);

    if (request.widgetLines === undefined) {
      this.#removePanel(key);
      return true;
    }

    const renderer = this.#renderers.get(widgetKey);
    if (!renderer) {
      let panel = this.#panels.get(key)?.panel;
      if (!panel) {
        panel = new DefaultTextPanel({
          widgetKey,
          container: this.#container,
          placement,
        });
        this.#panels.set(key, { panel, renderer: null, runtimeId, widgetKey });
      }
      panel.setLines(request.widgetLines);
      this.#setVisible(this.#panels.get(key));
      return true;
    }

    // A registered renderer owns its own state; setWidget is still recorded as
    // a runtime heartbeat, but only the renderer-specific tool result changes it.
    this.#ensureRegisteredPanel(renderer, runtimeId, placement);
    return true;
  }

  handleToolResult(toolName, result, runtimeId = this.#activeRuntimeId) {
    if (typeof toolName !== "string") return false;
    let handled = false;
    for (const renderer of this.#renderers.values()) {
      if (!renderer.toolNames.has(toolName)) continue;
      const entry = this.#ensureRegisteredPanel(renderer, runtimeId, DEFAULT_PLACEMENT);
      if (typeof entry.panel.applyToolResult === "function") {
        handled = entry.panel.applyToolResult(result) || handled;
      }
    }
    return handled;
  }

  handleCommandNotify(message, runtimeId = this.#activeRuntimeId) {
    let suppressed = false;
    for (const renderer of this.#renderers.values()) {
      if (typeof renderer.matchesNotify !== "function" || !renderer.matchesNotify(message))
        continue;
      const entry = this.#panels.get(panelKey(renderer.widgetKey, runtimeId));
      if (entry?.panel?.hasVisibleTasks) suppressed = true;
    }
    return suppressed;
  }

  handleRuntimeChange(runtimeId) {
    this.#activeRuntimeId = runtimeId ?? null;
    for (const entry of this.#panels.values()) this.#setVisible(entry);
  }

  handleSessionSwitch(messages = []) {
    for (const renderer of this.#renderers.values()) {
      if (!renderer.replay || this.#activeRuntimeId === null) continue;
      const activeKey = panelKey(renderer.widgetKey, this.#activeRuntimeId);
      this.#panels.get(activeKey)?.panel.clear?.();
    }
    this.replay(messages);
  }

  replay(messages = []) {
    for (const renderer of this.#renderers.values()) {
      if (!renderer.replay || this.#activeRuntimeId === null) continue;
      const entry = this.#ensureRegisteredPanel(renderer, this.#activeRuntimeId, DEFAULT_PLACEMENT);
      const safeMessages = Array.isArray(messages) ? messages : [];
      if (typeof renderer.replay === "function") renderer.replay(entry.panel, safeMessages);
      else entry.panel.hydrateFromMessages?.(safeMessages);
    }
  }

  getPanel(widgetKey, runtimeId = this.#activeRuntimeId) {
    return this.#panels.get(panelKey(widgetKey, runtimeId))?.panel || null;
  }

  #ensureRegisteredPanel(renderer, runtimeId, placement) {
    const key = panelKey(renderer.widgetKey, runtimeId);
    let entry = this.#panels.get(key);
    if (!entry) {
      const panel = renderer.createPanel({
        container: this.#container,
        widgetPlacement: placement,
        runtimeId,
      });
      if (!panel?.element) throw new TypeError(`Renderer ${renderer.widgetKey} returned no panel`);
      placePanel(panel.element, this.#container, placement);
      entry = { panel, renderer, runtimeId, widgetKey: renderer.widgetKey };
      this.#panels.set(key, entry);
    }
    this.#setVisible(entry);
    return entry;
  }

  #removePanel(key) {
    const entry = this.#panels.get(key);
    if (!entry) return;
    entry.panel.destroy?.();
    entry.panel.element?.remove();
    this.#panels.delete(key);
  }

  #setVisible(entry) {
    const element = entry?.panel?.element;
    if (!element) return;
    element.classList.toggle(
      "widget-mirror-runtime-hidden",
      entry.runtimeId !== this.#activeRuntimeId,
    );
  }
}

export function createWidgetMirrorRegistry(options) {
  return new WidgetMirrorRegistry(options);
}

function panelKey(widgetKey, runtimeId) {
  return `${widgetKey}\u0000${runtimeId ?? ""}`;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function placePanel(element, container, placement) {
  if (!element || element.parentElement || !container) return;
  const form = container.querySelector("form");
  if (!form) return;
  if (placement === "belowEditor") form.insertAdjacentElement("afterend", element);
  else form.insertAdjacentElement("beforebegin", element);
}
