// ABOUTME: Verifies native in-place session selection resolves only its prepared runtime target.
// ABOUTME: Prevents same-workspace navigation from adopting an unrelated live session.

import { describe, expect, test } from "vitest";
import { resolvePreparedRuntimeTarget } from "./in-place-runtime-target.js";

describe("resolvePreparedRuntimeTarget", () => {
  test("selects the exact runtime returned by same-workspace prepare", () => {
    const target = resolvePreparedRuntimeTarget(
      [
        { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "instance-a" },
        { workspaceId: "workspace-a", sessionId: "session-b", instanceId: "instance-b" },
      ],
      { targetWorkspaceId: "workspace-a", targetSessionId: "session-b" },
    );

    expect(target).toEqual({
      workspaceId: "workspace-a",
      sessionId: "session-b",
      instanceId: "instance-b",
    });
  });

  test("does not adopt a same-workspace runtime when the prepared target is absent", () => {
    expect(
      resolvePreparedRuntimeTarget(
        [{ workspaceId: "workspace-a", sessionId: "session-a", instanceId: "instance-a" }],
        { targetWorkspaceId: "workspace-a", targetSessionId: "session-b" },
      ),
    ).toBeNull();
  });
});
