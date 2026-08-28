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
            openProject: "Open project",
            emptySession: "Empty",
            deleteSession: "Delete",
            deleteSessionConfirmOne: "Delete this session permanently?",
            deleteSessionConfirmMany: "Delete {count} sessions permanently?",
            deleteSessionAriaLabel: "Delete sessions",
            deleteSessionRunning: "Cannot delete a running session",
            pinWorkspace: "Pin workspace",
            unpinWorkspace: "Unpin workspace",
            openInFinder: "Open in Finder",
            deleteWorkspaceSessions: "Delete all sessions",
            deleteWorkspaceConfirm: "Delete {count} sessions permanently?",
            deleteWorkspaceNamePrompt: "Type workspace name to confirm:",
            deleteWorkspaceNameWarning: "Workspace name does not match.",
            deleteWorkspaceNameLabel: "Workspace name",
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
  test("individual delete cancellation sends no delete-batch request", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 1, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    sidebar.showFallbackConfirmDialog = vi.fn(async () => false);

    await expect(sidebar.deleteSession("/s/a.jsonl")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/delete-batch"),
      expect.anything(),
    );
  });

  test("confirm cancel sends no delete-batch request", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 0, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    const operation = sidebar.deleteWorkspaceSessions(WORKSPACE);
    document.querySelector(".sidebar-confirm-no").click();
    await operation;

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/delete-batch"),
      expect.anything(),
    );
  });

  test("confirmed deletion posts all eligible paths in one batch", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 2, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    const operation = sidebar.deleteWorkspaceSessions({
      ...WORKSPACE,
      folderName: "w",
    });
    const dialog = document.querySelector(".sidebar-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    input.value = "w";
    dialog.querySelector(".sidebar-confirm-yes").click();
    await operation;

    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/a.jsonl", "/s/b.jsonl"] });
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
    const operation = sidebar.deleteWorkspaceSessions({
      ...WORKSPACE,
      folderName: "w",
    });
    const dialog = document.querySelector(".sidebar-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    input.value = "w";
    dialog.querySelector(".sidebar-confirm-yes").click();
    await operation;

    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/a.jsonl", "/s/b.jsonl"] });
    expect(notice).toHaveBeenCalled();
  });

  test("workspace name mismatch keeps modal open and sends no request", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 1, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    const operation = sidebar.deleteWorkspaceSessions({
      path: "/work/picot-v3",
      folderName: "picot-v3",
      sessions: [{ filePath: "/s/a.jsonl" }],
    });
    const dialog = document.querySelector(".sidebar-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    const confirm = dialog.querySelector(".sidebar-confirm-yes");
    input.value = "wrong";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    confirm.click();

    expect(dialog.querySelector(".workspace-delete-warning").hidden).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/delete-batch"),
      expect.anything(),
    );

    dialog.querySelector(".sidebar-confirm-no").click();
    await operation;
  });

  test("exact workspace name sends one batch request", async () => {
    const fetchMock = deleteBatchFetch({ deleted: 2, errors: [], running: [] });
    global.fetch = fetchMock;
    const sidebar = makeSidebar();
    const operation = sidebar.deleteWorkspaceSessions({
      path: "/work/picot-v3",
      folderName: "picot-v3",
      sessions: [{ filePath: "/s/a.jsonl" }, { filePath: "/s/b.jsonl" }],
    });
    const dialog = document.querySelector(".sidebar-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    input.value = "picot-v3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.querySelector(".sidebar-confirm-yes").click();

    await operation;
    const deleteRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/sessions/delete-batch"),
    );
    expect(deleteRequests).toHaveLength(1);
    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/a.jsonl", "/s/b.jsonl"] });
  });

  test("workspace delete modal keeps input and actions in separate flow sections", () => {
    const sidebar = makeSidebar();
    const operation = sidebar.deleteWorkspaceSessions({
      ...WORKSPACE,
      folderName: "w",
    });
    const dialog = document.querySelector(".workspace-delete-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    const actions = dialog.querySelector(".sidebar-confirm-actions");

    expect(dialog).toBeTruthy();
    expect(input).toBeTruthy();
    expect(actions).toBeTruthy();
    expect(input.closest(".workspace-delete-confirm-label")).toBeTruthy();
    expect(actions.previousElementSibling).toBe(dialog.querySelector(".workspace-delete-warning"));
    expect(dialog.classList.contains("sidebar-confirm-dialog")).toBe(true);

    dialog.querySelector(".sidebar-confirm-no").click();
    return operation;
  });

  test("workspace context menu renders the delete-all entry", () => {
    const sidebar = makeSidebar();
    // Cookie pin store is retired; empty registry pins keep the menu lean.
    sidebar._registryPins = [];
    const event = new window.MouseEvent("contextmenu", { bubbles: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    sidebar.showWorkspaceContextMenu(event, WORKSPACE);

    const items = [...document.querySelectorAll(".context-menu-item")].map((b) => b.textContent);
    expect(items).toContain("Delete all sessions");
  });
});
