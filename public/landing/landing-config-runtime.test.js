// ABOUTME: Verifies the landing bridge-service config runtime: lazy idempotent
// ABOUTME: spawn, gateway proxies, spawn-failure retry, and notify routing.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setupLandingConfigRuntime } from "./landing-config-runtime.js";

class FakeWsClient extends EventTarget {
  constructor() {
    super();
    this.ephemeralSends = [];
  }

  sendEphemeral(instanceId, generation, payload) {
    this.ephemeralSends.push({ instanceId, generation, payload });
    return `ep-${this.ephemeralSends.length}`;
  }
}

function makeHarness({ spawnResult } = {}) {
  const wsClient = new FakeWsClient();
  const transport = {
    spawnConfigRuntime: vi.fn(() =>
      spawnResult instanceof Error
        ? Promise.reject(spawnResult)
        : Promise.resolve(spawnResult ?? { instanceId: "inst-1", generation: 7, kind: "config" }),
    ),
  };
  const runtime = setupLandingConfigRuntime({ transport, wsClient });
  return { runtime, transport, wsClient };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("proxies spawn the runtime lazily and only once", async () => {
  const { runtime, transport, wsClient } = makeHarness();
  expect(transport.spawnConfigRuntime).not.toHaveBeenCalled();
  const first = runtime.configGateway.call("list_model_catalog").catch((error) => error);
  const second = runtime.configGateway.call("mcp_list_servers").catch((error) => error);
  await runtime.ensure();
  await runtime.ensure();
  expect(transport.spawnConfigRuntime).toHaveBeenCalledTimes(1);
  // The real gateway took over after the spawn; both pending calls fired
  // through the ephemeral channel with the spawned descriptor's addressing.
  expect(runtime.descriptor()).toEqual({ instanceId: "inst-1", generation: 7, kind: "config" });
  await vi.advanceTimersByTimeAsync(5);
  const sent = wsClient.ephemeralSends.map((entry) => entry.payload?.message);
  expect(sent.filter((message) => String(message).includes("list_model_catalog")).length).toBe(1);
  expect(sent.filter((message) => String(message).includes("mcp_list_servers")).length).toBe(1);
  expect(wsClient.ephemeralSends.every((entry) => entry.instanceId === "inst-1")).toBe(true);
  expect(wsClient.ephemeralSends.every((entry) => entry.generation === 7)).toBe(true);
  expect(runtime.oauthGateway.command).toBeInstanceOf(Function);
  // Both pending calls settle via their own timeout (no notify arrives).
  await vi.advanceTimersByTimeAsync(30_100);
  expect(String(await first)).toMatch(/timed out/);
  expect(String(await second)).toMatch(/timed out/);
});

test("a failed spawn resets so the next activation retries", async () => {
  let calls = 0;
  const wsClient = new FakeWsClient();
  const transport = {
    spawnConfigRuntime: vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("spawn failed"))
        : Promise.resolve({ instanceId: "inst-2", generation: 2, kind: "config" });
    }),
  };
  const runtime = setupLandingConfigRuntime({ transport, wsClient });
  await expect(runtime.ensure()).rejects.toThrow("spawn failed");
  await expect(runtime.ensure()).resolves.toEqual({
    instanceId: "inst-2",
    generation: 2,
    kind: "config",
  });
  expect(transport.spawnConfigRuntime).toHaveBeenCalledTimes(2);
});

test("ephemeral notify frames route into the config gateway", async () => {
  const { runtime, wsClient } = makeHarness();
  await runtime.ensure();
  const pending = runtime.configGateway.call("list_model_catalog");
  await vi.advanceTimersByTimeAsync(5);
  // The real ConfigGateway sent /picot-config over the ephemeral channel.
  const send = wsClient.ephemeralSends.at(-1);
  expect(send?.payload?.type).toBe("prompt");
  const idMatch = send?.payload?.message?.match(/"id":"([^"]+)"/);
  expect(idMatch).toBeTruthy();
  // Simulate the extension's notify round-trip as an ephemeral_event frame.
  wsClient.dispatchEvent(
    new CustomEvent("ephemeralEvent", {
      detail: {
        type: "ephemeral_event",
        instanceId: "inst-1",
        generation: 7,
        payload: {
          type: "extension_ui_request",
          message: JSON.stringify({ __picotConfig: idMatch[1], ok: true, data: { providers: [] } }),
        },
      },
    }),
  );
  await expect(pending).resolves.toEqual({ ok: true, data: { providers: [] } });
});

test("oauth subscribe defers until the runtime exists", async () => {
  const { runtime, wsClient } = makeHarness();
  const events = [];
  const unsubscribe = runtime.oauthGateway.subscribe((event) => events.push(event));
  await runtime.ensure();
  wsClient.dispatchEvent(
    new CustomEvent("ephemeralEvent", {
      detail: {
        payload: {
          type: "extension_ui_request",
          message: JSON.stringify({ __picotOauth: "oa-1", event: { type: "started" } }),
        },
      },
    }),
  );
  unsubscribe();
  // The deferred subscription was forwarded on spawn; the envelope shape
  // passes consumeFrame's runtime_event gate (the M3 contract).
  expect(events.length).toBe(1);
  expect(events[0]).toEqual({ event: { type: "started" } });
});

test("oauth command responses resolve the oauth gateway, not the config gateway", async () => {
  const { runtime, wsClient } = makeHarness();
  await runtime.ensure();
  const pending = runtime.oauthGateway.command({ type: "get_oauth_login_capabilities" });
  await vi.advanceTimersByTimeAsync(5);
  // The command left as a /picot-config prompt with an oa- request id; the
  // bridge answers command responses as __picotConfig frames (only login
  // events stream as __picotOauth).
  const send = wsClient.ephemeralSends.at(-1);
  expect(send?.payload?.type).toBe("prompt");
  const idMatch = send?.payload?.message?.match(/"id":"(oa-[^"]+)"/);
  expect(idMatch).toBeTruthy();
  wsClient.dispatchEvent(
    new CustomEvent("ephemeralEvent", {
      detail: {
        payload: {
          type: "extension_ui_request",
          message: JSON.stringify({
            __picotConfig: idMatch[1],
            ok: true,
            data: { providers: [{ providerId: "openai-codex", deviceCode: true }] },
          }),
        },
      },
    }),
  );
  await expect(pending).resolves.toEqual({
    success: true,
    data: { providers: [{ providerId: "openai-codex", deviceCode: true }] },
  });
});

test("a failed ephemeral command reports the host error instead of timing out", async () => {
  const { runtime, wsClient } = makeHarness();
  await runtime.ensure();
  const pending = runtime.configGateway.call("list_model_catalog").catch((error) => error);
  await vi.advanceTimersByTimeAsync(5);
  // The host refuses the frame and answers on the failure channel: the caller
  // must see that error now, not its own 30s timeout.
  const requestId = `ep-${wsClient.ephemeralSends.length}`;
  wsClient.dispatchEvent(
    new CustomEvent("ephemeralCommandFailed", {
      detail: {
        type: "ephemeral_command_failed",
        requestId,
        error: "Runtime mutation requires an idempotency key",
      },
    }),
  );
  await expect(pending).resolves.toMatchObject({
    message: "Runtime mutation requires an idempotency key",
  });
});
