// ABOUTME: Contract tests for the Gate D existing-shell v1→v2 adapter prototype.
// ABOUTME: Imports the REAL production WebSocketClient unmodified over both adapter shapes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// Real production client — imported AS-IS, never stubbed or modified.
import { WebSocketClient } from "../../public/app/websocket-client.js";
import {
  hostOriginWsUrl,
  resolveWithBase,
  stripBrokerWs,
  validateBrokerWsCandidate,
} from "./broker-ws-policy.js";
import { createCompatApiMiddleware } from "./compat-api.js";
import { CONTROL_MAP } from "./control-map.js";
import { __resetRealmCapabilityForTests, installV2Adapter } from "./v1-to-v2-socket.js";
import { createV2Host, V2_PROTOCOL_VERSION } from "./v2-core.js";
import { V1Facade } from "./v2-to-v1-facade.js";

// ── shared fixtures ─────────────────────────────────────────────────────────

const WORKSPACE = {
  workspaceId: "ws-alpha",
  sessionId: "session-1",
  instanceId: "instance-1",
  port: 47821,
};

function createHostFixture() {
  const host = createV2Host();
  host.registerWorkspace({
    workspaceId: WORKSPACE.workspaceId,
    ownerId: "owner-a",
    sessionId: WORKSPACE.sessionId,
    instanceId: WORKSPACE.instanceId,
  });
  const capability = host.mintDesktopCapability({
    ownerId: "owner-a",
    workspaceId: WORKSPACE.workspaceId,
    generation: 1,
  });
  const remoteToken = host.registerDeviceToken("owner-a");
  return { host, capability, remoteToken };
}

function eventOnce(target, name) {
  return new Promise((resolve) => {
    target.addEventListener(name, (event) => resolve(event.detail), { once: true });
  });
}

/** Server-facade path: a real WebSocketClient speaking v1 onto the facade. */
function createFacadeClient({ host, remoteDeviceToken = null }) {
  const facade = new V1Facade(host, { remoteDeviceToken });
  facade.registerRoute(WORKSPACE.port, {
    workspaceId: WORKSPACE.workspaceId,
    sessionId: WORKSPACE.sessionId,
    instanceId: WORKSPACE.instanceId,
  });
  facade.setDefaultTarget({
    workspaceId: WORKSPACE.workspaceId,
    sessionId: WORKSPACE.sessionId,
    instanceId: WORKSPACE.instanceId,
  });
  const v2Wire = [];
  // Prototype adapters expose legacy v1 wire to production client; v2 route is
  // adapter-internal, not client-visible.
  const client = new WebSocketClient(`ws://host/ws`);
  const session = facade.createSession({ onClose: (code) => closedWith.push(code) });
  const closedWith = [];
  // Record the v2 frames the facade emits, for wire-shape assertions.
  const coreHandle = session.v2.handleFrame.bind(session.v2);
  session.v2.handleFrame = (frame) => {
    v2Wire.push(frame);
    return coreHandle(frame);
  };
  const socket = {
    readyState: 1,
    send: (text) => {
      for (const frame of session.handleText(text)) {
        socket.onmessage?.({ data: JSON.stringify(frame) });
      }
    },
    close: () => {
      socket.readyState = 3;
      socket.onclose?.({ code: 1000 });
    },
    onmessage: null,
    onclose: null,
  };
  client.ws = socket;
  client.connectionState = "open";
  // Wire the socket to the client exactly like WebSocketClient.connect()
  // would, so inbound frames flow through the real handleMessage path.
  socket.onmessage = (event) => {
    try {
      client.handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("[facade harness] frame parse failed:", error);
    }
  };
  socket.onclose = () => {
    client.connectionState = "closed";
    client.dispatchEvent(new CustomEvent("disconnected"));
    if (!client.isIntentionallyClosed) client.attemptReconnect();
  };
  return { client, facade, session, v2Wire, closedWith };
}

/** Wrap path: a real WebSocketClient with the adapter installed as WebSocket. */
function createWrapClient({ host }) {
  const v2Wire = [];
  // The latest socket is the live adapter (reconnects replace it).
  const sockets = [];
  const current = () => sockets[sockets.length - 1];
  // A real reconnect opens a NEW transport connection: each adapter socket
  // gets its own host-side core. Sharing one authenticated core would make
  // the reconnect's second hello a protocol violation on an already
  // authenticated connection (correctly rejected by the v2 core).
  let core = null;
  const wire = {
    send: (text) => {
      const frame = JSON.parse(text);
      v2Wire.push(frame);
      for (const outgoing of core.handleFrame(frame)) {
        current()?.receive(JSON.stringify(outgoing));
      }
    },
  };
  const restore = installV2Adapter(globalThis, wire);
  // Keep production client on legacy v1 contract; adapter translates wire to v2.
  const client = new WebSocketClient("ws://host/ws");
  client.setRoutingContext({
    workspaceId: WORKSPACE.workspaceId,
    sessionId: WORKSPACE.sessionId,
    sourcePort: WORKSPACE.port,
  });
  // The adapter discovers targets from the routing context of outbound
  // envelopes; seed the default target like a production bootstrap would.
  const RealAdapter = globalThis.WebSocket;
  const patch = class extends RealAdapter {
    constructor(url) {
      super(url, wire);
      sockets.push(this);
      core = host.connect((frame) => {
        if (current() === this) this.receive(JSON.stringify(frame));
      });
      this.seedRoutes({
        defaultTarget: {
          workspaceId: WORKSPACE.workspaceId,
          sessionId: WORKSPACE.sessionId,
          instanceId: WORKSPACE.instanceId,
        },
        byPort: new Map([
          [
            WORKSPACE.port,
            {
              workspaceId: WORKSPACE.workspaceId,
              sessionId: WORKSPACE.sessionId,
              instanceId: WORKSPACE.instanceId,
            },
          ],
        ]),
        bySession: new Map(),
      });
    }
  };
  globalThis.WebSocket = patch;
  globalThis.WebSocket.OPEN = RealAdapter.OPEN;
  return {
    client,
    v2Wire,
    restore,
    sockets,
    get core() {
      return core;
    },
    get adapter() {
      return sockets[sockets.length - 1];
    },
  };
}

async function connectFacadeNative(fixture) {
  const harness = createFacadeClient(fixture);
  // The real client sends client_hello from onopen; emulate the open socket.
  harness.client.authenticated = false;
  harness.client._pendingConnect = true;
  const connected = eventOnce(harness.client, "connected");
  harness.client.ws.send(
    JSON.stringify({ type: "client_hello", protocolVersion: 1, capability: fixture.capability }),
  );
  await connected;
  return harness;
}

async function connectWrapNative(fixture) {
  globalThis.__PICOT_NATIVE_CAPABILITY__ = fixture.capability;
  const harness = createWrapClient(fixture);
  const connected = eventOnce(harness.client, "connected");
  harness.client.connect();
  await connected;
  return harness;
}

let restoreWrap = null;
beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.__PICOT_NATIVE_CAPABILITY__;
  __resetRealmCapabilityForTests();
  if (restoreWrap) {
    restoreWrap();
    restoreWrap = null;
  }
});

// ── 1. hello / capability mapping ───────────────────────────────────────────

describe("hello/capability mapping", () => {
  test("facade: native client_hello+capability → v2 desktop hello → v1 capabilities(native) → connected", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    expect(harness.client.authenticated).toBe(true);
    expect(harness.client.capabilities).toEqual({ native: true, class: "native" });
    const hello = harness.v2Wire[0];
    expect(hello).toMatchObject({
      type: "hello",
      protocolVersion: 2,
      clientType: "desktop",
      desktopCapability: fixture.capability,
    });
    expect(typeof hello.clientId).toBe("string");
    expect(hello.clientId.length).toBeGreaterThan(0);
  });

  test("facade: capability-less hello bridges to v2 remote (device token)", async () => {
    const fixture = createHostFixture();
    const harness = createFacadeClient({
      host: fixture.host,
      remoteDeviceToken: fixture.remoteToken,
    });
    const connected = eventOnce(harness.client, "connected");
    harness.client._pendingConnect = true;
    harness.client.ws.send(JSON.stringify({ type: "client_hello", protocolVersion: 1 }));
    await connected;
    expect(harness.client.capabilities).toEqual({ native: false, class: "remote" });
    expect(harness.v2Wire[0]).toMatchObject({
      clientType: "remote",
      deviceToken: fixture.remoteToken,
    });
  });

  test("facade: invalid desktop capability → socket closed with stable code, client never authenticated", async () => {
    const fixture = createHostFixture();
    const harness = createFacadeClient({ host: fixture.host });
    harness.client.ws.send(
      JSON.stringify({ type: "client_hello", protocolVersion: 1, capability: "cap-forged" }),
    );
    expect(harness.closedWith).toEqual(["unauthenticated"]);
    expect(harness.client.authenticated).toBe(false);
  });

  test("v2 core rejects protocolVersion 1 hello with protocol_mismatch", () => {
    const host = createV2Host();
    const out = [];
    const conn = host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, clientType: "desktop", clientId: "x" }),
    );
    expect(out[0]).toMatchObject({ type: "error", error: { code: "protocol_mismatch" } });
    expect(out[0].requestId).toBeNull();
  });

  test("v2 core rejects a desktop hello without capability (no downgrade)", () => {
    const host = createV2Host();
    const out = [];
    const conn = host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({ type: "hello", protocolVersion: 2, clientType: "desktop", clientId: "x" }),
    );
    expect(out[0]).toMatchObject({ type: "error", error: { code: "unauthenticated" } });
  });

  test("wrap: real client speaks canonical v2 hello with injected capability; read-once global honored", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    expect(harness.v2Wire[0]).toMatchObject({
      type: "hello",
      protocolVersion: 2,
      clientType: "desktop",
      desktopCapability: fixture.capability,
    });
    expect(harness.client.capabilities).toEqual({ native: true, class: "native" });
    // The production client deletes the global after the first read; the
    // adapter must not resurrect it into storage or the URL.
    expect(globalThis.__PICOT_NATIVE_CAPABILITY__).toBeUndefined();
    expect(sessionStorage.getItem("pi-studio:broker-ws-url")).toBeNull();
  });

  test("wrap: reconnect reuses the cached capability without re-injection", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    expect(globalThis.__PICOT_NATIVE_CAPABILITY__).toBeUndefined();
    const connected = eventOnce(harness.client, "connected");
    harness.client.forceReconnect();
    await connected;
    const hellos = harness.v2Wire.filter((frame) => frame.type === "hello");
    expect(hellos.length).toBe(2);
    expect(hellos[1].desktopCapability).toBe(fixture.capability);
  });
});

// ── 2. control mapping (per control, both paths) ────────────────────────────

describe("control mapping — facade path", () => {
  test.each([
    "open_workspace",
    "new_session",
    "switch_session",
    "fork",
    "navigate_tree",
    "stop_instance",
    "spawn_session_process",
  ])("session lifecycle control %s → host_request, never runtime_request", async (command) => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    await harness.client.sendControl(command, { entryId: "entry-9", port: WORKSPACE.port });
    expect(harness.v2Wire.find((f) => f.type === "host_request")).toMatchObject({
      operation: command,
    });
    expect(harness.v2Wire.some((f) => f.type === "runtime_request")).toBe(false);
  });

  test("picker class: pick_folder → host_request; remote client denied forbidden_class", async () => {
    const fixture = createHostFixture();
    const native = await connectFacadeNative(fixture);
    await expect(native.client.sendControl("pick_folder")).resolves.toEqual({
      path: "/tmp/picked-folder",
    });
    expect(native.v2Wire.find((f) => f.type === "host_request")?.operation).toBe("pick_folder");

    const remoteHarness = createFacadeClient({
      host: fixture.host,
      remoteDeviceToken: fixture.remoteToken,
    });
    const connected = eventOnce(remoteHarness.client, "connected");
    remoteHarness.client._pendingConnect = true;
    remoteHarness.client.ws.send(JSON.stringify({ type: "client_hello", protocolVersion: 1 }));
    await connected;
    await expect(remoteHarness.client.sendControl("pick_folder")).rejects.toThrow(
      /forbidden_class/,
    );
  });

  test("open class: open_in_app → host_request with path", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    await harness.client.sendControl("open_in_app", { path: "/tmp/report.pdf" });
    expect(harness.v2Wire.find((f) => f.type === "host_request")).toMatchObject({
      operation: "open_in_app",
      path: "/tmp/report.pdf",
    });
  });

  test("skill class: skill_install_links → host_request", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    await harness.client.sendControl("skill_install_links", { sourceId: "src-1", links: [] });
    expect(harness.v2Wire.find((f) => f.type === "host_request")).toMatchObject({
      operation: "skill_install_links",
    });
  });

  test("workspace-transition class: prepare → commit keeps generation binding; wrong generation → stale_generation", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    const prepare = await harness.client.sendControl("workspace_target_prepare", {
      targetCwd: "/tmp/other",
    });
    expect(prepare.transitionGeneration).toBeGreaterThan(0);
    await expect(
      harness.client.sendControl("workspace_transition_commit", {
        transitionGeneration: prepare.transitionGeneration,
      }),
    ).resolves.toEqual({ workspaceGeneration: prepare.transitionGeneration });
    await expect(
      harness.client.sendControl("workspace_transition_commit", {
        transitionGeneration: prepare.transitionGeneration + 99,
      }),
    ).rejects.toThrow(/stale_generation/);
  });

  test("unmapped control → visible unimplemented_route error, never a fake ok", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    await expect(harness.client.sendControl("list_pi_packages", {})).rejects.toThrow(
      /unimplemented_route/,
    );
  });
});

describe("control mapping — wrap path", () => {
  test("every CONTROL_MAP entry translates and resolves through the real client", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    // Host controls, including session/process lifecycle, resolve through host.
    await expect(harness.client.sendControl("pick_folder")).resolves.toEqual({
      path: "/tmp/picked-folder",
    });
    await expect(
      harness.client.sendControl("open_external", { url: "https://example.com" }),
    ).resolves.toEqual({ opened: true });
    await expect(
      harness.client.sendControl("fork", { entryId: "e1", port: WORKSPACE.port }),
    ).resolves.toEqual({});
    const hostFrames = harness.v2Wire.filter((f) => f.type === "host_request");
    expect(hostFrames.map((frame) => frame.operation)).toEqual([
      "pick_folder",
      "open_external",
      "fork",
    ]);
    expect(harness.v2Wire.some((f) => f.type === "runtime_request")).toBe(false);
  });
});

// ── 3. broker_command: prompt → runtime_request → event stream ─────────────

describe("broker_command prompt stream", () => {
  test("facade: prompt maps to idempotent runtime_request; events arrive in order with routing metadata", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const events = [];
    harness.client.addEventListener("rpcEvent", (e) => events.push(e.detail));
    const requestId = harness.client.send({ type: "prompt", message: "hi" });
    expect(requestId).toMatch(/^req-\d+$/);
    const promptFrame = harness.v2Wire.find(
      (f) => f.type === "runtime_request" && f.command?.type === "prompt",
    );
    expect(promptFrame).toMatchObject({
      idempotencyKey: `v1-cmd-${requestId}`,
      command: { type: "prompt", message: "hi" },
    });
    expect(promptFrame.target).toMatchObject({ workspaceId: WORKSPACE.workspaceId });
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "agent_end",
    ]);
    // The v1 UI's port-based foreground guard consumes __broker.sourcePort.
    expect(events[0].__broker).toMatchObject({
      sourcePort: WORKSPACE.port,
      sessionId: WORKSPACE.sessionId,
    });
  });

  test("wrap: same prompt contract through the client-side adapter", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    const events = [];
    harness.client.addEventListener("rpcEvent", (e) => events.push(e.detail));
    const requestId = harness.client.send({ type: "prompt", message: "hi" });
    const promptFrame = harness.v2Wire.find(
      (f) => f.type === "runtime_request" && f.command?.type === "prompt",
    );
    expect(promptFrame.idempotencyKey).toBe(`v1-cmd-${requestId}`);
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "agent_end",
    ]);
  });

  test("P4/P5/P6 deferred runtime surfaces fail with stable unimplemented_route", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const undeliverable = eventOnce(harness.client, "commandUndeliverable");
    harness.client.send({ type: "get_messages" });
    await expect(undeliverable).resolves.toMatchObject({
      reason: expect.stringContaining("unimplemented_route"),
    });
  });

  test("unknown runtime event passes through without breaking later events", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    const warn = vi.mocked(console.warn);
    const events = [];
    harness.client.addEventListener("rpcEvent", (e) => events.push(e.detail));
    // Feed an unknown v1 payload type through the real client's dispatch.
    harness.client.handleMessage({ type: "totally_unknown_event" });
    harness.client.handleMessage({
      type: "broker_event",
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
      payload: { type: "event", event: { type: "message_update", text_delta: "x" } },
    });
    expect(warn).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["message_update"]);
  });

  test("mirror_sync_request roundtrip produces a v1 mirror_sync payload (both paths)", async () => {
    const fixture = createHostFixture();
    const facadeHarness = await connectFacadeNative(fixture);
    facadeHarness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const facadeSync = eventOnce(facadeHarness.client, "mirrorSync");
    facadeHarness.client.send({ type: "mirror_sync_request" });
    const facadePayload = await facadeSync;
    // mirrorSync detail IS the payload (websocket-client.js dispatches the
    // unwrapped mirror_sync object, not the broker_event envelope).
    expect(facadePayload.type).toBe("mirror_sync");
    expect(facadePayload.workspaceId).toBe(WORKSPACE.workspaceId);
    expect(typeof facadePayload.sequence).toBe("number");

    const wrapHarness = await connectWrapNative(fixture);
    restoreWrap = wrapHarness.restore;
    const wrapSync = eventOnce(wrapHarness.client, "mirrorSync");
    wrapHarness.client.send({ type: "mirror_sync_request" });
    const wrapPayload = await wrapSync;
    expect(wrapPayload.type).toBe("mirror_sync");
  });
});

// ── 4. sequence gap → snapshot ordering (D-GAP-08) ──────────────────────────

describe("sequence gap → snapshot ordering", () => {
  test("facade: after a gap, mirror_sync lands before any post-gap event; watermark monotonic", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const syncs = [];
    const events = [];
    harness.client.addEventListener("mirrorSync", (e) => syncs.push(e.detail));
    harness.client.addEventListener("rpcEvent", (e) => events.push(e.detail));
    harness.client.send({ type: "prompt", message: "one" });
    const watermarkBefore = events.length; // seq 1..6 consumed
    // Force the subscriber to miss everything after the last delivered seq.
    harness.session.v2.forceLag(
      {
        workspaceId: WORKSPACE.workspaceId,
        sessionId: WORKSPACE.sessionId,
        instanceId: WORKSPACE.instanceId,
      },
      watermarkBefore + 1,
    );
    // Drain the out-of-band frames (gap marker triggered facade recovery).
    for (const frame of harness.session.drain()) {
      harness.client.ws.onmessage({ data: JSON.stringify(frame) });
    }
    expect(syncs.length).toBe(1);
    expect(syncs[0].type).toBe("mirror_sync");
    expect(syncs[0].sequence).toBeGreaterThanOrEqual(watermarkBefore);
    // Post-gap events only flow after the snapshot.
    harness.client.send({ type: "prompt", message: "two" });
    const firstEventTypeAfterGap = events[watermarkBefore]?.type;
    expect(["agent_start", "message_update"]).toContain(firstEventTypeAfterGap);
    expect(events.slice(watermarkBefore).length).toBeGreaterThan(0);
  });

  test("wrap: adapter buffers events across the gap and emits mirror_sync first", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    const delivered = [];
    harness.client.addEventListener("mirrorSync", (e) =>
      delivered.push({ kind: "sync", detail: e.detail }),
    );
    harness.client.addEventListener("rpcEvent", (e) =>
      delivered.push({ kind: "event", detail: e.detail }),
    );
    harness.client.send({ type: "prompt", message: "one" });
    expect(delivered.filter((item) => item.kind === "event").length).toBe(6);
    harness.adapter.receive(
      JSON.stringify({
        type: "error",
        requestId: null,
        error: { code: "event_sequence_gap", message: "missed events" },
      }),
    );
    // The adapter asked the core for a snapshot of the subscribed target.
    const snapshotRequests = harness.v2Wire.filter((f) => f.type === "runtime_snapshot_request");
    expect(snapshotRequests.length).toBe(1);
    expect(snapshotRequests[0].target).toMatchObject({ sessionId: WORKSPACE.sessionId });
    // Snapshot reply → mirror_sync first, buffered events (none yet) after.
    expect(delivered.filter((item) => item.kind === "sync").length).toBe(1);
    // New events now flow normally (recovery complete).
    harness.client.send({ type: "prompt", message: "two" });
    expect(
      delivered.filter((item) => item.kind === "event").map((item) => item.detail.type),
    ).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "agent_end",
      "agent_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "agent_end",
    ]);
  });

  test("no mutation is auto-resent across a gap", async () => {
    const fixture = createHostFixture();
    const harness = await connectWrapNative(fixture);
    restoreWrap = harness.restore;
    harness.client.send({ type: "prompt", message: "one" });
    harness.adapter.receive(
      JSON.stringify({
        type: "error",
        requestId: null,
        error: { code: "event_sequence_gap", message: "missed events" },
      }),
    );
    const promptRequests = harness.v2Wire.filter(
      (f) => f.type === "runtime_request" && f.command?.type === "prompt",
    );
    expect(promptRequests.length).toBe(1);
  });
});

// ── 5. turn-bound abort ─────────────────────────────────────────────────────

describe("turn-bound abort", () => {
  test("facade synthesizes turnId for the v1 shapeless abort against the active turn", async () => {
    const fixture = createHostFixture();
    fixture.host.__test.holdPrompts = true;
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const events = [];
    harness.client.addEventListener("rpcEvent", (e) => events.push(e.detail));
    harness.client.send({ type: "prompt", message: "held" });
    expect(events.map((event) => event.type)).toEqual(["agent_start", "message_start"]);
    harness.client.send({ type: "abort" });
    const abortFrame = harness.v2Wire.find(
      (f) => f.type === "runtime_request" && f.command?.type === "abort",
    );
    expect(abortFrame.command.turnId).toMatch(/^turn-op-\d+$/);
    expect(abortFrame.idempotencyKey).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "agent_end", aborted: true });
    fixture.host.__test.holdPrompts = false;
  });

  test("v1 abort with no observed active turn fails visibly (no_route analog)", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    const undeliverable = eventOnce(harness.client, "commandUndeliverable");
    harness.client.send({ type: "abort" });
    const detail = await undeliverable;
    expect(detail.reason).toBe("no_active_turn");
  });

  test("stale turn abort is a success no-op and never cancels the successor turn", async () => {
    const fixture = createHostFixture();
    const host = fixture.host;
    host.__test.holdPrompts = true;
    const out = [];
    const conn = host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: V2_PROTOCOL_VERSION,
        clientType: "desktop",
        clientId: "abort-test",
        desktopCapability: fixture.capability,
      }),
    );
    const target = {
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      instanceId: WORKSPACE.instanceId,
    };
    conn.send(JSON.stringify({ type: "runtime_subscribe", requestId: "sub", target }));
    conn.send(
      JSON.stringify({
        type: "runtime_request",
        requestId: "a",
        target,
        idempotencyKey: "key-a",
        command: { type: "prompt", message: "A" },
      }),
    );
    const turnA = out.find((frame) => frame.type === "runtime_event")?.turnId;
    conn.send(
      JSON.stringify({
        type: "runtime_request",
        requestId: "b",
        target,
        idempotencyKey: "key-b",
        command: { type: "prompt", message: "B" },
      }),
    );
    // Old A abort arrives after B started.
    conn.send(
      JSON.stringify({
        type: "runtime_request",
        requestId: "stale-abort",
        target,
        command: { type: "abort", turnId: turnA },
      }),
    );
    const staleResponse = out.find(
      (frame) => frame.type === "runtime_response" && frame.requestId === "stale-abort",
    );
    expect(staleResponse.response).toEqual({ staleTurn: true, aborted: false });
    // B still completes when flushed.
    host.__test.flushPrompt(target);
    const bEvents = out.filter((frame) => frame.type === "runtime_event" && frame.turnId !== turnA);
    expect(bEvents.map((frame) => frame.event.type)).toContain("agent_end");
    host.__test.holdPrompts = false;
  });
});

// ── 6. idempotency replay ───────────────────────────────────────────────────

describe("operation idempotency", () => {
  test("same key replay: pending → duplicate_pending; completed → duplicate_completed with cached response", () => {
    const fixture = createHostFixture();
    fixture.host.__test.holdPrompts = true;
    const out = [];
    const conn = fixture.host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        clientType: "desktop",
        clientId: "idem",
        desktopCapability: fixture.capability,
      }),
    );
    const target = {
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      instanceId: WORKSPACE.instanceId,
    };
    const request = JSON.stringify({
      type: "runtime_request",
      requestId: "r1",
      target,
      idempotencyKey: "same-key",
      command: { type: "prompt", message: "x" },
    });
    conn.send(request);
    const first = out.find((frame) => frame.type === "runtime_response");
    expect(first.acceptance).toBe("accepted_pending");
    conn.send(request);
    const replayWhilePending = out.filter((frame) => frame.type === "runtime_response").at(-1);
    expect(replayWhilePending.acceptance).toBe("duplicate_pending");
    expect(replayWhilePending.operationId).toBe(first.operationId);
    fixture.host.__test.flushPrompt(target);
    conn.send(request);
    const replayCompleted = out.filter((frame) => frame.type === "runtime_response").at(-1);
    expect(replayCompleted.acceptance).toBe("duplicate_completed");
    expect(replayCompleted.response).toEqual({ ok: true });
    fixture.host.__test.holdPrompts = false;
  });

  test("v1 retry semantics preserved: two v1 sends are two distinct operations", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: WORKSPACE.workspaceId,
      sessionId: WORKSPACE.sessionId,
      sourcePort: WORKSPACE.port,
    });
    harness.client.send({ type: "fork", entryId: "e1" });
    harness.client.send({ type: "fork", entryId: "e1" });
    const frames = harness.v2Wire.filter(
      (f) => f.type === "runtime_request" && f.command?.type === "fork",
    );
    expect(frames.length).toBe(2);
    expect(frames[0].idempotencyKey).not.toBe(frames[1].idempotencyKey);
  });
});

// ── 7. target admission / authority ─────────────────────────────────────────

describe("target admission", () => {
  test("temporary synthetic workspace IDs fail closed with not_registered", async () => {
    const fixture = createHostFixture();
    const harness = await connectFacadeNative(fixture);
    harness.client.setRoutingContext({
      workspaceId: "temporary-quick-chat",
      sessionId: "session-x",
      sourcePort: 49999,
    });
    const undeliverable = eventOnce(harness.client, "commandUndeliverable");
    harness.client.send({ type: "get_messages" });
    // No route was ever registered for the temporary workspace: the facade
    // cannot even resolve a target, which is itself a fail-closed outcome.
    expect((await undeliverable).reason).toBe("no_route");
  });

  test("cross-owner workspace denied at the v2 core", () => {
    const fixture = createHostFixture();
    fixture.host.registerWorkspace({
      workspaceId: "ws-other-owner",
      ownerId: "owner-b",
      sessionId: "session-b",
      instanceId: "instance-b",
    });
    const out = [];
    const conn = fixture.host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        clientType: "desktop",
        clientId: "x-owner",
        desktopCapability: fixture.capability,
      }),
    );
    conn.send(
      JSON.stringify({
        type: "runtime_request",
        requestId: "cross",
        target: { workspaceId: "ws-other-owner", sessionId: "session-b", instanceId: "instance-b" },
        command: { type: "get_messages" },
      }),
    );
    expect(out.at(-1)).toMatchObject({ type: "error", error: { code: "cross_workspace" } });
  });
});

// ── 8. URL / base resolution & brokerWs policy ──────────────────────────────

describe("URL/base resolution and brokerWs removal", () => {
  test("root-relative /api/* stays on the host origin under a /v/<fingerprint>/ base", () => {
    expect(resolveWithBase("/api/workspace-sessions", "/v/ab12cd34/")).toBe(
      "http://127.0.0.1:47821/api/workspace-sessions",
    );
    expect(resolveWithBase("./app.js", "/v/ab12cd34/")).toBe(
      "http://127.0.0.1:47821/v/ab12cd34/app.js",
    );
  });

  test("hostOriginWsUrl derives the single adapter endpoint", () => {
    expect(hostOriginWsUrl({ location: { protocol: "http:", host: "127.0.0.1:52000" } })).toBe(
      "ws://127.0.0.1:52000/v2/ws",
    );
    expect(hostOriginWsUrl({ location: { protocol: "https:", host: "studio.local" } })).toBe(
      "wss://studio.local/v2/ws",
    );
  });

  test("brokerWs candidates: only host-origin /v2/ws is accepted", () => {
    const env = { location: { host: "127.0.0.1:52000" } };
    expect(validateBrokerWsCandidate("ws://127.0.0.1:52000/v2/ws", env).ok).toBe(true);
    // Pi-origin broker from the legacy stack must be rejected, not dialed.
    expect(validateBrokerWsCandidate("ws://127.0.0.1:49999/ui-ws", env)).toMatchObject({
      ok: false,
      reason: "foreign_origin",
    });
    expect(validateBrokerWsCandidate("ws://127.0.0.1:52000/ws", env)).toMatchObject({
      ok: false,
      reason: "not_adapter_endpoint",
    });
    expect(validateBrokerWsCandidate("not a url", env)).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
  });

  test("stripBrokerWs removes both discovery sources", () => {
    const store = new Map([["pi-studio:broker-ws-url", "ws://127.0.0.1:49999/ui-ws"]]);
    const replaced = [];
    const env = {
      location: {
        protocol: "http:",
        host: "127.0.0.1:52000",
        pathname: "/workspaces/ws-alpha/sessions/session-1",
        search: "?brokerWs=ws%3A%2F%2F127.0.0.1%3A49999%2Fui-ws",
        hash: "",
        replace: (url) => replaced.push(url),
      },
      sessionStorage: {
        getItem: (key) => store.get(key) ?? null,
        removeItem: (key) => store.delete(key),
      },
    };
    const removed = stripBrokerWs(env);
    expect(removed.query).toBe("ws://127.0.0.1:49999/ui-ws");
    expect(removed.storage).toBe("ws://127.0.0.1:49999/ui-ws");
    expect(replaced).toEqual(["/workspaces/ws-alpha/sessions/session-1"]);
    expect(store.size).toBe(0);
  });
});

// ── 9. retained /api/* compatibility middleware ─────────────────────────────

describe("retained /api/* compatibility middleware", () => {
  function setup() {
    const fixture = createHostFixture();
    const sessionsByWorkspace = new Map([
      [WORKSPACE.workspaceId, [{ sessionId: WORKSPACE.sessionId, name: "alpha" }]],
    ]);
    const middleware = createCompatApiMiddleware({
      compatTokens: fixture.host.compatTokens,
      listSessions: (ownerId, workspaceId) => {
        const workspace = fixture.host.workspaces.get(workspaceId);
        if (!workspace) throw new Error("not registered");
        if (workspace.ownerId !== ownerId) throw new Error("cross_workspace");
        return sessionsByWorkspace.get(workspaceId) ?? [];
      },
    });
    return { fixture, middleware };
  }

  test("compat token minted over the authenticated WS authorizes the retained route", () => {
    const { fixture, middleware } = setup();
    const out = [];
    const conn = fixture.host.connect((frame) => out.push(frame));
    conn.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        clientType: "desktop",
        clientId: "compat",
        desktopCapability: fixture.capability,
      }),
    );
    conn.send(
      JSON.stringify({ type: "host_request", requestId: "issue", operation: "compat_api_issue" }),
    );
    const token = out.find((frame) => frame.type === "host_response")?.result?.token;
    expect(typeof token).toBe("string");
    const ok = middleware.handle({
      method: "GET",
      path: "/api/workspace-sessions",
      token,
      workspaceId: WORKSPACE.workspaceId,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.sessions).toEqual([{ sessionId: WORKSPACE.sessionId, name: "alpha" }]);
  });

  test("missing/invalid token → 401; cross-owner workspace → 403", () => {
    const { fixture, middleware } = setup();
    fixture.host.compatTokens.set("compat-owner-a", "owner-a");
    fixture.host.compatTokens.set("compat-owner-b", "owner-b");
    expect(
      middleware.handle({
        method: "GET",
        path: "/api/workspace-sessions",
        token: null,
        workspaceId: WORKSPACE.workspaceId,
      }).status,
    ).toBe(401);
    expect(
      middleware.handle({
        method: "GET",
        path: "/api/workspace-sessions",
        token: "compat-owner-b",
        workspaceId: WORKSPACE.workspaceId,
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "cross_workspace" } } });
  });

  test("non-retained /api/* → visible 404 unimplemented_route and ZERO legacy-origin fallbacks", () => {
    const { middleware } = setup();
    for (const path of ["/api/files", "/api/rpc", "/api/models-config"]) {
      const result = middleware.handle({ method: "GET", path, token: "compat-owner-a" });
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe("unimplemented_route");
    }
    expect(middleware.legacyOriginRequests).toBe(0);
  });
});

// ── 10. control map coverage sanity ─────────────────────────────────────────

describe("CONTROL_MAP representative coverage", () => {
  test("covers all five named control classes", () => {
    const categories = new Set(Object.values(CONTROL_MAP).map((entry) => entry.category));
    expect(categories).toEqual(
      new Set(["session-routing", "picker", "open", "skill", "workspace-transition"]),
    );
  });
});
