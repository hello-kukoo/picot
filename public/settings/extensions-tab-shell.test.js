// ABOUTME: Tests the accessible Installed/Community Extensions tab shell.
// ABOUTME: Verifies roving tabindex, panel visibility, keyboard navigation, and lazy activation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupExtensionsTabShell } from "./extensions-tab-shell.js";

function createTab(name, active = false) {
  const tab = document.createElement("button");
  tab.dataset.extensionsTab = name;
  if (active) tab.setAttribute("aria-selected", "true");
  return tab;
}

describe("Extensions tab shell", () => {
  let tabs;
  let panels;
  let activate;

  beforeEach(() => {
    tabs = [createTab("installed"), createTab("community")];
    panels = new Map(
      tabs.map((tab) => {
        const panel = document.createElement("section");
        panel.id = `extensions-${tab.dataset.extensionsTab}`;
        return [tab.dataset.extensionsTab, panel];
      }),
    );
    document.body.replaceChildren(...tabs, ...panels.values());
    activate = vi.fn();
  });

  it("selects Installed initially and activates each panel only once", () => {
    const shell = setupExtensionsTabShell({ tabs, panels, activate });

    expect(tabs[0].getAttribute("role")).toBe("tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-controls")).toBe("extensions-installed");
    expect(tabs[0].tabIndex).toBe(0);
    expect(panels.get("installed").hidden).toBe(false);
    expect(panels.get("community").hidden).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith("installed");

    tabs[1].click();
    tabs[0].click();
    tabs[1].click();
    expect(activate.mock.calls.map(([name]) => name)).toEqual(["installed", "community"]);
    shell.destroy();
  });

  it("supports Arrow, Home, and End navigation with roving tabindex", () => {
    setupExtensionsTabShell({ tabs, panels, activate });

    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].tabIndex).toBe(0);
    expect(panels.get("community").classList.contains("hidden")).toBe(false);

    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(document.activeElement).toBe(tabs[1]);
  });
});
