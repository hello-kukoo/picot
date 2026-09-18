// ABOUTME: Locks the upstream session-row dot semantics — streaming (green),
// ABOUTME: unread (blue), cleared by selecting the session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { SessionSidebar } from "./index.js";

function setupDom() {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || { escape: (v) => String(v).replace(/["\\]/g, "\\$&") };
}

function registryProject() {
  return {
    workspaceId: "ws:uuid-1",
    registryId: "uuid-1",
    pinned: false,
    path: "/work/alpha",
    folderName: "alpha",
    dirName: "-work-alpha",
    sessions: [
      { filePath: "/sessions/a.jsonl", name: "A", timestamp: "2026-09-18T00:00:00Z", mtime: 1 },
    ],
    sessionCount: 1,
    hiddenSubagentCount: 0,
    runningInstances: [],
    isProvisional: false,
    source: "registry",
    activityAt: 1,
    lastActivityAt: 1,
  };
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
            newSession: "New chat",
            newChat: "New chat",
            workspaceActions: "Workspace actions",
            rename: "Rename",
            deleteSession: "Delete session",
            deleteDisabledActive: "Cannot delete the active session",
            sessionCountPending: "Session count will be calculated after opening this workspace.",
            unavailable: "Unavailable",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("session-row streaming/unread dots", () => {
  test("agent activity drives the row classes upstream-style", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {});
    sidebar.projects = [registryProject()];
    sidebar.render();
    sidebar.rebuildStatusIndex();

    const row = document.querySelector('.session-item[data-file-path="/sessions/a.jsonl"]');
    expect(row).not.toBeNull();

    // agent_start on a background workspace: streaming (green dot) plus the
    // unread marker that outlives the turn.
    sidebar.setStreaming("/sessions/a.jsonl", true);
    sidebar.markUnread("/sessions/a.jsonl");
    expect(row.classList.contains("streaming")).toBe(true);
    expect(row.classList.contains("unread")).toBe(true);

    // agent_end: the green dot stops; unread (blue dot) remains.
    sidebar.setStreaming("/sessions/a.jsonl", false);
    expect(row.classList.contains("streaming")).toBe(false);
    expect(row.classList.contains("unread")).toBe(true);

    // Selecting the session is the only way to clear the unread dot.
    // setActive re-renders through the keyed row cache, so re-query.
    sidebar.setActive("/sessions/a.jsonl");
    const activeRow = document.querySelector('.session-item[data-file-path="/sessions/a.jsonl"]');
    expect(activeRow.classList.contains("unread")).toBe(false);
    expect(activeRow.classList.contains("active")).toBe(true);
  });

  test("style.css defines green streaming over blue unread in the shared dot slot", () => {
    const css = readFileSync(join(process.cwd(), "public", "style.css"), "utf8");
    const unreadAt = css.indexOf(".session-item.unread .session-title::before");
    const streamingAt = css.indexOf(".session-item.streaming .session-title::before");
    expect(unreadAt).toBeGreaterThan(-1);
    expect(streamingAt).toBeGreaterThan(-1);
    // Later rule wins the cascade: while both classes are present, the dot
    // stays green until the turn ends.
    expect(streamingAt).toBeGreaterThan(unreadAt);
  });
});
