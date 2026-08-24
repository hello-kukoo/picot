// ABOUTME: Unit tests for the Info panel view (workspace actions + session tree).
// Ported from picot-v3 5dd2bb9; navigation callbacks stay injected so the
// component remains independent from runtime transport details.
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
    "infoPanel.empty": "No messages yet",
    "infoPanel.roleUser": "You",
    "infoPanel.roleAssistant": "Assistant",
    "infoPanel.statusError": "Error",
    "infoPanel.statusAborted": "Aborted",
    "infoPanel.imageMessage": "Image",
    "infoPanel.resumeBranch": "Resume branch",
    "infoPanel.resumeStreamingBlocked": "Resume unavailable while streaming",
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
    const { panel } = makePanel({ onNavigateLeaf: vi.fn() });
    const info = new InfoPanel({
      panel,
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
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
    // Resume controls render only after expanding inactive branch content.
    expect(panel.querySelector(".info-panel-resume")).toBeNull();
  });

  test("expanding a branch reveals inactive rows with a Resume action on leaves", () => {
    const onNavigateLeaf = vi.fn();
    const { info, panel } = makePanel({
      onNavigateLeaf,
      actions: {
        apps: [],
        copyWorkspacePath: async () => "",
        openWorkspaceInApp: async () => {},
      },
    });
    info.updateTree({ entries, leafId: "jwtA" });
    panel.querySelector(".info-panel-branch-summary").click();

    const summary = panel.querySelector(".info-panel-branch-summary");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const inactive = [...panel.querySelectorAll(".info-panel-row.inactive")];
    expect(inactive.map((r) => r.dataset.entryId)).toEqual(["cookie", "cookieA"]);
    // Inactive rows are divs (not focusable fake buttons) and aria-disabled.
    expect(inactive.every((r) => r.tagName === "DIV")).toBe(true);
    expect(inactive.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    const resume = panel.querySelector('.info-panel-resume[aria-label*="Cookie done"]');
    expect(resume).not.toBeNull();
    resume.click();
    expect(onNavigateLeaf).toHaveBeenCalledWith("cookieA");
  });

  test("disables Resume while the runtime is streaming", () => {
    const { info, panel } = makePanel({
      isStreaming: () => true,
      onNavigateLeaf: vi.fn(),
    });
    info.updateTree({ entries, leafId: "jwtA" });
    panel.querySelector(".info-panel-branch-summary").click();
    const resume = panel.querySelector(".info-panel-resume");
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe("Resume unavailable while streaming");
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
    });
    info.updateTree({ entries: [], leafId: null });
    expect(info.panel.querySelector(".info-panel-tree-empty").textContent).toBe("No messages yet");
  });

  test("history heading leaves refresh control to the panel header", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
    });
    expect(info.panel.querySelector(".info-panel-refresh-btn")).toBeNull();
  });

  test("stale expand state is pruned when the tree changes", () => {
    const info = new InfoPanel({
      panel: document.createElement("aside"),
      actions: { apps: [], copyWorkspacePath: async () => "", openWorkspaceInApp: async () => {} },
      t,
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
    info._renderTree();

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

  test("unknown entry id marks no row and never throws", () => {
    const { info, panel } = makeSelectionPanel();
    info.updateTree({ entries, leafId: "jwtA" });
    info.selectEntry("ghost-id");
    expect(panel.querySelectorAll(".info-panel-row.selected")).toHaveLength(0);

    expect(() => info.scrollToSelectedEntry()).not.toThrow();
    expect(() => info.updateTree({ entries, leafId: "jwtA" })).not.toThrow();
  });
});
