// ABOUTME: Verifies sidebar refresh runs only while a new Pi session lacks a persisted file.
// ABOUTME: Prevents collapsed session lists from causing refresh churn during normal turns.

import { describe, expect, test } from "vitest";
import {
  shouldRefreshSidebarForNewSession,
  shouldShowProvisionalSession,
} from "./new-session-refresh.js";

describe("shouldShowProvisionalSession", () => {
  test("requires a complete runtime target", () => {
    expect(shouldShowProvisionalSession({ runtimeTarget: null })).toBe(false);
    expect(shouldShowProvisionalSession({ runtimeTarget: { workspaceId: "workspace" } })).toBe(
      false,
    );
    expect(shouldShowProvisionalSession({ runtimeTarget: { sessionId: "session" } })).toBe(false);
  });

  test("shows a provisional row for a complete runtime target", () => {
    expect(
      shouldShowProvisionalSession({
        runtimeTarget: { workspaceId: "workspace", sessionId: "session" },
      }),
    ).toBe(true);
  });
});

describe("shouldRefreshSidebarForNewSession", () => {
  test("does not refresh a normal turn when Pi already reports its session file", () => {
    expect(
      shouldRefreshSidebarForNewSession({ mirrorActiveSessionFile: "/sessions/current.jsonl" }),
    ).toBe(false);
  });

  test("refreshes until a new runtime has persisted its first session file", () => {
    expect(shouldRefreshSidebarForNewSession({ mirrorActiveSessionFile: null })).toBe(true);
  });
});
