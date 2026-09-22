// ABOUTME: Locks background-event key resolution — native sessionId → jsonl sessionFile.
// ABOUTME: This is the exact asymmetry that left streaming green dots stuck on.

import { describe, expect, test } from "vitest";
import { createBackgroundSessionFiles } from "./background-session-files.js";

describe("background session file resolution", () => {
  test("runtime_instances summaries resolve to their jsonl sessionFile", () => {
    const files = createBackgroundSessionFiles();
    files.rememberInstance({
      workspaceId: "workspace-a",
      sessionId: "session-1",
      instanceId: "instance-1",
      sessionFile: "/sessions/s1.jsonl",
    });
    expect(files.resolve({ sessionId: "session-1" })).toBe("/sessions/s1.jsonl");
  });

  test("a foreground runtime's mirror file is remembered for its background end", () => {
    const files = createBackgroundSessionFiles();
    // Task started while the session was active: agent_start keyed the dot
    // by the mirror's jsonl path, not the route sessionId.
    files.remember({ sessionId: "session-2" }, "/sessions/s2.jsonl");
    expect(files.resolve({ sessionId: "session-2" })).toBe("/sessions/s2.jsonl");
  });

  test("unknown targets resolve to null, never the bare native sessionId", () => {
    // A native sessionId matches no sidebar row; passing it on would silently
    // no-op the green-dot clear AND pollute the unread set/localStorage.
    const files = createBackgroundSessionFiles();
    expect(files.resolve({ sessionId: "session-unknown" })).toBeNull();
    expect(files.resolve(null)).toBeNull();
  });

  test("malformed instances and files are ignored", () => {
    const files = createBackgroundSessionFiles();
    files.rememberInstance(null);
    files.rememberInstance({ sessionId: "session-3", sessionFile: "" });
    files.remember({ sessionId: "" }, "/sessions/x.jsonl");
    files.remember({ sessionId: "session-4" }, null);
    expect(files.resolve({ sessionId: "session-3" })).toBeNull();
    expect(files.resolve({ sessionId: "session-4" })).toBeNull();
  });

  test("a fresh mapping overrides a stale one for the same sessionId", () => {
    const files = createBackgroundSessionFiles();
    files.remember({ sessionId: "session-5" }, "/sessions/old.jsonl");
    files.remember({ sessionId: "session-5" }, "/sessions/new.jsonl");
    expect(files.resolve({ sessionId: "session-5" })).toBe("/sessions/new.jsonl");
  });
});
