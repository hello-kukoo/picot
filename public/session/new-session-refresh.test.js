// ABOUTME: Verifies sidebar refresh runs only while a new Pi session lacks a persisted file.
// ABOUTME: Prevents collapsed session lists from causing refresh churn during normal turns.

import { describe, expect, test } from "vitest";
import { shouldRefreshSidebarForNewSession } from "./new-session-refresh.js";

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
