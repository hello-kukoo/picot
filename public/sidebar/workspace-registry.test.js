// ABOUTME: Verifies the sidebar's registry data source end-to-end at unit level.
// ABOUTME: Covers registry/live merge identity, lazy per-workspace session loads,
// keyed row reuse, registry-pin bridging, prune toasts, and search scoping.

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { mergeRegistryWorkspaces, registryPinsFromProjects } from "../workspace-projects.js";
import { SessionSidebar } from "./index.js";

const dom = new JSDOM("<!doctype html><html><body><div id='sessions'></div></body></html>", {
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

function makeRegistryTransport(rows, responses = {}) {
  return {
    available: true,
    capabilities: { native: true },
    listWorkspaces: vi.fn(async () => ({
      workspaces: rows,
      removed: responses.removed ?? [],
    })),
    pickFolder: vi.fn(async () => responses.pickedFolder ?? ""),
    addWorkspace: vi.fn(async () => responses.addResult ?? { added: true }),
    removeWorkspace: vi.fn(async () => ({ removed: true })),
    setWorkspacePinned: vi.fn(async () => ({})),
  };
}

async function makeSidebar({
  rows = [],
  transportResponses = {},
  fetchRoutes = {},
  isCurrentWorkspace,
} = {}) {
  const transport = makeRegistryTransport(rows, transportResponses);
  const notices = [];
  const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
    pinStore: {
      getRenderableState: () => ({ workspaces: [] }),
      isWorkspacePinned: () => false,
      subscribe: () => () => {},
    },
    transport,
    onSessionNotice: (message) => notices.push(message),
    isCurrentWorkspace: isCurrentWorkspace ?? (() => false),
  });
  // House pattern: initI18n reads dictionaries through this same stub, so
  // serve the keys this suite asserts on before any API route.
  globalThis.fetch = vi.fn(async (url) => {
    const route = String(url);
    if (route.includes("/locales/")) {
      return {
        ok: true,
        json: async () => ({
          sidebar: {
            workspaceMissingRemoved:
              "Directory missing — removed from the list. Session files were kept.",
            emptyRegistryTitle: "No projects yet",
            emptyRegistryHint: "Add a project to see its sessions here.",
            alreadyRegistered: "This project is already in the list.",
            removeFromList: "Remove from list",
            removedFromList: "Removed from the list; directory and session files were kept.",
            removedFromListStillRunning:
              "Removed from the list; a window is still running — the row disappears once it closes.",
            removeDisabledCurrent: "Cannot remove the current workspace",
          },
        }),
      };
    }
    if (route.startsWith("/api/instances")) {
      return {
        ok: true,
        json: async () => ({ instances: fetchRoutes.instances ?? [] }),
      };
    }
    if (route.startsWith("/api/workspace-sessions")) {
      return {
        ok: true,
        json: async () =>
          fetchRoutes.workspaceSessions?.(new URL(route, "http://localhost")) ?? {
            path: "",
            dirName: null,
            sessions: [],
          },
      };
    }
    if (route.startsWith("/api/search")) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (route.startsWith("/api/sessions")) {
      return { ok: true, json: async () => ({ projects: [] }) };
    }
    throw new Error(`unexpected fetch ${route}`);
  });
  await initI18n();
  return { sidebar, transport, notices };
}

const REGISTRY_ROWS = [
  {
    workspaceId: "uuid-1",
    canonicalPath: "/work/alpha",
    displayName: "alpha",
    pinned: true,
    lastOpenedAt: 500,
  },
  {
    workspaceId: "uuid-2",
    canonicalPath: "/work/beta",
    displayName: "beta",
    pinned: false,
    lastOpenedAt: 900,
  },
];

describe("registry/live merging", () => {
  test("preserves SQL order and assigns stable ws identities", () => {
    const { projects } = mergeRegistryWorkspaces(REGISTRY_ROWS, [], []);
    expect(projects.map((project) => project.workspaceId)).toEqual(["ws:uuid-1", "ws:uuid-2"]);
    expect(projects[0].pinned).toBe(true);
    expect(projects[0].source).toBe("registry");
    expect(projects[0].dirName).toBeNull();
  });

  test("live instances join registered paths; strays become provisional rows", () => {
    const instances = [
      { cwd: "/work/beta", port: 1 },
      { cwd: "/tmp/unregistered", port: 2 },
    ];
    const { projects } = mergeRegistryWorkspaces(REGISTRY_ROWS, instances, []);
    expect(projects).toHaveLength(3);
    // Instances attach to their registered path (beta), not the first row.
    const beta = projects.find((project) => project.workspaceId === "ws:uuid-2");
    expect(beta.runningInstances).toHaveLength(1);
    const alpha = projects.find((project) => project.workspaceId === "ws:uuid-1");
    expect(alpha.runningInstances).toHaveLength(0);
    const stray = projects.find((project) => project.path === "/tmp/unregistered");
    expect(stray.isProvisional).toBe(true);
    expect(stray.source).toBe("live");
  });

  test("provisional ids reconcile into ws identities carrying prior state keys", () => {
    const previous = [
      {
        workspaceId: "path:/work/alpha",
        path: "/work/alpha",
        isProvisional: true,
      },
    ];
    const { projects, reconciliations } = mergeRegistryWorkspaces([REGISTRY_ROWS[0]], [], previous);
    expect(reconciliations).toEqual([
      { fromId: "path:/work/alpha", toId: "ws:uuid-1", path: "/work/alpha" },
    ]);
    expect(projects[0].workspaceId).toBe("ws:uuid-1");
  });

  test("registry pins bridge into the unified pinned view", () => {
    const { projects } = mergeRegistryWorkspaces(REGISTRY_ROWS, [], []);
    expect(registryPinsFromProjects(projects)).toEqual([{ id: "ws:uuid-1", path: "/work/alpha" }]);
  });
});

describe("registry-backed sidebar loading", () => {
  let previousFetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("loads rows, surfaces prune toast, and refreshes synchronously enough", async () => {
    const { sidebar, transport, notices } = await makeSidebar({
      rows: REGISTRY_ROWS,
      transportResponses: { removed: [{ workspaceId: "gone", path: "/ghost" }] },
      fetchRoutes: { instances: [] },
    });
    await sidebar.loadSessions();

    expect(transport.listWorkspaces).toHaveBeenCalled();
    expect(sidebar.projects.map((project) => project.workspaceId)).toEqual([
      "ws:uuid-1",
      "ws:uuid-2",
    ]);
    expect(notices).toContain(
      "Directory missing — removed from the list. Session files were kept.",
    );
  });

  test("expanding a registry row lazily fetches only that path once", async () => {
    const sessionsPayload = [{ filePath: "/sessions/a.jsonl", name: "A" }];
    const { sidebar } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: {
        instances: [],
        workspaceSessions: (url) => {
          expect(url.searchParams.get("path")).toBe("/work/alpha");
          return { path: "/work/alpha", dirName: "-work-alpha", sessions: sessionsPayload };
        },
      },
    });
    await sidebar.loadSessions();
    await sidebar.setWorkspaceExpanded(sidebar.projects[0], true);
    // allow the promise chain started inside setWorkspaceExpanded
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");
    expect(alpha.sessions).toEqual(sessionsPayload);
    const callsAfterFirst = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/workspace-sessions"),
    );
    expect(callsAfterFirst).toHaveLength(1);

    // Second expand serves from cache without a new request.
    sidebar.setWorkspaceExpanded(alpha, false);
    await sidebar.setWorkspaceExpanded(alpha, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsAfterSecond = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/workspace-sessions"),
    );
    expect(callsAfterSecond.length).toBe(1);

    // Invalidation drops exactly one cache entry so the next expand refetches.
    sidebar.invalidateWorkspaceSessions("/work/alpha");
    await sidebar.ensureWorkspaceSessions(alpha);
    const callsAfterInvalidate = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/workspace-sessions"),
    );
    expect(callsAfterInvalidate.length).toBe(2);
  });

  test("full-text search scopes requests to listed project paths", async () => {
    const { sidebar } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: { instances: [] },
    });
    await sidebar.loadSessions();
    // The production flow goes through setSearchQuery's debounce; replicate
    // its post-debounce state without waiting on timers.
    sidebar.searchQuery = "needle";
    await sidebar.fullTextSearch("needle");
    const searchCalls = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/search"),
    );
    expect(searchCalls).toHaveLength(1);
    const requestedUrl = new URL(searchCalls[0][0], "http://localhost");
    expect(requestedUrl.searchParams.get("q")).toBe("needle");
    expect(JSON.parse(requestedUrl.searchParams.get("paths"))).toEqual([
      "/work/alpha",
      "/work/beta",
    ]);
  });
});

describe("keyed row reuse", () => {
  let previousFetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("unchanged rows keep their DOM node across refresh renders", async () => {
    const { sidebar } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: { instances: [] },
    });
    await sidebar.loadSessions();
    const firstNode = sidebar.projectRowNode(
      sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2"),
      null,
    ).group;

    const refreshed = sidebar.projectRowNode(
      sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2"),
      null,
    );
    expect(refreshed.group).toBe(firstNode);

    // Mutating visible data changes the signature and forces a rebuild.
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");
    beta.sessions.push({ filePath: "/sessions/new.jsonl", mtime: 12345 });
    const rebuilt = sidebar.projectRowNode(beta, null);
    expect(rebuilt.group).not.toBe(firstNode);
  });
});

describe("add / remove / pin registry flows", () => {
  let previousFetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("addProjectViaPicker registers, reloads, and expands the new row", async () => {
    const rows = [];
    const { sidebar, transport } = await makeSidebar({
      get rows() {
        return rows;
      },
    });
    transport.pickFolder.mockResolvedValue("/work/gamma");
    transport.addWorkspace.mockResolvedValue({
      added: true,
      workspace: { workspaceId: "uuid-3", canonicalPath: "/work/gamma" },
    });
    // Reload serves both original rows plus the freshly added one.
    transport.listWorkspaces.mockImplementation(async () => ({
      workspaces: [
        ...REGISTRY_ROWS,
        {
          workspaceId: "uuid-3",
          canonicalPath: "/work/gamma",
          displayName: "gamma",
          pinned: false,
          lastOpenedAt: null,
        },
      ],
      removed: [],
    }));

    await sidebar.addProjectViaPicker();

    expect(transport.addWorkspace).toHaveBeenCalledWith("/work/gamma");
    const gamma = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-3");
    expect(gamma).toBeTruthy();
    expect(sidebar.expandedWorkspaces.has("ws:uuid-3")).toBe(true);
  });

  test("re-adding an existing project shows alreadyRegistered without error", async () => {
    const { sidebar, transport, notices } = await makeSidebar({ rows: REGISTRY_ROWS });
    transport.pickFolder.mockResolvedValue("/work/alpha");
    transport.addWorkspace.mockResolvedValue({
      added: false,
      workspace: { workspaceId: "uuid-1", canonicalPath: "/work/alpha" },
    });

    await sidebar.addProjectViaPicker();

    expect(notices).toContain("This project is already in the list.");
  });

  test("removeFromList only deletes the DB row and keeps expansion clean", async () => {
    const { sidebar, transport } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: { instances: [] },
    });
    await sidebar.loadSessions();
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");
    sidebar.expandedWorkspaces.add(beta.workspaceId);
    // After the DB delete, the next registry read no longer carries beta.
    transport.listWorkspaces.mockImplementation(async () => ({
      workspaces: [REGISTRY_ROWS[0]],
      removed: [],
    }));

    const deleteBatchCalls = () =>
      globalThis.fetch.mock.calls.filter(([url]) => String(url).includes("delete-batch"));

    await sidebar.removeFromList(beta);

    expect(transport.removeWorkspace).toHaveBeenCalledWith("uuid-2");
    expect(deleteBatchCalls()).toHaveLength(0);
    expect(sidebar.projects.some((project) => project.workspaceId === "ws:uuid-2")).toBe(false);
  });

  test("removeFromList with a running window keeps its live row and says so in the toast", async () => {
    const runningOnBeta = {
      port: 49160,
      pid: 4242,
      cwd: "/work/beta",
      startedAt: "2026-08-28T04:00:00.000Z",
      sessionFile: "/pi/sessions/--work-beta--/2026-08-28T04-00-00-000Z_live.jsonl",
    };
    const { sidebar, transport, notices } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: { instances: [runningOnBeta] },
    });
    await sidebar.loadSessions();
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");
    transport.listWorkspaces.mockImplementation(async () => ({
      workspaces: [REGISTRY_ROWS[0]],
      removed: [],
    }));

    await sidebar.removeFromList(beta);

    expect(transport.removeWorkspace).toHaveBeenCalledWith("uuid-2");
    // The live row survives (by design) and now renders its running session.
    const liveRow = sidebar.projects.find((project) => project.source === "live");
    expect(liveRow?.path).toBe("/work/beta");
    expect(liveRow?.sessions.some((session) => session.isRunning)).toBe(true);
    expect(notices).toContain(
      "Removed from the list; a window is still running — the row disappears once it closes.",
    );
  });

  test("the current workspace cannot be removed from the list", async () => {
    const { sidebar, transport, notices } = await makeSidebar({
      rows: REGISTRY_ROWS,
      isCurrentWorkspace: (project) => project?.path === "/work/beta",
    });
    await sidebar.loadSessions();
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");

    const event = new window.MouseEvent("contextmenu", { bubbles: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    sidebar.showWorkspaceContextMenu(event, beta);
    const removeItem = [...document.querySelectorAll(".context-menu-item")].find((button) =>
      button.textContent.includes("Remove from list"),
    );
    expect(removeItem.disabled).toBe(true);
    expect(removeItem.title).toBe("Cannot remove the current workspace");
    sidebar.closeContextMenu();

    // Defensive guard: even a direct call must not reach the DB.
    await sidebar.removeFromList(beta);
    expect(transport.removeWorkspace).not.toHaveBeenCalled();
    expect(notices).toContain("Cannot remove the current workspace");
  });

  test("a non-current workspace stays removable even while another window runs there", async () => {
    const { sidebar } = await makeSidebar({ rows: REGISTRY_ROWS });
    await sidebar.loadSessions();
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");

    const event = new window.MouseEvent("contextmenu", { bubbles: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    sidebar.showWorkspaceContextMenu(event, beta);
    const removeItem = [...document.querySelectorAll(".context-menu-item")].find((button) =>
      button.textContent.includes("Remove from list"),
    );
    expect(removeItem.disabled).toBe(false);
    sidebar.closeContextMenu();
  });

  test("registry pin toggles go through transport and refresh order", async () => {
    const { sidebar, transport } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: { instances: [] },
    });
    await sidebar.loadSessions();
    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");

    await sidebar.toggleWorkspacePin(alpha, true);

    expect(transport.setWorkspacePinned).toHaveBeenCalledWith("uuid-1", false);
    void alpha;
  });
});

describe("registry cache invalidation wiring", () => {
  let previousFetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  const ALPHA_SESSIONS = [
    { filePath: "/sessions/a.jsonl", name: "A" },
    { filePath: "/sessions/b.jsonl", name: "B" },
  ];

  // Server-side state shared by the delete-batch route and the per-workspace
  // list route, so a refetch genuinely observes earlier deletions.
  async function makeRegistrySidebar({ sessionsForPath } = {}) {
    const deleted = new Set();
    const { sidebar } = await makeSidebar({
      rows: REGISTRY_ROWS,
      fetchRoutes: {
        instances: [],
        workspaceSessions: (url) => {
          const path = url.searchParams.get("path");
          const sessions = sessionsForPath
            ? sessionsForPath(path)
            : path === "/work/alpha"
              ? ALPHA_SESSIONS
              : [];
          return {
            path,
            dirName: path === "/work/alpha" ? "-work-alpha" : null,
            sessions: sessions.filter((session) => !deleted.has(session.filePath)),
          };
        },
      },
    });
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/api/sessions/delete-batch")) {
        for (const filePath of JSON.parse(init?.body ?? "{}").filePaths ?? []) {
          deleted.add(filePath);
        }
        return { ok: true, json: async () => ({ deleted: 0, errors: [], running: [] }) };
      }
      return baseFetch(url, init);
    });
    return { sidebar };
  }

  const settleFetches = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const workspaceSessionsCalls = () =>
    globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/workspace-sessions"),
    );

  test("deleteSession drops the owning workspace's cache so deleted files do not return as ghosts", async () => {
    const { sidebar } = await makeRegistrySidebar();
    await sidebar.loadSessions();
    await sidebar.setWorkspaceExpanded(
      sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1"),
      true,
    );
    await settleFetches();
    sidebar.showFallbackConfirmDialog = vi.fn(async () => true);

    await sidebar.deleteSession("/sessions/a.jsonl");
    await settleFetches();

    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");
    expect(alpha.sessions.some((session) => session.filePath === "/sessions/a.jsonl")).toBe(false);
    expect(alpha.sessions.map((session) => session.filePath)).toEqual(["/sessions/b.jsonl"]);
    expect(
      workspaceSessionsCalls().filter(([url]) => String(url).includes("alpha")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("deleteWorkspaceSessions invalidates that workspace's cache entry", async () => {
    const { sidebar } = await makeRegistrySidebar();
    await sidebar.loadSessions();
    await sidebar.setWorkspaceExpanded(
      sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1"),
      true,
    );
    await settleFetches();
    sidebar.confirmWorkspaceDeletion = vi.fn(async () => true);
    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");

    await sidebar.deleteWorkspaceSessions(alpha);
    await settleFetches();

    const alphaAfter = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");
    // Both files were deleted server-side; the reload must not resurrect them
    // from the stale cache (ghost entries).
    expect(alphaAfter.sessions).toEqual([]);
    expect(
      workspaceSessionsCalls().filter(([url]) => String(url).includes("alpha")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("refreshWorkspaceSessions refetches an expanded cached row and awaits the result", async () => {
    const { sidebar } = await makeRegistrySidebar();
    await sidebar.loadSessions();
    await sidebar.setWorkspaceExpanded(
      sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1"),
      true,
    );
    await settleFetches();

    await sidebar.refreshWorkspaceSessions("/work/alpha");

    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");
    expect(alpha.sessions.map((session) => session.name)).toEqual(["A", "B"]);
    expect(workspaceSessionsCalls().filter(([url]) => String(url).includes("alpha"))).toHaveLength(
      2,
    );
  });

  test("refreshWorkspaceSessions on a collapsed row drops the cache without fetching", async () => {
    const { sidebar } = await makeRegistrySidebar();
    await sidebar.loadSessions();
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");
    await sidebar.setWorkspaceExpanded(beta, true);
    await settleFetches();
    await sidebar.setWorkspaceExpanded(beta, false);
    expect(sidebar.workspaceSessionsCache.has("/work/beta")).toBe(true);

    await sidebar.refreshWorkspaceSessions("/work/beta");

    expect(sidebar.workspaceSessionsCache.has("/work/beta")).toBe(false);
    expect(workspaceSessionsCalls().filter(([url]) => String(url).includes("beta"))).toHaveLength(
      1,
    );
  });

  test("refreshAllWorkspaces refetches expanded rows and leaves collapsed caches in place", async () => {
    const { sidebar } = await makeRegistrySidebar();
    await sidebar.loadSessions();
    const alpha = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-1");
    const beta = sidebar.projects.find((project) => project.workspaceId === "ws:uuid-2");
    await sidebar.setWorkspaceExpanded(alpha, true);
    await settleFetches();
    // Seed beta's cache, then collapse it: refresh must not touch it.
    await sidebar.setWorkspaceExpanded(beta, true);
    await settleFetches();
    await sidebar.setWorkspaceExpanded(beta, false);

    await sidebar.refreshAllWorkspaces();
    await settleFetches();

    expect(workspaceSessionsCalls().filter(([url]) => String(url).includes("alpha"))).toHaveLength(
      2,
    );
    expect(workspaceSessionsCalls().filter(([url]) => String(url).includes("beta"))).toHaveLength(
      1,
    );
    expect(sidebar.workspaceSessionsCache.has("/work/beta")).toBe(true);
    expect(sidebar.workspaceSessionsCache.has("/work/alpha")).toBe(true);
  });
});

describe("full warmup", () => {
  let previousFetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    vi.useRealTimers();
  });

  test("details are warmed for every registry row, not just the first few", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 6 }, (_, i) => ({
      workspaceId: `uuid-${i}`,
      canonicalPath: `/work/w${i}`,
      displayName: `w${i}`,
      pinned: false,
      lastOpenedAt: null,
    }));
    const { sidebar } = await makeSidebar({ rows, fetchRoutes: { instances: [] } });
    await sidebar.loadSessions({ quiet: true });

    const detailCallsFor = () =>
      globalThis.fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/workspace-sessions"),
      );

    // Advance past the idle fallback timer and drain the serial warm chain.
    await vi.advanceTimersByTimeAsync(900);

    const calls = detailCallsFor();
    expect(calls.length).toBeGreaterThanOrEqual(rows.length);
    for (const row of rows) {
      expect(
        calls.some(([url]) =>
          String(url).includes(`path=${encodeURIComponent(row.canonicalPath)}`),
        ),
      ).toBe(true);
    }
  });
});
