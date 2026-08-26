// ABOUTME: Tests for permanent-delete protection over active, streaming, and live sessions.
// ABOUTME: Covers reason precedence and batch-delete filtering.
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
            pinSession: "Pin",
            unpinSession: "Unpin",
            deleteDisabledActive: "Cannot delete the active session",
            deleteDisabledStreaming: "Cannot delete a streaming session",
            deleteDisabledRunning: "Cannot delete a running session",
            deleteWorkspaceSessions: "Delete all sessions",
            deleteWorkspaceConfirm: "Delete {count} sessions permanently?",
            deleteWorkspaceNamePrompt: "Type workspace name to confirm:",
            deleteWorkspaceNameLabel: "Workspace name",
            deleteWorkspaceNameWarning: "Workspace name does not match.",
            unavailable: "Unavailable",
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

describe("SessionSidebar deletion protection", () => {
  test("deletionBlockedReason covers active, streaming, and live; null otherwise", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      getLiveInstances: () => [{ sessionFile: "/s/live.jsonl" }],
    });
    sidebar.activeSessionFile = "/s/active.jsonl";
    sidebar.setStreaming("/s/stream.jsonl", true);

    expect(sidebar.deletionBlockedReason("/s/active.jsonl")).not.toBeNull();
    expect(sidebar.deletionBlockedReason("/s/stream.jsonl")).not.toBeNull();
    expect(sidebar.deletionBlockedReason("/s/live.jsonl")).not.toBeNull();
    expect(sidebar.deletionBlockedReason("/s/free.jsonl")).toBeNull();
  });

  test("active reason takes precedence over streaming and live", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      getLiveInstances: () => [{ sessionFile: "/s/active.jsonl" }],
    });
    sidebar.activeSessionFile = "/s/active.jsonl";
    sidebar.setStreaming("/s/active.jsonl", true);
    expect(sidebar.deletionBlockedReason("/s/active.jsonl")).toBe(
      "Cannot delete the active session",
    );
  });

  test("deleteWorkspaceSessions skips active, streaming, and live sessions", async () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      getLiveInstances: () => [{ sessionFile: "/s/live.jsonl" }],
    });
    sidebar.projects = [];
    sidebar.activeSessionFile = "/s/active.jsonl";
    sidebar.setStreaming("/s/stream.jsonl", true);
    sidebar.loadSessions = vi.fn(async () => {});
    const fetchMock = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => {
        fetchMock.lastPayload = JSON.parse(init?.body || "{}");
        return { deleted: 1, errors: [], running: [] };
      },
    }));
    global.fetch = fetchMock;
    const workspace = {
      folderName: "workspace",
      path: "/work/workspace",
      sessions: [
        { filePath: "/s/free.jsonl", name: "Free" },
        { filePath: "/s/active.jsonl", name: "Active" },
        { filePath: "/s/stream.jsonl", name: "Stream" },
        { filePath: "/s/live.jsonl", name: "Live" },
      ],
    };

    const operation = sidebar.deleteWorkspaceSessions(workspace);
    const dialog = document.querySelector(".sidebar-confirm-dialog");
    const input = dialog.querySelector(".workspace-delete-confirm-input");
    input.value = "workspace";
    dialog.querySelector(".sidebar-confirm-yes").click();
    await operation;

    expect(fetchMock.lastPayload).toEqual({ filePaths: ["/s/free.jsonl"] });
  });
});
