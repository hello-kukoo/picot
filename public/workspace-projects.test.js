// ABOUTME: Verifies registry/live workspace merge, pin-group resolution, and
// ABOUTME: path normalization helpers after the legacy history-list retirement.
import { describe, expect, test } from "vitest";
import {
  mergeRegistryWorkspaces,
  normalizeWorkspacePath,
  provisionalWorkspaceId,
  registryPinsFromProjects,
  resolvePinnedWorkspaceGroups,
  workspacePathKey,
} from "./workspace-projects.js";

test("normalizes conservative absolute paths", () => {
  expect(normalizeWorkspacePath("/Users/Lin/Picot")).toBe("/Users/Lin/Picot");
  expect(normalizeWorkspacePath("relative/path")).toBe("");
});

test("extracts Windows workspace folder names through live-merge keying", () => {
  // The Windows cwd still keys by path so a registered C:\\ workspace can
  // adopt its live instances.
  const result = mergeRegistryWorkspaces([], [{ cwd: "C:\\Users\\Lin\\Picot", startedAt: "" }], []);
  expect(result.projects[0].path).toContain("Picot");
});

const ROWS = [
  {
    workspaceId: "uuid-a",
    canonicalPath: "/work/a",
    displayName: "a",
    pinned: true,
    lastOpenedAt: 500,
  },
  {
    workspaceId: "uuid-b",
    canonicalPath: "/work/b",
    displayName: null,
    pinned: false,
    lastOpenedAt: 900,
  },
];

describe("mergeRegistryWorkspaces", () => {
  test("preserves SQL order and assigns ws identities with metadata", () => {
    const { projects } = mergeRegistryWorkspaces(ROWS, [], []);
    expect(projects.map((project) => project.workspaceId)).toEqual(["ws:uuid-a", "ws:uuid-b"]);
    expect(projects[0].pinned).toBe(true);
    expect(projects[0].source).toBe("registry");
    expect(projects[0].folderName).toBe("a"); // explicit displayName wins
    expect(projects[1].folderName).toBe("b"); // basename fallback
    expect(provisionalWorkspaceId("/work/x")).toBe("path:/work/x");
  });

  test("live instances attach to registered paths; strays become provisional rows", () => {
    const instances = [
      { cwd: "/work/b", port: 1 },
      { cwd: "/tmp/stray", port: 2 },
    ];
    const { projects } = mergeRegistryWorkspaces(ROWS, instances, []);
    expect(
      projects.find((project) => project.workspaceId === "ws:uuid-b").runningInstances,
    ).toHaveLength(1);
    const stray = projects.find((project) => project.path === "/tmp/stray");
    expect(stray.isProvisional).toBe(true);
    expect(stray.source).toBe("live");
  });

  test("reconciles provisional ids to registered ones without duplicates", () => {
    const previous = [{ workspaceId: "path:/work/a", path: "/work/a", isProvisional: true }];
    const { projects, reconciliations } = mergeRegistryWorkspaces([ROWS[0]], [], previous);
    expect(reconciliations).toEqual([
      { fromId: "path:/work/a", toId: "ws:uuid-a", path: "/work/a" },
    ]);
    expect(projects.filter((project) => project.path === "/work/a")).toHaveLength(1);
  });
});

const INSTANCE = {
  port: 49152,
  pid: 1234,
  sessionFile: "/home/u/.pi/agent/sessions/--work-live--/2026-08-28T00-00-00-000Z_run.jsonl",
  cwd: "/work/live",
  startedAt: "2026-08-28T00:00:00.000Z",
};

describe("live instance session rendering", () => {
  test("unregistered live windows render their running session instead of an empty 0-count row", () => {
    const { projects } = mergeRegistryWorkspaces([], [INSTANCE], []);
    expect(projects).toHaveLength(1);
    const row = projects[0];
    expect(row.source).toBe("live");
    expect(row.dirName).toBe("--work-live--");
    expect(row.sessions).toHaveLength(1);
    const session = row.sessions[0];
    expect(session.filePath).toBe(INSTANCE.sessionFile);
    expect(session.file).toBe("2026-08-28T00-00-00-000Z_run.jsonl");
    expect(session.isRunning).toBe(true);
    expect(session.port).toBe(49152);
    expect(session.mtime).toBe(new Date(INSTANCE.startedAt).getTime());
  });

  test("registered rows adopt running instances before lazy history loads and derive the bucket name", () => {
    const rows = [
      {
        workspaceId: "uuid-live",
        canonicalPath: "/work/live",
        displayName: null,
        pinned: false,
        lastOpenedAt: 0,
      },
    ];
    const { projects } = mergeRegistryWorkspaces(rows, [INSTANCE], []);
    const row = projects[0];
    expect(row.source).toBe("registry");
    expect(row.dirName).toBe("--work-live--");
    expect(row.sessions.map((s) => s.isRunning)).toEqual([true]);
  });

  test("instances without a session file are skipped and existing sessions are not duplicated", () => {
    const bare = { port: 1, pid: 2, cwd: "/work/bare", startedAt: "" };
    const { projects } = mergeRegistryWorkspaces([], [bare, INSTANCE], []);
    // A session-file-less instance still owns its live row, but contributes
    // no session items to it.
    expect(projects).toHaveLength(2);
    const bareRow = projects.find((p) => p.path === "/work/bare");
    expect(bareRow.sessions).toHaveLength(0);
    expect(projects.find((p) => p.path === "/work/live").sessions).toHaveLength(1);

    const rows = [
      {
        workspaceId: "uuid-dup",
        canonicalPath: "/work/live",
        displayName: null,
        pinned: false,
        lastOpenedAt: 0,
      },
    ];
    const preloaded = mergeRegistryWorkspaces(rows, [INSTANCE], []);
    preloaded.projects[0].sessions = [
      ...preloaded.projects[0].sessions,
      { filePath: INSTANCE.sessionFile, isRunning: true, port: INSTANCE.port },
    ];
    // A later merge against already-populated sessions dedupes by filePath.
    const remerged = mergeRegistryWorkspaces(rows, [INSTANCE], preloaded.projects);
    const liveRow = remerged.projects[0];
    expect(liveRow.sessions.filter((s) => s.filePath === INSTANCE.sessionFile)).toHaveLength(1);
  });

  test("windows-style session file paths derive the same bucket dirName", () => {
    const winInstance = {
      ...INSTANCE,
      sessionFile: "C:\\pi\\sessions\\--work-live--\\2026-08-28T00-00-00-000Z_run.jsonl",
    };
    const { projects } = mergeRegistryWorkspaces([], [winInstance], []);
    expect(projects[0].dirName).toBe("--work-live--");
    expect(projects[0].sessions[0].file).toBe("2026-08-28T00-00-00-000Z_run.jsonl");
  });
});

describe("registry pin bridge", () => {
  test("registryPinsFromProjects selects pinned registry rows only", () => {
    const { projects } = mergeRegistryWorkspaces(ROWS, [], []);
    expect(registryPinsFromProjects(projects)).toEqual([{ id: "ws:uuid-a", path: "/work/a" }]);
  });

  test("resolves workspace pins against merged projects by id or path", () => {
    const { projects } = mergeRegistryWorkspaces(ROWS, [], []);
    const groups = resolvePinnedWorkspaceGroups({
      pinState: { workspaces: [{ id: "ws:uuid-a", path: "/work/a" }] },
      projects,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace.workspaceId).toBe("ws:uuid-a");
    expect(groups[0].unavailable).toBe(false);

    const missing = resolvePinnedWorkspaceGroups({
      pinState: { workspaces: [{ id: "ws:ghost", path: "/ghost" }] },
      projects,
    });
    expect(missing[0].unavailable).toBe(true);
  });

  test("path-key matching still resolves legacy-shaped pins onto new rows", () => {
    const { projects } = mergeRegistryWorkspaces(ROWS, [], []);
    const groups = resolvePinnedWorkspaceGroups({
      pinState: { workspaces: [{ id: "history:a", path: "/work/a" }] },
      projects,
    });
    // Path-key fallback owns the row even when the old cookie id differs.
    expect(groups[0].workspace.workspaceId).toBe("ws:uuid-a");
    void workspacePathKey;
  });
});
