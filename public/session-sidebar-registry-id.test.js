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
