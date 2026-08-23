// @vitest-environment node
// ABOUTME: Verifies restricted workspace lookup and bounded Git metadata inspection.
// ABOUTME: Protects remote parsing, repository classification, and detached-head handling.
import { describe, expect, it } from "vitest";
import {
  inspectWorkspaceGit,
  observeWorkspaceInfoAbort,
  parseRepositoryName,
  resolveWorkspaceInfoPath,
} from "./workspace-info.ts";

describe("workspace info", () => {
  it("resolves only known IDs", () => {
    expect(resolveWorkspaceInfoPath("history:a", [{ dirName: "a", path: "/work/a" }], [])).toBe(
      "/work/a",
    );
    expect(resolveWorkspaceInfoPath("path:/work/live", [], [{ cwd: "/work/live" }])).toBe(
      "/work/live",
    );
    expect(resolveWorkspaceInfoPath("/etc", [], [])).toBeNull();
  });
  it("resolves the server-broadcast workspace: id against running instances", () => {
    // mirror_sync payloads carry `workspace:<cwd>` (embedded-server withRouteMeta);
    // /api/workspace-info must resolve its own broadcast ids or the frontend
    // Git-entry probe 404s and never hides the tab proactively.
    expect(resolveWorkspaceInfoPath("workspace:/work/live", [], [{ cwd: "/work/live" }])).toBe(
      "/work/live",
    );
    // Same guard as path:: only registered instance cwds resolve.
    expect(resolveWorkspaceInfoPath("workspace:/etc", [], [{ cwd: "/work/live" }])).toBeNull();
  });
  it("parses supported remotes", () => {
    expect(parseRepositoryName("https://github.com/owner/repo.git", "/work/repo")).toBe(
      "owner/repo",
    );
    expect(parseRepositoryName("ssh://git@github.com/owner/repo.git", "/work/repo")).toBe(
      "owner/repo",
    );
    expect(parseRepositoryName("git@github.com:owner/repo.git", "/work/repo")).toBe("owner/repo");
  });
  it("returns an explicit unavailable result when git cannot be spawned", async () => {
    const error = Object.assign(new Error("git not found"), { code: "ENOENT" });
    const runGit = async () => {
      throw error;
    };

    await expect(inspectWorkspaceGit("/work/repo", { runGit })).resolves.toEqual({
      isGit: false,
      gitAvailable: false,
      errorCode: "git_not_found",
    });
  });

  it("classifies ENOENT from a later Git metadata command as unavailable", async () => {
    const error = Object.assign(new Error("git disappeared"), { code: "ENOENT" });
    const runGit = async (args: string[]) => {
      if (args.includes("show-toplevel")) return { stdout: "/work/repo\n" };
      throw error;
    };

    await expect(inspectWorkspaceGit("/work/repo", { runGit })).resolves.toEqual({
      isGit: false,
      gitAvailable: false,
      errorCode: "git_not_found",
    });
  });

  it("keeps non-ENOENT Git failures as ordinary non-repository results", async () => {
    const runGit = async () => {
      throw new Error("permission denied");
    };

    await expect(inspectWorkspaceGit("/work/repo", { runGit })).resolves.toEqual({
      isGit: false,
    });
  });

  it("returns bounded structured Git data from injected runner", async () => {
    const runGit = async (args: string[]) => {
      const command = args.join(" ");
      const stdout = command.includes("show-toplevel")
        ? "/work/repo\n"
        : command.includes("git-dir")
          ? ".git\n"
          : command.includes("git-common-dir")
            ? ".git\n"
            : command.includes("symbolic-ref")
              ? "main\n"
              : command.includes("remote get-url")
                ? "https://github.com/owner/repo.git\n"
                : command === "remote"
                  ? "origin\n"
                  : "abc123\n";
      return { stdout };
    };
    const info = await inspectWorkspaceGit("/work/repo", { runGit });
    expect(info).toMatchObject({
      isGit: true,
      repository: "owner/repo",
      kind: "repository",
      branch: "main",
    });
  });
  it("observes Fetch request cancellation without Node event methods", () => {
    const request = new AbortController();
    const operation = new AbortController();
    const cleanup = observeWorkspaceInfoAbort(operation, { signal: request.signal }, {});

    request.abort();

    expect(operation.signal.aborted).toBe(true);
    cleanup();
  });

  it("aborts immediately when a Fetch request is already cancelled", () => {
    const request = new AbortController();
    request.abort();
    const operation = new AbortController();

    const cleanup = observeWorkspaceInfoAbort(operation, { signal: request.signal }, {});

    expect(operation.signal.aborted).toBe(true);
    cleanup();
  });
});
