// ABOUTME: Covers /api/workspace-sessions request validation and response
// assembly: bounded path rules, multi-dirName session merge ordering,
// live-instance and chat-worker decoration parity with the legacy list.

import { describe, expect, test } from "vitest";
import {
  assembleWorkspaceSessions,
  countBucketSessions,
  enumerateProjectJsonlFilePaths,
  validateWorkspaceSessionsTarget,
} from "./embedded-server.ts";

describe("workspace-sessions target validation", () => {
  test("rejects missing, blank, and overlong paths with stable errors", () => {
    expect(validateWorkspaceSessionsTarget(null).error).toBe("path is required");
    expect(validateWorkspaceSessionsTarget(undefined).error).toBe("path is required");
    expect(validateWorkspaceSessionsTarget("").error).toBe("path is required");
    expect(validateWorkspaceSessionsTarget("   ").error).toBe("path is required");
    expect(validateWorkspaceSessionsTarget("x".repeat(4097)).error).toBe("path too long");
  });

  test("trims surrounding whitespace on valid paths", () => {
    const result = validateWorkspaceSessionsTarget("  /users/lin/src  ");
    expect(result.error).toBeNull();
    expect(result.path).toBe("/users/lin/src");
  });
});

describe("workspace-sessions assembly", () => {
  const baseDeps = {
    runningInstances: [],
    chatWorkerStatuses: [],
  };

  test("merges sessions from several historical buckets newest first", async () => {
    const older = { filePath: "/s/old.jsonl", mtime: 100, cwd: "/ws" };
    const newer = { filePath: "/s/new.jsonl", mtime: 900, cwd: "/ws" };
    const newest = { filePath: "/s/newest.jsonl", timestamp: "2030-01-01T00:00:00Z", cwd: "/ws" };
    const response = await assembleWorkspaceSessions({
      canonicalPath: "/ws",
      dirNames: ["bucket-a", "bucket-b"],
      loadSessionsForDir: async (dirName) => (dirName === "bucket-a" ? [older, newer] : [newest]),
      ...baseDeps,
    });

    expect(response.path).toBe("/ws");
    // First bucket keeps deterministic addressing.
    expect(response.dirName).toBe("bucket-a");
    expect(response.sessions.map((session) => session.filePath)).toEqual([
      "/s/newest.jsonl",
      "/s/new.jsonl",
      "/s/old.jsonl",
    ]);
  });

  test("no history returns null dirName with empty sessions", async () => {
    const response = await assembleWorkspaceSessions({
      canonicalPath: "/fresh",
      dirNames: [],
      loadSessionsForDir: async () => {
        throw new Error("must not be called without buckets");
      },
      ...baseDeps,
    });
    expect(response).toEqual({ path: "/fresh", dirName: null, sessions: [] });
  });

  test("unreadable buckets are skipped instead of failing the response", async () => {
    const readable = [{ filePath: "/s/a.jsonl", mtime: 5 }];
    const response = await assembleWorkspaceSessions({
      canonicalPath: "/ws",
      dirNames: ["gone", "kept"],
      loadSessionsForDir: async (dirName) => (dirName === "gone" ? null : readable),
      ...baseDeps,
    });
    expect(response.sessions).toHaveLength(1);
  });

  test("live instances merge into the project like the legacy list does", async () => {
    const response = await assembleWorkspaceSessions({
      canonicalPath: "/ws",
      dirNames: [],
      loadSessionsForDir: async () => [],
      runningInstances: [
        {
          port: 47821,
          pid: 11,
          sessionFile: "/sessions/-ws/live.jsonl",
          cwd: "/ws",
        },
      ],
      chatWorkerStatuses: [],
    });
    // SessionListProject identity is path; the live session joins it even
    // though no historical dirName exists yet.
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].isRunning).toBe(true);
    expect(response.sessions[0].port).toBe(47821);
  });
});

describe("session cache pruning enumeration", () => {
  test("enumerates depth-1 project dirs' jsonl files and skips unreadable dirs", async () => {
    const { mkdtemp, mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");

    const root = await mkdtemp(join(tmpdir(), "picot-prune-"));
    try {
      await mkdir(join(root, "proj-a"));
      await writeFile(join(root, "proj-a", "one.jsonl"), "{}");
      await writeFile(join(root, "proj-a", "two.txt"), "ignored");
      await mkdir(join(root, "proj-a", "nested"));
      await writeFile(join(root, "proj-a", "nested", "deep.jsonl"), "{}");
      await mkdir(join(root, "proj-b"));

      const files = enumerateProjectJsonlFilePaths(root);
      expect(files.has(join(root, "proj-a", "one.jsonl"))).toBe(true);
      expect(files.size).toBe(1);

      await mkdir(join(root, "proj-c"));
      await writeFile(join(root, "proj-c", "x.jsonl"), "{}");
      await chmod(join(root, "proj-c"), 0o000);
      const after = enumerateProjectJsonlFilePaths(root);
      expect(after.has(join(root, "proj-a", "one.jsonl"))).toBe(true);
      await chmod(join(root, "proj-c"), 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SPEC §7.1 response shape", () => {
  test("no-history response is exactly {path, dirName:null, sessions:[]}", async () => {
    const response = await assembleWorkspaceSessions({
      canonicalPath: "/fresh",
      dirNames: [],
      loadSessionsForDir: async () => [],
      runningInstances: [],
      chatWorkerStatuses: [],
    });
    expect(Object.keys(response).sort()).toEqual(["dirName", "path", "sessions"]);
    expect(response.dirName).toBeNull();
    expect(response.sessions).toEqual([]);
  });
});

describe("count mode aggregation", () => {
  test("sums readdir counts across buckets without content reads", async () => {
    const perDir = { a: 3, b: 5, gone: null };
    const response = await countBucketSessions({
      canonicalPath: "/ws",
      dirNames: ["a", "b", "gone"],
      countDirSessions: async (dirName) => perDir[dirName] ?? null,
    });
    expect(response).toEqual({
      path: "/ws",
      dirName: "a",
      sessions: [],
      sessionCount: 8,
    });
  });

  test("no buckets aggregate to zero with null dirName", async () => {
    const response = await countBucketSessions({
      canonicalPath: "/fresh",
      dirNames: [],
      countDirSessions: async () => 0,
    });
    expect(response.sessionCount).toBe(0);
    expect(response.dirName).toBeNull();
  });
});
