// ABOUTME: End-to-end Info panel history check against a REAL read_session_tree
// ABOUTME: data_response (flat entries, trimmed from session 01a06630 in Viber/quick-folder).
// ABOUTME: The host data plane serves flat entries + leafId; deep branch nesting
// ABOUTME: never crosses the runtime bridge.
import { describe, expect, test, vi } from "vitest";
import { InfoPanel } from "./info-panel.js";

const t = (key, params = {}) => {
  const dict = {
    "infoPanel.title": "Info",
    "infoPanel.workspace": "Workspace",
    "infoPanel.copyPath": "Copy path",
    "infoPanel.sessionHistory": "Session history",
    "infoPanel.activePath": "Active path",
    "infoPanel.branch": "Branch",
    "infoPanel.turns": "{count} turns",
    "infoPanel.resumeBranch": "Resume branch",
    "infoPanel.empty": "No messages yet",
    "infoPanel.roleUser": "You",
    "infoPanel.roleAssistant": "Picot",
    "nav.openInApp": "Open in {app}",
  };
  let out = dict[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.replace(`{${name}}`, String(value));
  }
  return out;
};

// Trimmed from a real session JSONL (read line-by-line by the host data
// plane): the leading root chain of session 01a06630. The first user message
// sits at depth 6 — model_change / thinking_level_change / custom entries
// precede it in the file.
const REAL_FLAT_ENTRIES = [
  { type: "session", id: "01a06630", parentId: null },
  { type: "model_change", id: "c7ad66c5", parentId: "01a06630" },
  { type: "thinking_level_change", id: "f432aa17", parentId: "c7ad66c5" },
  { type: "custom", id: "f92c3b53", parentId: "f432aa17" },
  { type: "model_change", id: "c6d7211b", parentId: "f92c3b53" },
  {
    type: "message",
    id: "75ecf0aa",
    parentId: "c6d7211b",
    message: { role: "user", content: [{ type: "text", text: "你读一下这个代码库" }] },
  },
];

function makePanel() {
  const panel = document.createElement("aside");
  const actions = {
    apps: [],
    copyWorkspacePath: vi.fn(async () => "/wsp/path"),
    openWorkspaceInApp: vi.fn(async () => {}),
  };
  const info = new InfoPanel({
    panel,
    actions,
    t,
    onNavigateLeaf: vi.fn(),
    isStreaming: () => false,
  });
  return { info, panel };
}

describe("InfoPanel history from a real read_session_tree payload", () => {
  test("flat real entries render as session history rows", () => {
    const { info, panel } = makePanel();
    // Exactly what refreshInfoTree hands over from a read_session_tree reply.
    info.updateWorkspace("/Users/linyong/tmp/Viber/quick-folder");
    info.updateTree({ entries: REAL_FLAT_ENTRIES, leafId: "75ecf0aa" });

    // The real chain's only message entry renders as a history row;
    // model_change / custom entries are tree structure, not rows.
    expect(panel.textContent).toContain("你读一下这个代码库");
    expect(panel.textContent).toContain("Session history");
    expect(panel.querySelectorAll(".info-panel-row").length).toBeGreaterThanOrEqual(1);
  });
});
