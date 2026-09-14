// ABOUTME: Verifies that normal sidebar rows receive Pi-style tree metadata.
// ABOUTME: Covers the cross-file parentSession integration at the DOM boundary.

import { JSDOM } from "jsdom";
import { beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { SessionSidebar } from "./index.js";

beforeEach(async () => {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || { escape: (value) => String(value) };
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/locales/en.json")) {
      return {
        ok: true,
        json: async () => ({
          sidebar: {
            pinned: "Pinned",
            projects: "Projects",
            emptySession: "Empty",
            deleteSession: "Delete",
            deleteDisabledActive: "Active",
            deleteDisabledStreaming: "Streaming",
            deleteDisabledRunning: "Running",
            workspaceActions: "Workspace actions",
            deleteWorkspaceSessions: "Delete all sessions",
            deleteWorkspaceSessionsConfirm: "Delete {count} sessions?",
            sessionCountPending: "Pending",
            justNow: "Just now",
            minutesAgo: "{minutes}m",
            hoursAgo: "{hours}h",
            yesterday: "Yesterday",
          },
          actions: { cancel: "Cancel", delete: "Delete" },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

test("renders parent and child sessions with a linear tree prefix", () => {
  const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
  const parent = {
    id: "parent",
    filePath: "/sessions/parent.jsonl",
    name: "Parent",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const child = {
    id: "child",
    filePath: "/sessions/child.jsonl",
    name: "Child",
    parentSession: parent.filePath,
    timestamp: "2026-01-02T00:00:00.000Z",
  };
  sidebar.projects = [
    {
      workspaceId: "workspace",
      path: "/work",
      folderName: "work",
      sessions: [child, parent],
      sessionCount: 2,
    },
  ];

  sidebar.render();

  const rows = [...document.querySelectorAll(".project-group .session-item")];
  expect(rows.map((row) => row.dataset.filePath)).toEqual([parent.filePath, child.filePath]);
  expect(rows[0].querySelector(".session-tree-prefix")).toBeNull();
  expect(rows[1].querySelector(".session-tree-prefix").textContent).toBe("   └─ ");
});
