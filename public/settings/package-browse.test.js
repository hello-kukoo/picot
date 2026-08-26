// ABOUTME: Tests the extracted Community package browser without app-level globals.
// ABOUTME: Locks installed-state handling, registry rendering, and desktop-only actions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPackageBrowse } from "./package-browse.js";

function translations(key, params = {}) {
  const values = {
    "extensions.loadingPackages": "Loading",
    "extensions.failedToLoadPackages": "Failed",
    "extensions.noPackagesMatch": "No matches",
    "extensions.browseCountRange": `${params.start}-${params.end}/${params.total}`,
    "extensions.browseCountZero": `0/${params.total}`,
    "extensions.downloadsPerMonth": `${params.count} downloads`,
    "extensions.desktopOnly": "Desktop only",
    "actions.install": "Install",
    "actions.uninstall": "Uninstall",
    "status.installing": "Installing",
    "status.uninstalling": "Uninstalling",
    "status.removing": "Removing",
    "browse.openExternalPrompt": "Open external link",
    "actions.retry": "Retry",
  };
  return values[key] || key;
}

function createRoot() {
  const root = document.implementation.createHTMLDocument("browse");
  root.body.innerHTML = `
    <input id="pkg-browse-search">
    <div id="pkg-browse-pills"></div>
    <select id="pkg-browse-sort"></select>
    <span id="pkg-browse-count"></span>
    <div id="pkg-browse-list"></div>
  `;
  return root;
}

describe("Community package browser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all registry results and maps rich installed records by source", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi
        .fn()
        .mockResolvedValue([{ source: "npm:installed", scope: "global", disabled: false }]),
      installPiPackage: vi.fn(),
      removePiPackage: vi.fn(),
      openExternal: vi.fn(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          version: 1,
          packages: [
            { name: "installed", description: "Installed package", types: ["extensions"] },
            { name: "available", description: "Available package", types: ["skills"] },
          ],
        }),
      }),
    );

    const browser = setupPackageBrowse({
      root,
      transport,
      nativeAvailable: () => true,
      t: translations,
      createIcon: () => document.createElement("span"),
      renderPackageInstallFailure: vi.fn(),
      setExtensionActionButton: (button, label) => {
        button.textContent = label;
      },
      catalogUrl: "https://registry.test/catalog.json",
    });
    await browser.load();

    const rows = root.querySelectorAll(".pkg-browse-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".settings-extension-actions button").textContent).toBe(
      "Uninstall",
    );
    expect(rows[1].querySelector(".settings-extension-actions button").textContent).toBe("Install");
    expect(root.querySelector("#pkg-browse-installed-only")).toBeNull();
    expect(browser.getInstalledSources()).toEqual(new Set(["npm:installed"]));
  });

  it("disables install actions for non-native clients", async () => {
    const root = createRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ packages: [{ name: "available", types: [] }], totalPages: 1 }),
      }),
    );
    const browser = setupPackageBrowse({
      root,
      transport: { listPiPackages: vi.fn() },
      nativeAvailable: () => false,
      t: translations,
      createIcon: () => document.createElement("span"),
      renderPackageInstallFailure: vi.fn(),
      setExtensionActionButton: (button, label) => {
        button.textContent = label;
      },
    });
    await browser.load();

    const button = root.querySelector(".pkg-browse-row .settings-extension-actions button");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Desktop only");
  });
});
