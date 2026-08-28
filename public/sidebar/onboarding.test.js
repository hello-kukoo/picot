import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { SessionSidebar } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sidebar: {
            showMore: "Show more",
            showLess: "Show less",
            openProject: "Open Project",
            loadingSessions: "Loading sessions...",
            pinned: "PINNED",
            projects: "PROJECTS",
            untitled: "Untitled",
            emptySession: "Empty session",
            rename: "Rename",
            pinSession: "Pin session",
            unpinSession: "Unpin session",
            workspaceActions: "Workspace actions",
            newChat: "New chat in {path}",
            deleteSession: "Delete",
            deleteWorkspaceSessions: "Delete all sessions",
            deleteWorkspaceConfirm: "Delete {count} sessions permanently? This cannot be undone.",
            deleteWorkspaceNamePrompt: "Type workspace name to confirm:",
            deleteWorkspaceNameWarning: "Workspace name does not match.",
            deleteWorkspaceNameLabel: "Workspace name",
            deleteDisabledActive: "Cannot delete the active session",
            deleteDisabledStreaming: "Cannot delete a streaming session",
            deleteDisabledRunning: "Cannot delete a running session",
            justNow: "Just now",
            minutesAgo: "{minutes}m ago",
            hoursAgo: "{hours}h ago",
            yesterday: "Yesterday",
            startingSession: "Starting session…",
            retry: "Retry",
            failedToLoadSessions: "Failed to load sessions.",
            failedToLoadSessionsRuntime: "Failed to load sessions. Pi runtime may be unavailable.",
            search: "Search...",
            clearSearch: "Clear search",
            openFolder: "Open folder as workspace",
            openFolderAria: "Open folder",
            refreshSessions: "Refresh sessions",
            settings: "Settings",
            updateAvailable: "Update available",
            update: "Update",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("SessionSidebar onboarding empty state", () => {
  test("renders a lightweight open project action when no sessions exist", () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;

    const onOpenProject = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onOpenProject,
    });

    sidebar.projects = [];
    sidebar.render();

    const button = document.querySelector(".session-empty-open-project");
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Open Project");
    expect(button.textContent).toContain("Open Project");

    button.click();
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  test("keeps the newest registry rows when overlapping refreshes resolve out of order", async () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.CSS = dom.window.CSS;

    // Registry data source: the sequence guard lives around workspace.list.
    let resolveFirst;
    let resolveSecond;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const transport = {
      available: true,
      capabilities: { native: true },
      getPreference: vi.fn(async () => ({ value: null })),
      setPreference: vi.fn(async () => ({})),
      listPreferences: vi.fn(async () => ({ preferences: {} })),
      listWorkspaces: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    };

    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      transport,
    });

    const firstLoad = sidebar.loadSessions({ quiet: true });
    const secondLoad = sidebar.loadSessions({ quiet: true });

    resolveSecond({
      workspaces: [
        {
          workspaceId: "uuid-new",
          canonicalPath: "/work/new",
          displayName: "new",
          pinned: false,
          lastOpenedAt: null,
        },
      ],
      removed: [],
    });
    await secondLoad;
    expect(sidebar.projects.some((project) => project.workspaceId === "ws:uuid-new")).toBe(true);

    // The stale first response must never clobber the newer commit.
    resolveFirst({
      workspaces: [
        {
          workspaceId: "uuid-old",
          canonicalPath: "/work/old",
          displayName: "old",
          pinned: false,
          lastOpenedAt: null,
        },
      ],
      removed: [],
    });
    await firstLoad;

    expect(sidebar.projects.some((project) => project.workspaceId === "ws:uuid-old")).toBe(false);
    expect(sidebar.projects.some((project) => project.workspaceId === "ws:uuid-new")).toBe(true);
  });

  test("filters project groups by project name", () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.CSS = dom.window.CSS;

    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = [
      {
        path: "/work/alpha-dashboard",
        dirName: "alpha-dashboard",
        sessions: [{ filePath: "alpha.jsonl", name: "Fix login" }],
      },
      {
        path: "/work/beta-api",
        dirName: "beta-api",
        sessions: [{ filePath: "beta.jsonl", name: "Review auth" }],
      },
    ];

    sidebar.render();
    sidebar.setSearchQuery("alpha-dashboard");

    const groups = Array.from(document.querySelectorAll(".project-group"));
    expect(groups[0].style.display).toBe("");
    expect(groups[0].querySelector(".session-item").classList.contains("hidden")).toBe(false);
    expect(groups[1].style.display).toBe("none");
  });
});
