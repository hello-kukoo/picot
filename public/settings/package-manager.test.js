// ABOUTME: Tests the Installed package manager against rich native package records.
// ABOUTME: Verifies scope grouping, selection details, native mutation payloads, and capability recovery.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPackageManager } from "./package-manager.js";

function t(key, params = {}) {
  const values = {
    "extensions.managementUnavailable": "Desktop only",
    "extensions.noInstalled": "No installed packages",
    "extensions.noResources": "No resources",
    "extensions.noPackagesSummary": "No packages",
    "extensions.scopeGlobal": "Global",
    "extensions.scopeProject": "Project",
    "extensions.statusLoaded": "Loaded",
    "extensions.statusInstalled": "Installed",
    "extensions.statusDisabled": "Disabled",
    "extensions.updateAvailable": "Update available",
    "extensions.status": "Status",
    "extensions.resources": "Resources",
    "extensions.installPath": "Install path",
    "extensions.notOnDisk": "Not on disk",
    "extensions.resolvedResources": "Resolved resources",
    "extensions.update": "Update",
    "extensions.remove": "Remove",
    "extensions.refresh": "Refresh",
    "extensions.reloadAgent": "Reload",
    "extensions.reloadingAgent": "Reloading",
    "extensions.checkingUpdates": "Checking for updates",
    "extensions.packageDisabledMessage": `Disabled ${params.source}`,
    "extensions.packageEnabledMessage": `Enabled ${params.source}`,
    "extensions.resourceCount": `${params.count} ${params.label}`,
  };
  return values[key] || key;
}

function createRoot() {
  const root = document.implementation.createHTMLDocument("manager");
  for (const id of ["pkg-manager-groups", "pkg-manager-detail", "pkg-manager-footer"]) {
    const el = root.createElement("div");
    el.id = id;
    root.body.appendChild(el);
  }
  return root;
}

const records = [
  {
    source: "npm:global-tool",
    scope: "global",
    packageName: "global-tool",
    version: "1.2.3",
    description:
      "A global tool with a long multi-paragraph description that must wrap inside the detail status grid instead of being truncated to a single line.",
    installedPath: "/Users/test/.pi/agent/node_modules/global-tool",
    updateAvailable: true,
    counts: { extensions: 1 },
    resources: [{ name: "global.ts", relativePath: "extensions/global.ts" }],
  },
  {
    source: "npm:project-tool",
    scope: "project",
    packageName: "project-tool",
    disabled: true,
    updateAvailable: false,
    counts: { skills: 2 },
    resources: [],
  },
];

describe("Installed package manager", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("groups rich records and renders selected package details safely", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();

    expect(root.querySelectorAll(".pkg-manager-group-header")).toHaveLength(2);
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(2);
    expect(root.querySelector(".pkg-manager-source").textContent).toBe("npm:global-tool");
    expect(root.querySelector(".pkg-manager-resource-name").textContent).toBe("global.ts");
    expect(root.querySelector(".pkg-manager-resource-path").textContent).toBe(
      "extensions/global.ts",
    );
  });

  it("uses scoped disable and project remove operations", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      setPiPackageDisabled: vi.fn().mockResolvedValue({}),
      removePiPackage: vi.fn().mockResolvedValue({}),
      updatePiPackage: vi.fn(),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
    };
    const manager = setupPackageManager({ root, transport, nativeAvailable: () => true, t });
    await manager.load();

    const sidebarRows = root.querySelectorAll(".pkg-manager-sidebar-row");
    sidebarRows[1].click();
    await root.querySelector(".pkg-manager-toggle").click();
    expect(transport.setPiPackageDisabled).toHaveBeenCalledWith(
      "npm:project-tool",
      "project",
      false,
      "",
    );

    await root.querySelector(".pkg-manager-actions button.is-danger").click();
    expect(transport.removePiPackage).toHaveBeenCalledWith("npm:project-tool", { local: true });
    expect(manager.getPackages()).toHaveLength(1);
  });

  it("shows update availability for matching packages", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi
        .fn()
        .mockResolvedValue([{ source: "npm:global-tool", scope: "global", available: true }]),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();

    const badges = root.querySelectorAll(".pkg-manager-update-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toBe("Update available");
    expect(
      root
        .querySelectorAll(".pkg-manager-sidebar-row")[0]
        .querySelectorAll(".pkg-manager-update-badge"),
    ).toHaveLength(1);
    expect(
      root
        .querySelectorAll(".pkg-manager-sidebar-row")[1]
        .querySelectorAll(".pkg-manager-update-badge"),
    ).toHaveLength(0);
  });

  it("enables update only after the check reports an available update", async () => {
    const root = createRoot();
    let resolveCheck;
    const checkResult = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockReturnValue(checkResult),
      updatePiPackage: vi.fn(),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    const loading = manager.load();
    await Promise.resolve();
    await Promise.resolve();
    root.querySelectorAll(".pkg-manager-sidebar-row")[1].click();
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(true);
    expect(transport.updatePiPackage).not.toHaveBeenCalled();

    resolveCheck([{ source: "npm:project-tool", scope: "project", available: true }]);
    await loading;
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(false);
  });

  it("leaves update disabled when the check fails", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockRejectedValue(new Error("registry unavailable")),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();

    expect(root.querySelectorAll(".pkg-manager-actions button")[0].disabled).toBe(true);
    expect(root.querySelectorAll(".pkg-manager-actions button")[1].disabled).toBe(false);
    expect(root.querySelector("#pkg-manager-footer").textContent).toContain("registry unavailable");
  });

  it("keeps update disabled while a refresh is checking", async () => {
    const root = createRoot();
    let resolveRefresh;
    const refreshResult = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const transport = {
      listPiPackages: vi.fn().mockResolvedValueOnce(records).mockReturnValueOnce(records),
      checkPiPackageUpdates: vi
        .fn()
        .mockResolvedValueOnce([{ source: "npm:global-tool", scope: "global", available: true }])
        .mockReturnValueOnce(refreshResult),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();

    root.querySelectorAll(".pkg-manager-sidebar-row")[0].click();
    const updateButton = () => root.querySelector(".pkg-manager-actions button");
    const row = () => root.querySelectorAll(".pkg-manager-sidebar-row")[0];
    // rows[0] reports an available update: badge shown and button enabled.
    expect(row().querySelector(".pkg-manager-update-badge")).not.toBeNull();
    expect(updateButton().disabled).toBe(false);

    const refresh = manager.refresh();
    // The pending refresh null-resets updateAvailable, so the badge disappears and
    // the button disables even though the last check reported an update available.
    expect(row().querySelector(".pkg-manager-update-badge")).toBeNull();
    expect(updateButton().disabled).toBe(true);

    resolveRefresh([]);
    await refresh;
    expect(row().querySelector(".pkg-manager-update-badge")).toBeNull();
    expect(updateButton().disabled).toBe(true);
    expect(transport.listPiPackages).toHaveBeenCalledTimes(2);
    expect(transport.checkPiPackageUpdates).toHaveBeenCalledTimes(2);
  });

  it("overlapping refreshes share one in-flight load and apply the merge once", async () => {
    const root = createRoot();
    let resolveListing;
    let resolveCheck;
    const listing = new Promise((resolve) => {
      resolveListing = resolve;
    });
    const check = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const transport = {
      listPiPackages: vi.fn().mockReturnValue(listing),
      checkPiPackageUpdates: vi.fn().mockReturnValue(check),
    };
    const manager = setupPackageManager({ root, transport, nativeAvailable: () => true, t });

    const first = manager.load();
    await Promise.resolve();
    await Promise.resolve();
    // A refresh fired while the first load is parked in listPiPackages must
    // reuse the in-flight load instead of starting a second list + check pair,
    // so a superseded load can never merge stale results over newer records.
    const second = manager.refresh();
    expect(second).toBe(first);

    resolveListing(records);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.listPiPackages).toHaveBeenCalledTimes(1);
    expect(transport.checkPiPackageUpdates).toHaveBeenCalledTimes(1);

    resolveCheck([{ source: "npm:global-tool", scope: "global", available: true }]);
    await first;
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(2);
    expect(
      root.querySelectorAll(".pkg-manager-sidebar-row .pkg-manager-update-badge"),
    ).toHaveLength(1);
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(false);
  });

  it("re-entering the page re-checks updates before enabling buttons", async () => {
    const root = createRoot();
    let resolveSecondCheck;
    const secondCheck = new Promise((resolve) => {
      resolveSecondCheck = resolve;
    });
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi
        .fn()
        .mockResolvedValueOnce([{ source: "npm:global-tool", scope: "global", available: true }])
        .mockReturnValueOnce(secondCheck),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();
    root.querySelectorAll(".pkg-manager-sidebar-row")[0].click();
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(false);

    // Re-entering the page immediately disables every update button, even though
    // the previous check reported an update for this package.
    const secondLoad = manager.load();
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(true);

    resolveSecondCheck([{ source: "npm:global-tool", scope: "global", available: true }]);
    await secondLoad;
    expect(transport.listPiPackages).toHaveBeenCalledTimes(2);
    expect(transport.checkPiPackageUpdates).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".pkg-manager-actions button").disabled).toBe(false);
  });

  it("wraps long descriptions in the detail status grid", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    await manager.load();

    const rows = [...root.querySelectorAll(".pkg-manager-status-row")];
    const description = rows.find((row) => row.textContent.includes("multi-paragraph"));
    expect(description).toBeDefined();
    expect(description.querySelector("span.is-wrap")).not.toBeNull();
    const version = rows.find((row) => row.textContent.includes("1.2.3"));
    expect(version.querySelector("span.is-wrap")).toBeNull();
  });

  it("shows the checking notice while the update check is pending", async () => {
    const root = createRoot();
    let resolveCheck;
    const pending = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockReturnValue(pending),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
    });
    const loading = manager.load();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector("#pkg-manager-footer").textContent).toContain("Checking for updates");

    resolveCheck([]);
    await loading;
    expect(root.querySelector("#pkg-manager-footer").textContent).not.toContain(
      "Checking for updates",
    );
  });

  it("reloads the runtime without requiring a session id", async () => {
    const root = createRoot();
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
      restartRuntime: vi.fn().mockResolvedValue({ instanceId: "5001" }),
    };
    let restarted = false;
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => true,
      t,
      getWorkspaceId: () => "workspace:/tmp/demo",
      getSessionId: () => null,
      onRestarted: () => {
        restarted = true;
      },
    });
    await manager.load();

    await root.querySelector("#pkg-manager-reload-btn").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.restartRuntime).toHaveBeenCalledWith("workspace:/tmp/demo", "");
    expect(restarted).toBe(true);
    expect(root.querySelector("#pkg-manager-footer").textContent).not.toContain("Reloading");
  });

  it("keeps loaded packages when native capability drops mid-session", async () => {
    const root = createRoot();
    let native = true;
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => native,
      t,
    });
    await manager.load();
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(2);

    native = false;
    await manager.refresh();
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(2);
    expect(manager.getPackages()).toHaveLength(2);
    expect(root.querySelector("#pkg-manager-footer").textContent).toContain("Desktop only");
  });

  it("refreshes records when native capability arrives after initial activation", async () => {
    const root = createRoot();
    let native = false;
    const transport = {
      listPiPackages: vi.fn().mockResolvedValue(records),
      checkPiPackageUpdates: vi.fn().mockResolvedValue([]),
    };
    const manager = setupPackageManager({
      root,
      transport,
      nativeAvailable: () => native,
      t,
    });

    await manager.load();
    expect(transport.listPiPackages).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(0);

    native = true;
    await manager.refresh();
    expect(transport.listPiPackages).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll(".pkg-manager-sidebar-row")).toHaveLength(2);
  });
});
