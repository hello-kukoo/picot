// ABOUTME: Tests the cross-workspace refresh gating predicate (v3 e2567dd semantics).
// ABOUTME: Covers pending transitions, workspace mismatches, and matching pass-through.

import { describe, expect, it } from "vitest";
import { shouldSuppressFileBrowserRefresh } from "./file-browser-refresh-guard.js";

describe("shouldSuppressFileBrowserRefresh", () => {
  it("suppresses while a cross-workspace transition is pending", () => {
    expect(
      shouldSuppressFileBrowserRefresh({
        pendingWorkspaceId: "workspace-b",
        currentWorkspaceId: "workspace-a",
        fileBrowserWorkspaceId: "workspace-a",
      }),
    ).toBe(true);
    // Pending alone is enough, even when ids happen to line up.
    expect(
      shouldSuppressFileBrowserRefresh({
        pendingWorkspaceId: "",
        currentWorkspaceId: "workspace-a",
        fileBrowserWorkspaceId: "workspace-a",
      }),
    ).toBe(true);
  });

  it("suppresses when the loaded listing belongs to another workspace", () => {
    expect(
      shouldSuppressFileBrowserRefresh({
        currentWorkspaceId: "workspace-b",
        fileBrowserWorkspaceId: "workspace-a",
      }),
    ).toBe(true);
  });

  it("allows a matching workspace", () => {
    expect(
      shouldSuppressFileBrowserRefresh({
        currentWorkspaceId: "workspace-a",
        fileBrowserWorkspaceId: "workspace-a",
      }),
    ).toBe(false);
  });

  it("never suppresses on its own when the listing was never loaded", () => {
    expect(
      shouldSuppressFileBrowserRefresh({
        currentWorkspaceId: "workspace-a",
        fileBrowserWorkspaceId: null,
      }),
    ).toBe(false);
  });
});
