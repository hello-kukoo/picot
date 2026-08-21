// ABOUTME: Tests the sidebar extension-update indicator's throttled refresh.
// ABOUTME: Confirms the indicator relies on checkPiPackageUpdates and skips the redundant list call.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupExtensionUpdateIndicator } from "./extension-update-indicator.js";

function createButton() {
  const doc = document.implementation.createHTMLDocument("indicator");
  const button = doc.createElement("button");
  button.id = "sidebar-extension-update-btn";
  doc.body.appendChild(button);
  return { doc, button };
}

const t = (key) => key;

describe("extension update indicator", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("skips the redundant list and surfaces the update check count", async () => {
    const { button } = createButton();
    const transport = {
      listPiPackages: vi.fn(),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([
        { source: "npm:a", scope: "global", available: true },
        { source: "npm:b", scope: "global", available: false },
        { source: "npm:c", scope: "global", available: true },
      ]),
    };
    const indicator = setupExtensionUpdateIndicator({
      transport,
      nativeAvailable: () => true,
      t,
      buttonEl: button,
    });

    await indicator.refresh({ force: true });

    expect(transport.listPiPackages).not.toHaveBeenCalled();
    expect(transport.checkPiPackageUpdates).toHaveBeenCalledTimes(1);
    expect(button.classList.contains("hidden")).toBe(false);
    expect(button.getAttribute("aria-label")).toContain("(2)");
  });

  it("keeps the last count when the update check fails", async () => {
    const { button } = createButton();
    const transport = {
      listPiPackages: vi.fn(),
      checkPiPackageUpdates: vi
        .fn()
        .mockResolvedValueOnce([{ source: "npm:a", scope: "global", available: true }])
        .mockRejectedValueOnce(new Error("offline")),
    };
    const indicator = setupExtensionUpdateIndicator({
      transport,
      nativeAvailable: () => true,
      t,
      buttonEl: button,
    });

    await indicator.refresh({ force: true });
    expect(button.getAttribute("aria-label")).toContain("(1)");

    await indicator.refresh({ force: true });
    expect(transport.listPiPackages).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-label")).toContain("(1)");
  });
});
