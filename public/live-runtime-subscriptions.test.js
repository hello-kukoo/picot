// ABOUTME: Locks live-runtime subscription refresh — incremental, idempotent,
// ABOUTME: and green-dot initialization from the host's streaming flag.

import { describe, expect, test, vi } from "vitest";
import { createBackgroundSessionFiles } from "./background-session-files.js";
import { createLiveRuntimeSubscriptions } from "./live-runtime-subscriptions.js";

function harness({ instances }) {
  const transport = { runtimeInstances: vi.fn().mockResolvedValue({ instances }) };
  const subscribe = vi.fn();
  const snapshot = vi.fn();
  const wsClient = {
    subscribeRuntimeTarget: subscribe,
    requestRuntimeSnapshot: snapshot,
  };
  const setStreaming = vi.fn();
  const sidebar = { setStreaming };
  const backgroundSessionFiles = createBackgroundSessionFiles();
  return {
    transport,
    subscribe,
    snapshot,
    setStreaming,
    subs: createLiveRuntimeSubscriptions({
      transport,
      wsClient,
      sidebar,
      backgroundSessionFiles,
    }),
  };
}

const idleInstance = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
  sessionFile: "/sessions/a.jsonl",
  streaming: false,
};
const busyInstance = {
  workspaceId: "workspace-a",
  sessionId: "session-b",
  instanceId: "instance-b",
  sessionFile: "/sessions/b.jsonl",
  streaming: true,
};

describe("live runtime subscriptions", () => {
  test("first refresh subscribes every resolvable instance and snapshots it", async () => {
    const h = harness({ instances: [idleInstance, busyInstance] });
    await h.subs.refresh();
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });

  test("streaming instance lights the green dot under its jsonl key", async () => {
    const h = harness({ instances: [busyInstance] });
    await h.subs.refresh();
    expect(h.setStreaming).toHaveBeenCalledWith("/sessions/b.jsonl", true);
  });

  test("idle instance never lights a dot", async () => {
    const h = harness({ instances: [idleInstance] });
    await h.subs.refresh();
    expect(h.setStreaming).not.toHaveBeenCalled();
  });

  test("re-refresh is idempotent: no duplicate subscribe/snapshot", async () => {
    const h = harness({ instances: [idleInstance] });
    await h.subs.refresh();
    await h.subs.refresh();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
  });

  test("a runtime spawned later gets subscribed on the next refresh only", async () => {
    const h = harness({ instances: [idleInstance] });
    await h.subs.refresh();
    h.transport.runtimeInstances.mockResolvedValue({ instances: [idleInstance, busyInstance] });
    await h.subs.refresh();
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.setStreaming).toHaveBeenCalledWith("/sessions/b.jsonl", true);
  });

  test("a mid-turn turn that has ended by next refresh does not relight the dot", async () => {
    const h = harness({ instances: [{ ...busyInstance }] });
    await h.subs.refresh();
    h.transport.runtimeInstances.mockResolvedValue({
      instances: [{ ...busyInstance, streaming: false }],
    });
    h.setStreaming.mockClear();
    await h.subs.refresh();
    expect(h.setStreaming).not.toHaveBeenCalled();
  });

  test("transport failure is swallowed", async () => {
    const h = harness({ instances: [] });
    h.transport.runtimeInstances.mockRejectedValue(new Error("offline"));
    await expect(h.subs.refresh()).resolves.toBeUndefined();
  });

  test("instances missing identity fields are skipped", async () => {
    const h = harness({ instances: [{ sessionId: "x" }, null, busyInstance] });
    await h.subs.refresh();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });
});
