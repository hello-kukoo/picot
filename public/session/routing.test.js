// ABOUTME: Unit tests for session-port routing, mirror-sync scoping, and workspace transitions.
// ABOUTME: Verifies deferral and suppression logic during cross-workspace session switches.

import { describe, expect, test } from "vitest";
import * as sessionRouting from "./routing.js";

test("defers a cross-workspace file tree load until the selected session is confirmed", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(
    "/history/new.jsonl",
    "/work/new",
    "/work/old",
  );

  expect(pending).toEqual({ sessionFile: "/history/new.jsonl", path: "/work/new" });
  expect(
    sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/history/old.jsonl"),
  ).toBeNull();
  expect(sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/history/new.jsonl")).toEqual(
    pending,
  );
});

test("does not defer an already-loaded workspace or one without a project path", () => {
  expect(
    sessionRouting.deferFileBrowserWorkspace(
      "/history/current.jsonl",
      "/work/current",
      "/work/current",
    ),
  ).toBeNull();
  expect(
    sessionRouting.deferFileBrowserWorkspace("/history/new.jsonl", "", "/work/old"),
  ).toBeNull();
});

test("defers a new-session activation with no sessionFile yet", () => {
  // A brand-new session's .jsonl isn't assigned until pi's first session_start,
  // so activateNewParallelSession defers with a null sessionFile. Confirmation
  // then matches any foreground mirror_sync (the caller gates on foreground port).
  const pending = sessionRouting.deferFileBrowserWorkspace(null, "/work/new", "/work/old");
  expect(pending).toEqual({ sessionFile: null, path: "/work/new" });
  expect(
    sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/work/new-session.jsonl"),
  ).toBe(pending);
});

test("suppresses file browser loads while a cross-workspace switch is pending", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(
    "/history/new.jsonl",
    "/work/new",
    "/work/old",
  );
  expect(sessionRouting.shouldSuppressFileBrowserLoad(pending)).toBe(true);
});

test("suppresses file browser loads during a new-session activation", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(null, "/work/new", "/work/old");
  expect(sessionRouting.shouldSuppressFileBrowserLoad(pending)).toBe(true);
});

test("does not suppress file browser loads without a pending switch", () => {
  expect(sessionRouting.shouldSuppressFileBrowserLoad(null)).toBe(false);
  // Same-workspace select produces no pending token — loads proceed normally.
  const sameWorkspace = sessionRouting.deferFileBrowserWorkspace(
    "/history/current.jsonl",
    "/work/current",
    "/work/current",
  );
  expect(sessionRouting.shouldSuppressFileBrowserLoad(sameWorkspace)).toBe(false);
});

describe("shouldSuppressFileBrowserRefresh", () => {
  test("suppresses refresh while a cross-workspace switch is pending", () => {
    const pending = sessionRouting.deferFileBrowserWorkspace(
      "/history/new.jsonl",
      "/work/new",
      "/work/old",
    );
    expect(
      sessionRouting.shouldSuppressFileBrowserRefresh({
        pendingWorkspace: pending,
        currentWorkspacePath: "/work/new",
        fileBrowserWorkspacePath: "/work/old",
      }),
    ).toBe(true);
  });

  test("suppresses refresh when current workspace path diverges from loaded file browser path", () => {
    expect(
      sessionRouting.shouldSuppressFileBrowserRefresh({
        pendingWorkspace: null,
        currentWorkspacePath: "/work/new",
        fileBrowserWorkspacePath: "/work/old",
      }),
    ).toBe(true);
  });

  test("allows refresh when workspaces and ports match with no pending switch", () => {
    expect(
      sessionRouting.shouldSuppressFileBrowserRefresh({
        pendingWorkspace: null,
        currentWorkspacePath: "/work/same",
        fileBrowserWorkspacePath: "/work/same",
      }),
    ).toBe(false);
  });

  test("allows refresh when paths or ports are uninitialized / null", () => {
    expect(
      sessionRouting.shouldSuppressFileBrowserRefresh({
        pendingWorkspace: null,
        currentWorkspacePath: "/work/same",
        fileBrowserWorkspacePath: null,
      }),
    ).toBe(false);
  });
});
