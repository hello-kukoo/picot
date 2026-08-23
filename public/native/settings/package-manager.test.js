import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n.js";
import { normalizeSource, setupPackageManager } from "./package-manager.js";

function renderManagerDom() {
  document.body.innerHTML = `
    <div class="settings-tab" data-settings-panel="extensions">
      <div class="settings-section" id="pkg-manager-section">
        <div class="pkg-manager-shell">
          <div class="pkg-manager-sidebar">
            <div id="pkg-manager-groups" class="pkg-manager-groups"></div>
            <button type="button" id="pkg-manager-add-btn">+ Add plugin</button>
          </div>
          <div id="pkg-manager-detail" class="pkg-manager-detail"></div>
        </div>
        <div id="pkg-manager-footer" class="pkg-manager-footer"></div>
      </div>
      <div class="settings-section" id="pkg-browse-section" hidden></div>
    </div>
  `;
}

function mockPackages(listPiPackages) {
  const control = {
    listPiPackages: vi.fn().mockResolvedValue(listPiPackages),
    installPiPackage: vi.fn().mockResolvedValue(undefined),
    removePiPackage: vi.fn().mockResolvedValue(undefined),
    updatePiPackage: vi.fn().mockResolvedValue(undefined),
    setPiPackageDisabled: vi.fn().mockResolvedValue(true),
    restartRuntime: vi.fn().mockResolvedValue("instance-new"),
  };
  return control;
}

function sidebarRows() {
  return [...document.querySelectorAll(".pkg-manager-sidebar-row")];
}

function detail() {
  return document.getElementById("pkg-manager-detail");
}

describe("normalizeSource", () => {
  it("passes through a bare source", () => {
    expect(normalizeSource("npm:foo")).toBe("npm:foo");
  });

  it("strips a leading `pi install` command", () => {
    expect(normalizeSource("pi install npm:foo")).toBe("npm:foo");
    expect(normalizeSource(" npm install @scope/pkg ")).toBe("@scope/pkg");
  });

  it("drops flags from a pasted install command", () => {
    expect(normalizeSource("pi install -l npm:foo")).toBe("npm:foo");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeSource("   ")).toBe("");
  });
});

describe("setupPackageManager", () => {
  beforeEach(() => {
    renderManagerDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders an empty note when no packages are installed", async () => {
    const control = mockPackages([]);
    const manager = setupPackageManager({ control });
    await manager.load();
    expect(document.getElementById("pkg-manager-groups").textContent).toContain(
      t("extensions.noInstalled"),
    );
  });

  it("renders a sidebar row per package, grouped by scope, and selects the first one", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        description: "Adds foo commands to Pi.",
        disabled: false,
        counts: { extensions: 2, skills: 1, prompts: 0, themes: 0 },
        resources: [],
      },
      {
        source: "npm:bar",
        scope: "project",
        installedPath: null,
        packageName: null,
        version: null,
        disabled: true,
        counts: {},
        resources: [],
      },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    const rendered = sidebarRows();
    expect(rendered).toHaveLength(2);
    expect(rendered[0].textContent).toContain("foo");
    expect(rendered[1].textContent).toContain("npm:bar");

    const groups = document.getElementById("pkg-manager-groups");
    expect(groups.textContent).toContain("GLOBAL");
    expect(groups.textContent).toContain("PROJECT");

    // First package is selected by default and shown in the detail pane.
    expect(detail().textContent).toContain("npm:foo");
    expect(detail().textContent).toContain("Adds foo commands to Pi.");
  });

  it("switches the detail pane when a different sidebar row is clicked", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", disabled: false, counts: {}, resources: [] },
      { source: "npm:bar", scope: "project", disabled: false, counts: {}, resources: [] },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    sidebarRows()[1].click();
    expect(detail().textContent).toContain("npm:bar");
  });

  it("disables the selected package and sends the disable request", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        disabled: false,
        counts: {},
        resources: [],
      },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    const toggle = detail().querySelector(".pkg-manager-toggle");
    toggle.click();

    await vi.waitFor(() => {
      expect(control.setPiPackageDisabled).toHaveBeenCalledWith("npm:foo", "global", true, "");
    });
  });

  it("reveals the community browse section when the add button is clicked", () => {
    const onBrowseRevealed = vi.fn();
    setupPackageManager({ control: mockPackages([]), onBrowseRevealed });
    const managerSection = document.getElementById("pkg-manager-section");
    const browseSection = document.getElementById("pkg-browse-section");
    expect(managerSection.hidden).toBe(false);
    expect(browseSection.hidden).toBe(true);
    document.getElementById("pkg-manager-add-btn").click();
    expect(managerSection.hidden).toBe(true);
    expect(browseSection.hidden).toBe(false);
    expect(onBrowseRevealed).toHaveBeenCalled();
  });

  it("restarts the runtime and calls onRestarted when reload is clicked", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        disabled: false,
        counts: {},
        resources: [],
      },
    ]);
    const onRestarted = vi.fn();
    const manager = setupPackageManager({
      control,
      getWorkspaceId: () => "ws-1",
      getSessionId: () => "s-1",
      onRestarted,
    });
    await manager.load();

    document.getElementById("pkg-manager-reload-btn").click();

    await vi.waitFor(() => {
      expect(control.restartRuntime).toHaveBeenCalledWith("ws-1", "s-1");
      expect(onRestarted).toHaveBeenCalledTimes(1);
    });
  });

  it("checks for updates after load and badges packages with available updates", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
      { source: "npm:bar", scope: "global", version: "2.0.0", counts: {}, resources: [] },
    ]);
    control.checkPiPackageUpdates = vi
      .fn()
      .mockResolvedValue([{ source: "npm:foo", scope: "global", available: true }]);
    const onUpdatesChecked = vi.fn();
    const manager = setupPackageManager({
      control,
      getWorkspaceId: () => "ws-1",
      onUpdatesChecked,
    });

    await manager.load();

    expect(control.checkPiPackageUpdates).toHaveBeenCalledWith("ws-1");
    expect(onUpdatesChecked).toHaveBeenCalledWith(1);
    const badged = sidebarRows()[0].querySelector(".pkg-manager-update-badge");
    expect(badged).toBeTruthy();
    expect(badged.textContent).toBe(t("extensions.updateAvailable"));
    expect(sidebarRows()[1].querySelector(".pkg-manager-update-badge")).toBeNull();
  });

  it("enables the detail Update button only when an update is available", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
    ]);
    control.checkPiPackageUpdates = vi.fn().mockResolvedValue([]);
    const manager = setupPackageManager({ control, getWorkspaceId: () => "ws-1" });
    await manager.load();

    // No update reported: Update stays disabled.
    let updateBtn = [...detail().querySelectorAll("button")].find(
      (btn) => btn.textContent === t("extensions.update"),
    );
    expect(updateBtn.disabled).toBe(true);

    // Report an update: the same button becomes enabled.
    control.checkPiPackageUpdates.mockResolvedValue([
      { source: "npm:foo", scope: "global", available: true },
    ]);
    await manager.load(true);
    updateBtn = [...detail().querySelectorAll("button")].find(
      (btn) => btn.textContent === t("extensions.update"),
    );
    expect(updateBtn.disabled).toBe(false);
  });

  it("updates every package with a pending update via the update-all button", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
      { source: "npm:bar", scope: "project", version: "2.0.0", counts: {}, resources: [] },
    ]);
    control.checkPiPackageUpdates = vi.fn().mockResolvedValue([
      { source: "npm:foo", scope: "global", available: true },
      { source: "npm:bar", scope: "project", available: true },
    ]);
    const manager = setupPackageManager({ control, getWorkspaceId: () => "ws-1" });
    await manager.load();

    const updateAllBtn = document.getElementById("pkg-manager-update-all-btn");
    expect(updateAllBtn).toBeTruthy();
    expect(updateAllBtn.disabled).toBe(false);
    updateAllBtn.click();

    await vi.waitFor(() => {
      expect(control.updatePiPackage).toHaveBeenCalledTimes(2);
      expect(control.updatePiPackage).toHaveBeenNthCalledWith(1, "npm:foo");
      expect(control.updatePiPackage).toHaveBeenNthCalledWith(2, "npm:bar");
    });
    // After updating, no package is badged anymore and the button disables.
    expect(sidebarRows()[0].querySelector(".pkg-manager-update-badge")).toBeNull();
    expect(document.getElementById("pkg-manager-update-all-btn").disabled).toBe(true);
  });

  it("keeps update buttons disabled while the check fails or is in flight", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
    ]);
    control.checkPiPackageUpdates = vi.fn().mockRejectedValue(new Error("registry unavailable"));
    const manager = setupPackageManager({ control, getWorkspaceId: () => "ws-1" });
    await manager.load();

    // The list survives a failed check; a notice explains why buttons are disabled.
    expect(sidebarRows()).toHaveLength(1);
    expect(document.getElementById("pkg-manager-footer").textContent).toContain(
      t("extensions.checkUpdatesFailed"),
    );
  });

  it("keeps the failed package badged and shows a failure notice when update-all partially fails", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
      { source: "npm:bar", scope: "project", version: "2.0.0", counts: {}, resources: [] },
    ]);
    control.checkPiPackageUpdates = vi.fn().mockResolvedValue([
      { source: "npm:foo", scope: "global", available: true },
      { source: "npm:bar", scope: "project", available: true },
    ]);
    control.updatePiPackage = vi
      .fn()
      .mockImplementation((source) =>
        source === "npm:bar" ? Promise.reject(new Error("boom")) : Promise.resolve(),
      );
    const manager = setupPackageManager({ control, getWorkspaceId: () => "ws-1" });
    await manager.load();

    document.getElementById("pkg-manager-update-all-btn").click();

    await vi.waitFor(() => {
      expect(control.updatePiPackage).toHaveBeenCalledTimes(2);
      // The succeeded package loses its badge; the failed one keeps it.
      expect(sidebarRows()[0].querySelector(".pkg-manager-update-badge")).toBeNull();
      expect(sidebarRows()[1].querySelector(".pkg-manager-update-badge")).toBeTruthy();
    });
    expect(document.getElementById("pkg-manager-footer").textContent).toContain(
      t("extensions.updatedAllWithFailures", { count: 1, failed: 1 }),
    );
  });

  it("merges concurrent loads into a single update probe", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", version: "1.0.0", counts: {}, resources: [] },
    ]);
    let resolveProbe;
    control.checkPiPackageUpdates = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const manager = setupPackageManager({ control, getWorkspaceId: () => "ws-1" });

    const first = manager.load(true);
    const second = manager.load(true);
    await vi.waitFor(() => expect(control.checkPiPackageUpdates).toHaveBeenCalledTimes(1));
    resolveProbe([]);
    await Promise.all([first, second]);
    expect(control.checkPiPackageUpdates).toHaveBeenCalledTimes(1);
  });
});
