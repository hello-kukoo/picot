// @vitest-environment jsdom
// ABOUTME: Pins the composer Commands menu as a non-modal popover anchored to its
// ABOUTME: button: left edge on the button's left edge, opened above when there is room.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupComposerCommandMenu } from "./composer-command-menu.js";

function makeMenu({
  buttonRect,
  viewport = { width: 1024, height: 768 },
  menuHeight = 120,
  menuWidth = 340,
}) {
  document.body.replaceChildren();
  const button = document.createElement("button");
  const menu = document.createElement("div");
  menu.className = "command-palette hidden";
  const list = document.createElement("div");
  menu.appendChild(list);
  document.body.append(button, menu);

  button.getBoundingClientRect = () => buttonRect;
  // jsdom has no layout: the menu's measured height is stubbed.
  Object.defineProperty(menu, "offsetHeight", { configurable: true, get: () => menuHeight });
  Object.defineProperty(menu, "offsetWidth", { configurable: true, get: () => menuWidth });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });

  const controller = setupComposerCommandMenu({
    button,
    menu,
    list,
    getCommands: () => [{ icon: "bot", label: "Compact", desc: "Compact the context" }],
    document,
  });
  return { button, menu, controller };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("composer command menu anchoring", () => {
  it("opens upward with its left edge on the button's left edge", () => {
    const { button, menu } = makeMenu({
      // Composer-bottom button: 700px from the top, left edge at x=300.
      buttonRect: { top: 700, bottom: 728, right: 334, left: 300, width: 34, height: 28 },
    });
    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("300px"); // button left edge, menu opens to its right
    expect(menu.style.right).toBe("auto");
    expect(menu.style.bottom).toBe("76px"); // 768 - 700 + 8 gap
    expect(menu.style.top).toBe("auto");
  });

  it("clamps the anchor so the menu never leaves the viewport", () => {
    const { button, menu } = makeMenu({
      buttonRect: { top: 700, bottom: 728, right: 1000, left: 966, width: 34, height: 28 },
      viewport: { width: 1024, height: 768 },
      menuWidth: 340,
    });
    button.click();
    expect(menu.style.left).toBe("676px"); // 1024 - 340 - 8
  });

  it("flips below the button when the space above cannot fit the menu", () => {
    const { button, menu } = makeMenu({
      buttonRect: { top: 40, bottom: 68, right: 400, left: 366, width: 34, height: 28 },
      menuHeight: 400,
    });
    button.click();
    expect(menu.style.top).toBe("76px"); // rect.bottom + 8 gap
    expect(menu.style.bottom).toBe("auto");
  });

  it("closes on an outside click and toggles from the button", () => {
    const { button, menu, controller } = makeMenu({
      buttonRect: { top: 700, bottom: 728, right: 1000, left: 972, width: 28, height: 28 },
    });
    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    document.body.click();
    expect(menu.classList.contains("hidden")).toBe(true);
    button.click();
    button.click();
    expect(menu.classList.contains("hidden")).toBe(true);
    controller.destroy();
    vi.restoreAllMocks();
  });
});
