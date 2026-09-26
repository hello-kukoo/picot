// @vitest-environment jsdom
// ABOUTME: Pins the sidebar drag handle contract: sibling placement, drag and
// ABOUTME: keyboard resizing, width persistence, clamping, and aria state.

import { beforeEach, describe, expect, it } from "vitest";
import { createSidebarResizer } from "./sidebar-resizer.js";

/**
 * jsdom has no layout, so the handle's width reads are stubbed. The stub
 * mirrors the real cascade (the panel's width IS the CSS variable the handle
 * writes), which is what makes consecutive drag/keyboard steps compound.
 */
function stubWidth(el, varName, fallback) {
  el.getBoundingClientRect = () => {
    const applied = Number.parseFloat(el.style.getPropertyValue(varName));
    const width = Number.isFinite(applied) ? applied : fallback;
    return { width, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
}

function setViewportWidth(width) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function makeSidebar(className = "file-sidebar", width = 360) {
  const sidebar = document.createElement("div");
  sidebar.className = className;
  document.body.appendChild(sidebar);
  stubWidth(sidebar, className === "sidebar" ? "--sidebar-width" : "--file-sidebar-width", width);
  return sidebar;
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  setViewportWidth(1400);
});

describe("createSidebarResizer", () => {
  it("re-reads a function maxWidth so the cap can follow the window and siblings", () => {
    const sidebar = makeSidebar();
    let budget = 500;
    const controller = createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-dynamic-max",
      minWidth: 200,
      maxWidth: () => budget,
    });
    const handle = document.querySelector(".sidebar-resizer");
    expect(handle.getAttribute("aria-valuemax")).toBe("500");

    // A narrower budget clamps the very next write and re-labels the handle.
    budget = 300;
    expect(controller.setWidth(480)).toBe(300);
    expect(handle.getAttribute("aria-valuemax")).toBe("300");

    // A shrinking window re-clamps an already-stored width instead of
    // overflowing the row: the stored 300 must come down with the budget.
    budget = 220;
    setViewportWidth(900);
    window.dispatchEvent(new Event("resize"));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("220px");
    expect(localStorage.getItem("test-dynamic-max")).toBe("220");
    controller.destroy();
  });

  it("never applies a minimum above the current maximum", () => {
    const sidebar = makeSidebar();
    const controller = createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-tight-budget",
      minWidth: 200,
      maxWidth: () => 150,
    });
    expect(controller.setWidth(400)).toBe(150);
    controller.destroy();
  });

  it("inserts a focusable separator on the requested side of the sidebar", () => {
    const sidebar = makeSidebar();
    const controller = createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-right",
      minWidth: 200,
      maxWidth: 500,
    });

    const handle = document.querySelector(".sidebar-resizer");
    expect(handle).not.toBeNull();
    expect(handle.previousElementSibling).toBeNull();
    expect(handle.nextElementSibling).toBe(sidebar);
    expect(handle.dataset.side).toBe("right");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuemin")).toBe("200");
    expect(handle.getAttribute("aria-valuemax")).toBe("500");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    expect(controller.element).toBe(handle);
  });

  it("resizes on drag and persists the final width exactly once", () => {
    const sidebar = makeSidebar();
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-drag",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");

    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 700, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 660, bubbles: true }));
    // A right-hand panel grows as the pointer moves left; nothing is persisted
    // mid-gesture, only when the drag settles.
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("400px");
    expect(localStorage.getItem("test-drag")).toBeNull();

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 660, bubbles: true }));
    expect(localStorage.getItem("test-drag")).toBe("400");
  });

  it("clamps the dragged width to the configured bounds", () => {
    const sidebar = makeSidebar();
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-clamp",
      minWidth: 300,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");

    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 700, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, bubbles: true }));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("500px");

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 1400, bubbles: true }));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("300px");
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 1400, bubbles: true }));
  });

  it("resizes with the arrow keys, using Shift for a larger step", () => {
    const sidebar = makeSidebar("sidebar", 240);
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "left",
      storageKey: "test-keys",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");

    // A left sidebar grows when the pointer/arrow moves towards the content.
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("252px");
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
    );
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("284px");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("272px");
    expect(localStorage.getItem("test-keys")).toBe("272");
    expect(handle.getAttribute("aria-valuenow")).toBe("272");
  });

  it("inverts the arrow direction for a right-hand panel", () => {
    const sidebar = makeSidebar();
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-keys-right",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("348px");
  });

  it("restores the stored width and ignores unrelated keys", () => {
    localStorage.setItem("test-stored", "420");
    const sidebar = makeSidebar();
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-stored",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("420px");

    const before = sidebar.style.getPropertyValue("--file-sidebar-width");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe(before);
  });

  it("hides the handle in the mobile slide-over layout and removes it on destroy", () => {
    setViewportWidth(600);
    const sidebar = makeSidebar();
    const controller = createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-mobile",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");
    expect(handle.style.display).toBe("none");

    setViewportWidth(1400);
    window.dispatchEvent(new Event("resize"));
    expect(handle.style.display).toBe("");

    controller.destroy();
    expect(document.querySelector(".sidebar-resizer")).toBeNull();
  });

  it("never starts a drag from a non-primary button", () => {
    const sidebar = makeSidebar();
    createSidebarResizer({
      sidebarEl: sidebar,
      side: "right",
      storageKey: "test-button",
      minWidth: 200,
      maxWidth: 500,
    });
    const handle = document.querySelector(".sidebar-resizer");

    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 700, button: 2, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 600, bubbles: true }));
    expect(sidebar.style.getPropertyValue("--file-sidebar-width")).toBe("360px");
  });
});
