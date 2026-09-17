import { beforeEach, describe, expect, it } from "vitest";
import { setMessages } from "../i18n.js";
import { RpivTodoMirrorPanel } from "./rpiv-todo-mirror.js";
import { createWidgetMirrorRegistry, runtimeIdForTarget } from "./widget-mirror-registry.js";

const runtimeA = "w\u0000s-a\u0000primary";
const runtimeB = "w\u0000s-b\u0000primary";

describe("widget mirror registry", () => {
  beforeEach(() => {
    setMessages({
      todoMirror: {
        title: { todos: "Todos" },
        showAll: "Show all {count} more",
        collapse: "Collapse",
        clear: "Clear",
      },
    });
    document.body.innerHTML = '<div class="input-area"><form></form></div>';
  });

  it("derives stable runtime ids and lazily renders unknown widgets", () => {
    expect(runtimeIdForTarget({ workspaceId: "w", sessionId: "s" })).toBe("w\u0000s\u0000primary");
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    expect(
      registry.handleWidgetRequest(
        { method: "setWidget", widgetKey: "fleet", widgetLines: ["ready"] },
        runtimeA,
      ),
    ).toBe(true);
    expect(document.querySelector("[data-widget-key=fleet]").textContent).toContain("ready");
  });

  it("removes default panels when widgetLines is undefined", () => {
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    registry.handleWidgetRequest(
      { method: "setWidget", widgetKey: "fleet", widgetLines: ["ready"] },
      runtimeA,
    );
    registry.handleWidgetRequest(
      { method: "setWidget", widgetKey: "fleet", widgetLines: undefined },
      runtimeA,
    );
    expect(document.querySelector("[data-widget-key=fleet]")).toBeNull();
  });

  it("hides and restores panels by runtime", () => {
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    registry.handleWidgetRequest(
      { method: "setWidget", widgetKey: "a", widgetLines: ["A"] },
      runtimeA,
    );
    registry.handleWidgetRequest(
      { method: "setWidget", widgetKey: "b", widgetLines: ["B"] },
      runtimeB,
    );
    registry.handleRuntimeChange(runtimeA);
    expect(
      document
        .querySelector('[data-widget-key="a"]')
        .classList.contains("widget-mirror-runtime-hidden"),
    ).toBe(false);
    expect(
      document
        .querySelector('[data-widget-key="b"]')
        .classList.contains("widget-mirror-runtime-hidden"),
    ).toBe(true);
    registry.handleRuntimeChange(runtimeB);
    expect(
      document
        .querySelector('[data-widget-key="a"]')
        .classList.contains("widget-mirror-runtime-hidden"),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-widget-key="b"]')
        .classList.contains("widget-mirror-runtime-hidden"),
    ).toBe(false);
  });

  it("hydrates registered renderers on session switch", () => {
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    registry.registerRenderer({
      widgetKey: "rpiv-todos",
      toolNames: ["todo"],
      replay: true,
      createPanel: ({ container }) => new RpivTodoMirrorPanel({ container }),
    });
    registry.handleRuntimeChange(runtimeA);
    registry.handleToolResult(
      "todo",
      { details: { tasks: [{ id: 1, subject: "A", status: "pending" }], nextId: 2 } },
      runtimeA,
    );
    registry.handleSessionSwitch([
      {
        role: "toolResult",
        toolName: "todo",
        details: { tasks: [{ id: 2, subject: "B", status: "pending" }], nextId: 3 },
      },
    ]);
    expect(document.querySelector(".rpiv-todo-panel").textContent).toContain("B");
  });
});
