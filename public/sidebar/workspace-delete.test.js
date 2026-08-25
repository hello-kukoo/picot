// ABOUTME: Tests for workspace-level batch deletion via the context menu.
// ABOUTME: Covers confirm flow, delete-batch payload, and state cleanup per response class.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { SessionSidebar } from "./index.js";

function setupDom() {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || { escape: (v) => String(v).replace(/["\\]/g, "\\$&") };
}

function deleteBatchFetch(response) {
  const mock = vi.fn(async (url, init) => {
    const target = String(url);
    if (target.includes("/api/sessions/delete-batch")) {
      const body = JSON.parse(init?.body || "{}");
      mock.lastPayload = body;
      return { ok: true, status: 200, json: async () => response };
    }
    if (target.includes("/api/sessions")) {
      return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return mock;
}

beforeEach(async () => {
  setupDom();
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sidebar: {
            recent: "RECENT",
            pinned: "PINNED",
            projects: "PROJECTS",
            archived: "Archived",
            openProject: "Open project",
            emptySession: "Empty",
            deleteSession: "Delete",
            deleteWorkspaceSessions: "Delete all sessions",
            deleteWorkspaceConfirm: "Delete {count} sessions permanently?",
            deleteWorkspaceRunning: "Some sessions are still running",
          },
          actions: { cancel: "Cancel", delete: "Delete" },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSidebar({ notice } = {}) {
  const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
    onSessionNotice: notice,
  });
  sidebar.projects = [];
  return sidebar;
}

const WORKSPACE = {
  path: "/w",
  sessions: [
    { filePath: "/s/a.jsonl", name: "A" },
    { filePath: "/s/b.jsonl", name: "B" },
  ],
};

describe("SessionSidebar workspace deletion", () => {
  test("confirm cancel sends no delete-batch request", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 0, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    sidebar.showFallbackConfirmDialog = vi.fn(async () => false);

    await sidebar.deleteWorkspaceSessions(WORKSPACE);

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/delete-batch"),
      expect.anything(),
    );
  });

  test("confirmed deletion posts all eligible paths in one batch", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 2, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    sidebar.showFallbackConfirmDialog = vi.fn(async () => true);

    await sidebar.deleteWorkspaceSessions(WORKSPACE);

    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/a.jsonl", "/s/b.jsonl"] });
    expect(sidebar.archived).toEqual([]);
  });

  test("running sessions stay listed and surface a notice; deleted ones are cleaned", async () => {
    const fetchMock = deleteBatchFetch({
      deleted: 1,
      errors: [],
      running: ["/s/b.jsonl"],
    });
    global.fetch = fetchMock;
    const notice = vi.fn();
    const sidebar = makeSidebar({ notice });
    sidebar.showFallbackConfirmDialog = vi.fn(async () => true);
    sidebar.archived = ["/s/a.jsonl", "/s/b.jsonl"];

    await sidebar.deleteWorkspaceSessions(WORKSPACE);

    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/a.jsonl", "/s/b.jsonl"] });
    expect(sidebar.archived).toEqual(["/s/b.jsonl"]);
    expect(notice).toHaveBeenCalled();
  });

  test("workspace context menu renders the delete-all entry", () => {
    const sidebar = makeSidebar();
    sidebar.pinStore.getRenderableState = () => ({ workspaces: [] });
    const event = new window.MouseEvent("contextmenu", { bubbles: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    sidebar.showWorkspaceContextMenu(event, WORKSPACE);

    const items = [...document.querySelectorAll(".context-menu-item")].map((b) => b.textContent);
    expect(items).toContain("Delete all sessions");
  });
});
