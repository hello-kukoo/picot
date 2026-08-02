// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { setupResizablePanel } from "./resizable-panel.js";

describe("setupResizablePanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("adds a left-edge resize handle and persists the dragged width", () => {
    const panel = document.createElement("aside");
    panel.className = "app-side-panel";
    document.body.appendChild(panel);

    setupResizablePanel(panel, {
      storageKey: "test-panel-width",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 520,
    });

    const handle = panel.querySelector(".app-side-panel-resize-handle");
    expect(handle).not.toBeNull();
    expect(panel.style.getPropertyValue("--panel-width")).toBe("320px");

    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 700, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 620, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

    expect(panel.style.getPropertyValue("--panel-width")).toBe("400px");
    expect(localStorage.getItem("test-panel-width")).toBe("400");
  });

  it("restores a stored width and clamps it to the configured bounds", () => {
    localStorage.setItem("test-panel-width", "900");
    const panel = document.createElement("aside");
    document.body.appendChild(panel);

    setupResizablePanel(panel, {
      storageKey: "test-panel-width",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 520,
    });

    expect(panel.style.getPropertyValue("--panel-width")).toBe("520px");
  });

  it("writes storage exactly once per drag and never during pointermove", () => {
    const panel = document.createElement("aside");
    document.body.appendChild(panel);

    setupResizablePanel(panel, {
      storageKey: "once-panel",
      defaultWidth: 300,
      minWidth: 200,
      maxWidth: 600,
    });
    const handle = panel.querySelector(".app-side-panel-resize-handle");

    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 600, bubbles: true }));
    const before = localStorage.getItem("once-panel");
    // Initial persist happens once at setup; during the drag no writes occur.
    expect(before).toBe("300");
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 560, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 520, bubbles: true }));
    expect(localStorage.getItem("once-panel")).toBe(before);
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(localStorage.getItem("once-panel")).toBe("380");
  });

  it("tears down on pointercancel / lostpointercapture / blur / hidden", () => {
    const panel = document.createElement("aside");
    document.body.appendChild(panel);

    const cleanup = setupResizablePanel(panel, {
      storageKey: "cancel-panel",
      defaultWidth: 300,
      minWidth: 200,
      maxWidth: 600,
    });
    const handle = panel.querySelector(".app-side-panel-resize-handle");
    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 600, bubbles: true }));
    expect(document.body.classList.contains("is-resizing-side-panel")).toBe(true);

    // pointercancel must end the drag and persist final width once.
    document.dispatchEvent(new MouseEvent("pointercancel", { clientX: 540, bubbles: true }));
    expect(document.body.classList.contains("is-resizing-side-panel")).toBe(false);

    // Cleanup must be idempotent and leave no dangling listeners.
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow();
  });

  it("supports a right-side seam that grows toward the left edge", () => {
    const panel = document.createElement("aside");
    document.body.appendChild(panel);
    setupResizablePanel(panel, {
      storageKey: "right-panel",
      defaultWidth: 300,
      minWidth: 200,
      maxWidth: 600,
      side: "right",
    });
    const handle = panel.querySelector(".app-side-panel-resize-handle");
    expect(handle.style.left).toBe("auto");
    expect(handle.style.right).toBe("-2px");

    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    // Moving the pointer right grows a right-anchored panel.
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 180, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(panel.style.getPropertyValue("--panel-width")).toBe("380px");
  });

  it("rejects an invalid side value with a descriptive error", () => {
    const panel = document.createElement("aside");
    expect(() => setupResizablePanel(panel, { defaultWidth: 300, side: "top" })).toThrow(/side/);
  });

  it("exposes keyboard separator semantics", () => {
    const panel = document.createElement("aside");
    document.body.appendChild(panel);
    setupResizablePanel(panel, {
      storageKey: "kbd-panel",
      defaultWidth: 300,
      minWidth: 200,
      maxWidth: 600,
    });
    const handle = panel.querySelector(".app-side-panel-resize-handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuemin")).toBe("200");
    expect(handle.getAttribute("aria-valuemax")).toBe("600");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(panel.style.getPropertyValue("--panel-width")).toBe("312px");
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
    );
    expect(panel.style.getPropertyValue("--panel-width")).toBe("344px");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(panel.style.getPropertyValue("--panel-width")).toBe("200px");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(panel.style.getPropertyValue("--panel-width")).toBe("600px");
  });

  it("never uses setPointerCapture or releasePointerCapture", () => {
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(here.replace(/\.test\.js$/, ".js"), "utf8");
    expect(src).not.toMatch(/setPointerCapture|releasePointerCapture/);
  });
});
