// ABOUTME: Verifies the per-target readiness gate for startup configuration reads.
// ABOUTME: The gate re-arms whenever the routing triple changes, so config
// ABOUTME: requests can never fire into a runtime whose first foreground
// ABOUTME: snapshot has not arrived.
import { describe, expect, test, vi } from "vitest";
import { createConfigReadiness } from "./config-readiness.js";

function harness() {
  let currentTarget = null;
  const readiness = createConfigReadiness({
    targetKeyOf: () => {
      if (!currentTarget?.workspaceId || !currentTarget?.sessionId) return null;
      return [
        currentTarget.workspaceId,
        currentTarget.sessionId,
        currentTarget.instanceId ?? "",
      ].join("\u0000");
    },
  });
  return {
    readiness,
    setTarget(target) {
      currentTarget = target;
    },
  };
}

const TARGET_A = { workspaceId: "ws-a", sessionId: "session-a", instanceId: "instance-a" };
const TARGET_B = { workspaceId: "ws-a", sessionId: "session-b", instanceId: "instance-b" };

describe("createConfigReadiness", () => {
  test("rejects while there is no active runtime target", async () => {
    const { readiness } = harness();
    await expect(readiness.waitUntilReady()).rejects.toThrow("No active session");
  });

  test("holds requests until the current target's foreground snapshot arrives", async () => {
    const { readiness, setTarget } = harness();
    setTarget(TARGET_A);
    let settled = false;
    void readiness.waitUntilReady().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    readiness.noteForegroundSnapshot();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  test("resolves immediately once the current target is ready", async () => {
    const { readiness, setTarget } = harness();
    setTarget(TARGET_A);
    readiness.noteForegroundSnapshot();
    await expect(readiness.waitUntilReady()).resolves.toBeUndefined();
  });

  test("re-arms when the routing triple changes to another runtime", async () => {
    const { readiness, setTarget } = harness();
    setTarget(TARGET_A);
    readiness.noteForegroundSnapshot();

    // In-page adoption of a fresh runtime: the gate must close for B until
    // B's own foreground snapshot proves it live.
    setTarget(TARGET_B);
    let settled = false;
    void readiness.waitUntilReady().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    readiness.noteForegroundSnapshot();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  test("fails fast for stale waiters when a different target becomes ready", async () => {
    const { readiness, setTarget } = harness();
    setTarget(TARGET_A);
    const stale = readiness.waitUntilReady();

    // Routing moved to B before A ever proved live: A's waiter is stale and
    // must reject instead of hanging forever (ConfigGateway has no timer
    // before the request dispatches).
    setTarget(TARGET_B);
    readiness.noteForegroundSnapshot();

    await expect(stale).rejects.toThrow("Runtime target changed");
    // And B is now ready.
    await expect(readiness.waitUntilReady()).resolves.toBeUndefined();
  });
});
