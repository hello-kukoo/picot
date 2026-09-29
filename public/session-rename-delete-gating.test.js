// ABOUTME: Regression tests for gating rename/delete on active or busy sessions.
// ABOUTME: Covers in-place toggling, entry guards and the live-instance snapshot.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { JSDOM } from "jsdom";
import { buildSessionItem } from "./sidebar/build-session-item.js";
import { SessionSidebar } from "./sidebar/index.js";

const transport = {
  available: true,
  capabilities: { native: true },
  sessionRename: vi.fn(async () => ({ ok: true })),
  sessionDeleteBatch: vi.fn(async () => ({ deleted: 1, running: [], errors: [] })),
  runtimeInstances: vi.fn(async () => ({ instances: [] })),
  listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
};

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS;
  globalThis.localStorage = dom.window.localStorage;
  transport.sessionRename.mockClear();
  transport.sessionDeleteBatch.mockClear();
  transport.runtimeInstances.mockClear();
});

function makeSidebar() {
  const root = document.getElementById("root");
  return new SessionSidebar(root, vi.fn(), vi.fn(), { transport });
}

function rowFor(sidebar, overrides = {}) {
  return sidebar.buildSessionItem(
    { filePath: "/sessions/a.jsonl", name: "Some name", ...overrides.session },
    { path: "/w" },
    { showDeleteButton: true },
  );
}

function visibleButtons(item) {
  const rename = item.querySelector(".session-rename-btn");
  const del = item.querySelector(".session-delete-btn");
  return {
    renameExists: Boolean(rename),
    renameHidden: rename?.classList.contains("action-hidden") ?? null,
    renameDisabled: rename?.disabled ?? null,
    deleteExists: Boolean(del),
    deleteHidden: del?.classList.contains("action-hidden") ?? null,
    deleteDisabled: del?.disabled ?? null,
  };
}

describe("rename/delete gating on blocked sessions", () => {
  test("active session renders both buttons hidden in place", () => {
    const sidebar = makeSidebar();
    sidebar.activeSessionFile = "/sessions/a.jsonl";
    const state = visibleButtons(rowFor(sidebar));
    expect(state).toEqual({
      renameExists: true,
      renameHidden: true,
      renameDisabled: true,
      deleteExists: true,
      deleteHidden: true,
      deleteDisabled: true,
    });
  });

  test("idle non-active session shows enabled buttons", () => {
    const sidebar = makeSidebar();
    sidebar.activeSessionFile = "/sessions/other.jsonl";
    const state = visibleButtons(rowFor(sidebar));
    expect(state.renameHidden).toBe(false);
    expect(state.renameDisabled).toBe(false);
    expect(state.deleteHidden).toBe(false);
    expect(state.deleteDisabled).toBe(false);
  });

  test("streaming and live sessions gate rename too", () => {
    const sidebar = makeSidebar();
    sidebar.activeSessionFile = "/sessions/other.jsonl";
    sidebar.streamingFiles.add("/sessions/a.jsonl");
    expect(visibleButtons(rowFor(sidebar)).renameHidden).toBe(true);

    sidebar.streamingFiles.delete("/sessions/a.jsonl");
    sidebar.getLiveInstances = () => [{ sessionFile: "/sessions/a.jsonl" }];
    expect(visibleButtons(rowFor(sidebar)).renameHidden).toBe(true);
  });

  test("raw node builder honors explicit blocked reasons (Focus path)", () => {
    const item = buildSessionItem({
      session: { filePath: "/sessions/a.jsonl" },
      showDeleteButton: true,
      deletionBlockedReason: "busy",
      renameBlockedReason: "busy-rename",
      onRename: (_filePath, _session, node) => node,
    });
    expect(item.querySelector(".session-rename-btn").classList.contains("action-hidden")).toBe(
      true,
    );
    expect(item.querySelector(".session-delete-btn").classList.contains("action-hidden")).toBe(
      true,
    );
  });

  test("context menu does not open for blocked sessions", () => {
    const sidebar = makeSidebar();
    sidebar.activeSessionFile = "/sessions/a.jsonl";
    const item = rowFor(sidebar);
    sidebar.showSessionContextMenu(null, item, {
      filePath: "/sessions/a.jsonl",
      name: "n",
    });
    expect(document.querySelector(".sidebar-context-menu")).toBeNull();
  });
});

describe("state flips update rendered rows in place", () => {
  test("idle → streaming → idle toggles button visibility without rebuild", () => {
    const sidebar = makeSidebar();
    const item = rowFor(sidebar);
    sidebar.container.appendChild(item);
    sidebar.rebuildStatusIndex();

    sidebar.setStreaming("/sessions/a.jsonl", true);
    expect(visibleButtons(item).renameHidden).toBe(true);
    expect(visibleButtons(item).deleteHidden).toBe(true);

    sidebar.setStreaming("/sessions/a.jsonl", false);
    expect(visibleButtons(item).renameHidden).toBe(false);
    expect(visibleButtons(item).deleteHidden).toBe(false);
  });

  test("live-instance snapshot feeds the running gate", async () => {
    const sidebar = makeSidebar();
    transport.runtimeInstances.mockResolvedValueOnce({
      instances: [{ sessionFile: "/sessions/a.jsonl" }],
    });
    await sidebar.fetchLiveInstances();
    expect(sidebar.isLiveSession("/sessions/a.jsonl")).toBe(true);
    expect(visibleButtons(rowFor(sidebar)).renameHidden).toBe(true);
  });
});

describe("entry guards re-check the gate", () => {
  test("startRename refuses a blocked session", () => {
    const sidebar = makeSidebar();
    sidebar.activeSessionFile = "/sessions/a.jsonl";
    const item = rowFor(sidebar);
    sidebar.container.appendChild(item);
    sidebar.startRename(item, { filePath: "/sessions/a.jsonl", name: "n" });
    expect(item.querySelector(".session-rename-input")).toBeNull();
  });

  test("deleteSession bails with a notice on a blocked session", async () => {
    const sidebar = makeSidebar();
    const notices = [];
    sidebar.onSessionNotice = (message) => notices.push(message);
    sidebar.activeSessionFile = "/sessions/a.jsonl";
    await sidebar.deleteSession("/sessions/a.jsonl");
    expect(transport.sessionDeleteBatch).not.toHaveBeenCalled();
    expect(notices).toEqual(["sidebar.deleteDisabledActive"]);
  });
});
