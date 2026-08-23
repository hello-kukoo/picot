// ABOUTME: Unit tests for the Info panel view (workspace actions + session tree).
import { describe, expect, test, vi } from "vitest";
import { InfoPanel } from "./info-panel.js";

const t = (key, params = {}) => {
  const dict = {
    "infoPanel.title": "Info",
    "infoPanel.workspace": "Workspace",
    "infoPanel.copyPath": "Copy path",
    "infoPanel.copied": "Copied",
    "infoPanel.sessionHistory": "Session history",
    "infoPanel.activePath": "Active path",
    "infoPanel.branch": "Branch",
    "infoPanel.turns": "{count} turns",
    "infoPanel.resumeBranch": "Resume branch",
    "infoPanel.refresh": "Refresh session history",
    "infoPanel.resumeStreamingBlocked": "Blocked while streaming",
    "infoPanel.empty": "No messages yet",
    "infoPanel.roleUser": "You",
    "infoPanel.roleAssistant": "Picot",
    "infoPanel.statusError": "Error",
    "infoPanel.statusAborted": "Aborted",
    "infoPanel.imageMessage": "Image",
    "nav.openInApp": "Open in {app}",
  };
  let out = dict[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.replace(`{${name}}`, String(value));
  }
  return out;
};

function u(id, parentId, content) {
  return { type: "message", id, parentId, message: { role: "user", content } };
}
function a(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" },
  };
}

function makePanel(overrides = {}) {
  const panel = document.createElement("aside");
  const actions = {
    apps: [
      { id: "vscode", label: "VS Code" },
      { id: "zed", label: "Zed" },
      { id: "terminal", label: "Terminal" },
    ],
    copyWorkspacePath: vi.fn(async () => "/wsp/path"),
    openWorkspaceInApp: vi.fn(async () => {}),
  };
  const options = {
    panel,
    actions,
    t,
    onNavigateLeaf: vi.fn(),
    isStreaming: () => false,
    ...overrides,
  };
  const info = new InfoPanel(options);
  return { info, panel, actions };
}

describe("InfoPanel workspace section", () => {
  test("renders copy row plus one row per installed design app", () => {
    const { panel } = makePanel();
    const rows = [...panel.querySelectorAll(".info-panel-link")];
    expect(rows.map((r) => r.textContent.trim())).toEqual([
      "Copy path",
      "Open in VS Code",
      "Open in Zed",
      "Open in Terminal",
    ]);
  });

  test("hides app rows that are not installed", () => {
    const { panel } = makePanel();
    const info = new InfoPanel({
      panel: panel.cloneNode(false),
      actions: {
        apps: [{ id: "vscode", label: "VS Code" }],
        copyWorkspacePath: async () => "",
        openWorkspaceInApp: async () => {},
      },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    const labels = [...info.panel.querySelectorAll(".info-panel-link:not(.hidden)")].map((r) =>
      r.textContent.trim(),
    );
    expect(labels).toEqual(["Copy path", "Open in VS Code"]);
  });

  test("updateWorkspace updates the path text and title", () => {
    const { info, panel } = makePanel();
    info.updateWorkspace("/tmp/alpha/beta");
    const path = panel.querySelector(".info-panel-path");
    expect(path.textContent).toBe("/tmp/alpha/beta");
    expect(path.title).toBe("/tmp/alpha/beta");
  });

  test("copy row swaps to Copied and reverts", async () => {
    vi.useFakeTimers();
    try {
      const { panel, actions } = makePanel();
      panel.querySelector(".info-panel-link").click();
      // The click handler awaits the clipboard write; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(actions.copyWorkspacePath).toHaveBeenCalled();
      expect(panel.querySelector(".info-panel-link").textContent.trim()).toBe("Copied");
      vi.advanceTimersByTime(1300);
      expect(panel.querySelector(".info-panel-link").textContent.trim()).toBe("Copy path");
    } finally {
      vi.useRealTimers();
    }
  });

  test("app rows launch through the shared controller", () => {
    const { panel, actions } = makePanel();
    const zedRow = [...panel.querySelectorAll(".info-panel-link-app")].find((r) =>
      r.textContent.includes("Zed"),
    );
    zedRow.click();
    expect(actions.openWorkspaceInApp).toHaveBeenCalledWith({ id: "zed", label: "Zed" });
  });
});

describe("InfoPanel session history", () => {
  const entries = [
    u("u1", null, "JWT or cookie?"),
    a("a1", "u1", "Recommendation"),
    u("jwt", "a1", "Implement JWT"),
    a("jwtA", "jwt", "JWT done"),
    u("cookie", "a1", "Implement cookie"),
    a("cookieA", "cookie", "Cookie done"),
  ];

  test("active path nodes are buttons; inactive branch collapses to a summary", () => {
    const { panel } = makePanel();
    const info = new InfoPanel({
      panel,
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    info.updateTree({ entries, leafId: "jwtA" });

    const activeRows = [...panel.querySelectorAll(".info-panel-row.active")];
    expect(activeRows.map((r) => r.dataset.entryId)).toEqual(["u1", "a1", "jwt", "jwtA"]);
    expect(activeRows.every((r) => r.tagName === "BUTTON")).toBe(true);
    // Every row under the role=tree container carries treeitem semantics.
    expect(activeRows.every((r) => r.getAttribute("role") === "treeitem")).toBe(true);

    const summary = panel.querySelector(".info-panel-branch-summary");
    expect(summary).not.toBeNull();
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("1 turns"); // head user only in this subtree
    // Collapsed: no inactive rows in DOM yet.
    expect(panel.querySelector(".info-panel-row.inactive")).toBeNull();
  });

  test("expanding a branch reveals inactive non-navigable rows", () => {
    const { info, panel } = (() => {
      const made = makePanel({
        actions: {
          apps: [],
          copyWorkspacePath: async () => "",
          openWorkspaceInApp: async () => {},
        },
      });
      return made;
    })();
    info.updateTree({ entries, leafId: "jwtA" });
    panel.querySelector(".info-panel-branch-summary").click();

    const summary = panel.querySelector(".info-panel-branch-summary");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const inactive = [...panel.querySelectorAll(".info-panel-row.inactive")];
    expect(inactive.map((r) => r.dataset.entryId)).toEqual(["cookie", "cookieA"]);
    // Inactive rows are divs (not focusable fake buttons) and aria-disabled.
    expect(inactive.every((r) => r.tagName === "DIV")).toBe(true);
    expect(inactive.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
  });

  test("resume appears only on the expanded inactive leaf and fires onNavigateLeaf", () => {
    const onNavigateLeaf = vi.fn();
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf,
      isStreaming: () => false,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    info.panel.querySelector(".info-panel-branch-summary").click();

    const resumes = [...info.panel.querySelectorAll(".info-panel-resume")];
    expect(resumes.map((r) => r.closest(".info-panel-row").dataset.entryId)).toEqual(["cookieA"]);
    resumes[0].click();
    expect(onNavigateLeaf).toHaveBeenCalledWith("cookieA");
  });

  test("resume is disabled while streaming", () => {
    let streaming = true;
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => streaming,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    info.panel.querySelector(".info-panel-branch-summary").click();
    const resume = info.panel.querySelector(".info-panel-resume");
    expect(resume.disabled).toBe(true);
    resume.click();
    // Re-enable and re-render: clicking now navigates.
    streaming = false;
    info.updateTree({ entries, leafId: "jwtA" });
    info.expandedBranches.add("cookie");
    info._renderTree();
    expect(info.panel.querySelector(".info-panel-resume").disabled).toBe(false);
  });

  test("clicking an active node selects the Info row and scrolls the anchored message", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.dataset.entryId = "jwt";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    try {
      const info = new InfoPanel({
        panel: document.createElement("aside"),
        actions: {
          apps: [],
          copyWorkspacePath: async () => "",
          openWorkspaceInApp: async () => {},
        },
        t,
        onNavigateLeaf: () => {},
        isStreaming: () => false,
      });
      info.updateTree({ entries, leafId: "jwtA" });
      const row = [...info.panel.querySelectorAll(".info-panel-row.active")].find(
        (r) => r.dataset.entryId === "jwt",
      );
      row.click();
      expect(row.classList.contains("selected")).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    } finally {
      target.remove();
    }
  });

  test("empty tree renders the empty state", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    info.updateTree({ entries: [], leafId: null });
    expect(info.panel.querySelector(".info-panel-tree-empty").textContent).toBe("No messages yet");
  });

  test("appendLiveEntry grows the cached tree without a full snapshot", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    info.updateTree({ entries, leafId: "jwtA" }); // cache seeded
    const before = info.entries.length;

    const ok = info.appendLiveEntry({
      type: "message",
      id: "live1",
      parentId: "jwtA",
      message: { role: "user", content: "Next live turn" },
    });
    expect(ok).toBe(true);
    expect(info.entries.length).toBe(before + 1);
    expect(info.leafId).toBe("live1");
    const row = info.panel.querySelector(".info-panel-row.current-leaf");
    expect(row.dataset.entryId).toBe("live1");
  });

  test("appendLiveEntry falls back to false for unknown parents / duplicates / no cache", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    expect(
      info.appendLiveEntry({ type: "message", id: "x", message: { role: "user", content: "" } }),
    ).toBe(false); // no cached snapshot

    info.updateTree({ entries, leafId: "jwtA" });
    expect(
      info.appendLiveEntry({
        type: "message",
        id: "y",
        parentId: "ghost",
        message: { role: "user", content: "" },
      }),
    ).toBe(false); // parent not in snapshot (stale chain)
    expect(
      info.appendLiveEntry({ type: "message", id: "jwtA", message: { role: "user", content: "" } }),
    ).toBe(false); // duplicate id
  });

  test("appendLiveEntry requests recalibration when the cache snapshot is stale", () => {
    const info = makePanel().info;
    // Copy: updateTree keeps the array by reference and appends mutate it;
    // the module-level `entries` must stay pristine for other tests.
    info.updateTree({ entries: entries.slice(), leafId: "jwtA" });
    const append = (id, parentId) =>
      info.appendLiveEntry({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: `t${id}` },
      });

    // Fresh cache: appends succeed and keep the local cache authoritative.
    expect(append("n1", "jwtA")).toBe(true);
    expect(append("n2", "n1")).toBe(true);

    // Cache older than FULL_SYNC_MAX_AGE_MS (10 min): the next append still
    // pushes into the cache but returns false — the caller syncs fully,
    // replacing the cache wholesale and recalibrating the clock.
    const realNow = Date.now;
    const t0 = realNow.call(Date);
    Date.now = () => t0 + 10 * 60_000 + 1;
    try {
      expect(append("n3", "n2")).toBe(false);
    } finally {
      Date.now = realNow;
    }
    // A real full snapshot recalibrates.
    info.updateTree({ entries: entries.slice(), leafId: "jwtA" });
    expect(append("n4", "jwtA")).toBe(true);
  });

  test("rerenderTree re-renders without recalibrating the staleness clock", () => {
    const info = makePanel().info;
    info.updateTree({ entries: entries.slice(), leafId: "jwtA" });
    // Age the cache past the threshold, then re-render locally (the clean-cache
    // refresh path in app.js).
    const realNow = Date.now;
    const t0 = realNow.call(Date);
    Date.now = () => t0 + 10 * 60_000 + 1;
    try {
      info.rerenderTree();
      expect(info.panel.querySelector(".info-panel-row.current-leaf").dataset.entryId).toBe("jwtA");
      // The re-render must NOT have reset the clock — the next append still
      // requests a full recalibration.
      expect(
        info.appendLiveEntry({
          type: "message",
          id: "late1",
          parentId: "jwtA",
          message: { role: "user", content: "" },
        }),
      ).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test("appendLiveEntry bumps the cache generation (in-flight sync race guard)", () => {
    const info = makePanel().info;
    info.updateTree({ entries: entries.slice(), leafId: "jwtA" });
    const before = info.generation;
    const okGen = info.appendLiveEntry({
      type: "message",
      id: "gen1",
      parentId: "jwtA",
      message: { role: "user", content: "" },
    });
    expect(okGen).toBe(true);
    expect(info.generation).toBe(before + 1);
    // A failed append (duplicate) does not bump it.
    info.appendLiveEntry({
      type: "message",
      id: "gen1",
      parentId: "jwtA",
      message: { role: "user", content: "" },
    });
    expect(info.generation).toBe(before + 1);
  });

  test("history heading leaves refresh control to shared sidebar toolbar", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    expect(info.panel.querySelector(".info-panel-refresh-btn")).toBeNull();
  });

  test("stale expand state is pruned when the tree changes", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    info.expandedBranches.add("cookie");
    info.expandedBranches.add("vanished-branch");
    info.updateTree({ entries, leafId: "cookieA" }); // resume flips the tree
    expect(info.expandedBranches.has("vanished-branch")).toBe(false);
    // "cookie" is now on the active path — no longer a branch anchor either.
    expect(info.expandedBranches.has("cookie")).toBe(false);
  });

  test("current leaf row carries the marker class", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
      onNavigateLeaf: () => {},
      isStreaming: () => false,
    });
    info.updateTree({ entries, leafId: "jwtA" });
    const current = info.panel.querySelector(".info-panel-row.current-leaf");
    expect(current.dataset.entryId).toBe("jwtA");
    // The current-leaf state must reach assistive technology, not just CSS.
    expect(current.getAttribute("aria-current")).toBe("true");
    // Exactly one row is marked current.
    expect(
      [...info.panel.querySelectorAll(".info-panel-row")].filter(
        (r) => r.getAttribute("aria-current") === "true",
      ).length,
    ).toBe(1);
  });
});

describe("InfoPanel selection", () => {
  const entries = [
    u("u1", null, "JWT or cookie?"),
    a("a1", "u1", "Recommendation"),
    u("jwt", "a1", "Implement JWT"),
    a("jwtA", "jwt", "JWT done"),
    u("cookie", "a1", "Implement cookie"),
    a("cookieA", "cookie", "Cookie done"),
  ];

  function makeSelectionPanel(overrides = {}) {
    return makePanel({
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      ...overrides,
    });
  }

  function rowEl(panel, id) {
    return panel.querySelector(`.info-panel-row[data-entry-id="${id}"]`);
  }

  // jsdom has no Element.scrollIntoView; patch it for the duration of one
  // test body so scroll assertions survive re-renders (fresh row elements).
  function withScrollIntoViewStub(fn) {
    const proto = Element.prototype;
    const original = proto.scrollIntoView;
    const stub = vi.fn();
    proto.scrollIntoView = stub;
    try {
      return fn(stub);
    } finally {
      if (original === undefined) delete proto.scrollIntoView;
      else proto.scrollIntoView = original;
    }
  }

  test("selectEntry applies .selected to the matching row and moves it between rows", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });

    info.selectEntry("jwt");
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(false);

    info.selectEntry("u1");
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(false);
  });

  test("selectEntry(null) clears the selection from every row", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.selectEntry("jwt");
    info.selectEntry(null);
    expect(info.selectedEntryId).toBeNull();
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);
  });

  test("clicking an active row selects it; clicking another moves the selection", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });

    rowEl(panel, "jwt").click();
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(true);

    rowEl(panel, "u1").click();
    expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    expect(rowEl(panel, "jwt").classList.contains("selected")).toBe(false);
  });

  test("clicking an inactive row changes nothing", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.expandedBranches.add("cookie");
    info.rerenderTree();

    const inactive = rowEl(panel, "cookie");
    expect(inactive).not.toBeNull();
    inactive.click();
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);
  });

  test("scrollToSelectedEntry scrolls the selected row into view", () => {
    withScrollIntoViewStub(() => {
      const { info, panel } = makeSelectionPanel();
      info.updateTree({ entries, leafId: "jwtA" });
      info.selectEntry("u1");

      const scrollIntoView = vi.fn();
      rowEl(panel, "u1").scrollIntoView = scrollIntoView;
      info.scrollToSelectedEntry();
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(info._pendingSelectedScroll).toBe(false);
    });
  });

  test("hidden panel defers the scroll; the next full rebuild consumes it", () => {
    withScrollIntoViewStub((scrollIntoView) => {
      const { info, panel } = makeSelectionPanel();
      panel.classList.add("hidden");
      info.updateTree({ entries, leafId: "jwtA" });

      info.selectEntry("u1");
      info.scrollToSelectedEntry(); // panel hidden → latches the pending scroll
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(info._pendingSelectedScroll).toBe(true);

      panel.classList.remove("hidden");
      info.updateTree({ entries, leafId: "jwtA" }); // rebuild consumes the latch
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(info._pendingSelectedScroll).toBe(false);
      // The rebuilt rows re-apply the selection from selectedEntryId.
      expect(rowEl(panel, "u1").classList.contains("selected")).toBe(true);
    });
  });

  test("selected row hidden behind a collapsed branch defers until a rebuild shows it", () => {
    withScrollIntoViewStub((scrollIntoView) => {
      const { info, panel } = makeSelectionPanel();
      info.updateTree({ entries, leafId: "jwtA" });

      info.selectEntry("cookie"); // lives in the collapsed branch — no row in DOM
      expect(rowEl(panel, "cookie")).toBeNull();
      info.scrollToSelectedEntry();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(info._pendingSelectedScroll).toBe(true);

      info.expandedBranches.add("cookie");
      info.rerenderTree(); // rebuild consumes the latch now that the row exists
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(rowEl(panel, "cookie").classList.contains("selected")).toBe(true);
    });
  });

  test("scrollToSelectedEntry without a selection is a no-op that never latches", () => {
    const { info } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.scrollToSelectedEntry();
    expect(info._pendingSelectedScroll).toBe(false);
  });

  test("unknown entry id marks no row and never throws", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.selectEntry("ghost-id");
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);

    expect(() => info.scrollToSelectedEntry()).not.toThrow();
    // A rebuild with the ghost id still absent stays silent and keeps latching.
    expect(() => info.updateTree({ entries, leafId: "jwtA" })).not.toThrow();
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);
  });
});
