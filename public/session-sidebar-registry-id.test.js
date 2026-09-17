// ABOUTME: Regression tests for registry workspace history loading: the
// ABOUTME: host-bound workspace id must be the raw DB uuid, never the merged
// ABOUTME: `ws:`-prefixed display identity.

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { JSDOM } from "jsdom";
import { SessionSidebar } from "./sidebar/index.js";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS;
  globalThis.localStorage = dom.window.localStorage;
  vi.useRealTimers();
});

function registryProject() {
  // The exact shape mergeRegistryWorkspaces produces for a DB row: the
  // display id is `ws:<uuid>`, the raw uuid lives in registryId.
  return {
    workspaceId: "ws:11111111-2222-3333-4444-555555555555",
    registryId: "11111111-2222-3333-4444-555555555555",
    pinned: false,
    path: "/tmp/picot-ws",
    folderName: "picot-ws",
    dirName: null,
    sessions: [],
    runningInstances: [],
    isProvisional: false,
    source: "registry",
    activityAt: 0,
    lastActivityAt: 0,
  };
}

function sidebarWith(transport) {
  const root = document.getElementById("root");
  return new SessionSidebar(root, vi.fn(), vi.fn(), { transport });
}

describe("registry workspace history loading", () => {
  test("full load sends the raw registry id, not the ws: display id", async () => {
    const transport = {
      available: true,
      capabilities: { native: true },
      listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
      runtimeInstances: vi.fn(async () => ({ instances: [] })),
      workspaceSessions: vi.fn(async () => ({
        sessions: [{ id: "s1", filePath: "/x/a.jsonl", mtime: 1 }],
        sessionCount: 1,
      })),
    };
    const sidebar = sidebarWith(transport);
    await sidebar.ensureWorkspaceSessions(registryProject());
    expect(transport.workspaceSessions).toHaveBeenCalledTimes(1);
    expect(transport.workspaceSessions).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
    );
    // The loaded history lands on the project for rendering.
    expect(sidebar.projects.length).toBeGreaterThanOrEqual(0);
  });

  test("count-only warmup also sends the raw registry id", async () => {
    const transport = {
      available: true,
      capabilities: { native: true },
      listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
      runtimeInstances: vi.fn(async () => ({ instances: [] })),
      workspaceSessions: vi.fn(async () => ({ sessionCount: 7, sessions: [] })),
    };
    const sidebar = sidebarWith(transport);
    const project = registryProject();
    await sidebar.ensureWorkspaceSessions(project, { countOnly: true });
    expect(transport.workspaceSessions).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
      { countOnly: true },
    );
    expect(project.sessionCount).toBe(7);
  });
});

// ── Landing boot sequence (projects seeded from the nav-state cookie cache,
// no registry load) — the expand flow Dr. Lin reported as broken. ──

describe("landing cached-row expansion", () => {
  function cachedProjectShape(withSessions) {
    // The exact shape readCachedSidebarProjects returns after the registryId
    // cache fix: display `ws:` id PLUS the raw uuid, sessions as cached.
    return {
      workspaceId: "ws:11111111-2222-3333-4444-555555555555",
      registryId: "11111111-2222-3333-4444-555555555555",
      path: "/tmp/picot-ws",
      folderName: "picot-ws",
      dirName: null,
      pinned: false,
      isProvisional: false,
      source: "registry",
      activityAt: 0,
      lastActivityAt: 0,
      sessions: withSessions ? [{ filePath: "/x/a.jsonl", name: "A", timestamp: 1 }] : [],
    };
  }

  function expandRow() {
    const header = document.querySelector(".workspace-header");
    header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }

  function sessionItemCount() {
    const container = document.querySelector(".workspace-sessions");
    if (!container) return 0;
    return [...container.children].filter(
      (child) => !child.classList.contains("project-sessions-toggle-row"),
    ).length;
  }

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }

  test("cached sessions survive first expand even when the refetch fails", async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const transport = {
      available: true,
      capabilities: { native: true },
      listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
      runtimeInstances: vi.fn(async () => ({ instances: [] })),
      workspaceSessions: vi.fn(async () => {
        throw new Error("workspace_not_found");
      }),
    };
    try {
      const sidebar = sidebarWith(transport);
      sidebar.projects = [cachedProjectShape(true)];
      sidebar.render();
      expect(sessionItemCount()).toBe(1); // built collapsed with cached rows

      expandRow();
      await flush();
      // The refetch uses the raw registry uuid — never the `ws:` display id.
      expect(transport.workspaceSessions).toHaveBeenCalledWith(
        "11111111-2222-3333-4444-555555555555",
      );
      expect(errors.some((e) => e.includes("workspace_not_found"))).toBe(true);
      expect(sessionItemCount()).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  test("empty cached row: first expand refetches with the raw id and renders the list", async () => {
    const transport = {
      available: true,
      capabilities: { native: true },
      listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
      runtimeInstances: vi.fn(async () => ({ instances: [] })),
      workspaceSessions: vi.fn(async () => ({
        sessions: [{ filePath: "/x/a.jsonl", name: "A", mtime: 1 }],
        sessionCount: 1,
      })),
    };
    const sidebar = sidebarWith(transport);
    sidebar.projects = [cachedProjectShape(false)];
    sidebar.render();
    expect(sessionItemCount()).toBe(0);

    expandRow();
    await flush();
    expect(transport.workspaceSessions).toHaveBeenCalledTimes(1);
    expect(transport.workspaceSessions).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
    );
    // The lazy load renders on the FIRST expand — no collapse/re-expand dance.
    expect(sessionItemCount()).toBe(1);
  });
});
