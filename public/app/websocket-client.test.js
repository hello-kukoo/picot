import { describe, expect, test } from "vitest";
import { resolveWebSocketUrl, WebSocketClient } from "./websocket-client.js";

describe("resolveWebSocketUrl", () => {
  test("uses the current HostServer origin and canonical v2 path", () => {
    expect(
      resolveWebSocketUrl({
        location: { protocol: "https:", host: "studio.local", search: "?brokerWs=ws://evil/ws" },
      }),
    ).toBe("wss://studio.local/v2/ws");
  });

  test("uses HTTP WebSocket protocol for local HostServer", () => {
    expect(
      resolveWebSocketUrl({
        location: { protocol: "http:", host: "127.0.0.1:47821", search: "" },
      }),
    ).toBe("ws://127.0.0.1:47821/v2/ws");
  });
});

describe("WebSocketClient control commands", () => {
  function openClient() {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    return { client, sent };
  }

  test("sendControl emits a host_request envelope and resolves on host_response", async () => {
    const { client, sent } = openClient();
    const result = client.sendControl("get_pi_version", {});

    expect(sent[0]).toMatchObject({
      type: "host_request",
      operation: "get_pi_version",
      requestId: "ctl-1",
      protocolVersion: 2,
    });

    client.handleMessage({
      type: "host_response",
      requestId: "ctl-1",
      ok: true,
      result: "1.2.3",
    });
    await expect(result).resolves.toBe("1.2.3");
  });

  test.each([
    "open_workspace",
    "new_session",
    "switch_session",
    "fork",
    "navigate_tree",
    "stop_instance",
    "spawn_session_process",
  ])("canonicalizes %s as host lifecycle control", (command) => {
    const { client, sent } = openClient();
    client.protocolVersion = 2;
    client.workspaceId = "workspace-a";
    client.sessionId = "session-a";
    client.sendControl(command, {});
    expect(sent[0]).toMatchObject({ type: "host_request", operation: command });
    expect(sent[0].type).not.toBe("runtime_request");
  });

  test("sendControl rejects on an error control_response", async () => {
    const { client } = openClient();
    const result = client.sendControl("new_session", {});
    client.handleMessage({
      type: "host_response",
      requestId: "ctl-1",
      ok: false,
      error: "boom",
    });
    await expect(result).rejects.toThrow("boom");
  });

  test("control_progress frames invoke the onProgress callback", async () => {
    const { client } = openClient();
    const events = [];
    const result = client.sendControl(
      "download_and_install_update",
      {},
      { onProgress: (data) => events.push(data), timeoutMs: 0 },
    );

    client.handleMessage({
      type: "control_progress",
      requestId: "ctl-1",
      data: { phase: "started", contentLength: 100 },
    });
    client.handleMessage({
      type: "control_progress",
      requestId: "ctl-1",
      data: { phase: "progress", downloaded: 50, contentLength: 100 },
    });
    client.handleMessage({
      type: "host_response",
      requestId: "ctl-1",
      ok: true,
      result: { installed: true },
    });

    await expect(result).resolves.toEqual({ installed: true });
    expect(events).toEqual([
      { phase: "started", contentLength: 100 },
      { phase: "progress", downloaded: 50, contentLength: 100 },
    ]);
  });

  test("the hello_ack handshake authenticates the HostServer connection", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const seen = [];
    client.addEventListener("hostCapabilities", (event) => seen.push(event.detail));

    client.handleMessage({ type: "hello_ack", protocolVersion: 2 });

    expect(client.authenticated).toBe(true);
    expect(client.capabilities).toEqual({ native: true, class: "native" });
    expect(seen).toEqual([{ native: true, class: "native" }]);
  });

  test("hello presents injected desktop capability, then connected fires after hello_ack", () => {
    const sent = [];
    globalThis.__PICOT_NATIVE_CAPABILITY__ = "secret-cap";
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const connected = [];
    client.addEventListener("connected", () => connected.push(true));
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };
    client._pendingConnect = true;
    client._sendClientHello();
    expect(sent[0]).toMatchObject({
      type: "hello",
      protocolVersion: 2,
      clientType: "desktop",
      desktopCapability: "secret-cap",
    });
    expect(globalThis.__PICOT_NATIVE_CAPABILITY__).toBeUndefined();
    expect(connected).toEqual([]);
    client.handleMessage({ type: "hello_ack", protocolVersion: 2 });
    expect(client.authenticated).toBe(true);
    expect(connected).toEqual([true]);
    delete globalThis.__PICOT_NATIVE_CAPABILITY__;
  });

  test("hello reuses cached desktop capability after reconnect", () => {
    const sent = [];
    globalThis.__PICOT_NATIVE_CAPABILITY__ = "secret-cap";
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };

    client._sendClientHello();
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };
    client._sendClientHello();

    expect(sent).toHaveLength(2);
    expect(sent[0].desktopCapability).toBe("secret-cap");
    expect(sent[1].desktopCapability).toBe("secret-cap");
    delete globalThis.__PICOT_NATIVE_CAPABILITY__;
  });

  test("hello omits desktop capability when host injection is absent", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };
    client._sendClientHello();
    expect(sent[0]).toMatchObject({
      type: "hello",
      protocolVersion: 2,
      clientType: "desktop",
      desktopCapability: null,
    });
  });

  test("sendEphemeral wraps an ephemeral_command envelope and returns its requestId", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };
    const id = client.sendEphemeral("inst-1", 3, { type: "prompt", message: "hi" });
    expect(id).toBe("ep-1");
    expect(sent[0]).toMatchObject({
      type: "ephemeral_command",
      ephemeralInstanceId: "inst-1",
      generation: 3,
      payload: { type: "prompt", message: "hi" },
    });
    expect(sent[0].ownerId).toBeUndefined();
    expect(sent[0].cwd).toBeUndefined();
    expect(sent[0].sourcePort).toBeUndefined();
  });

  test("ephemeral_event and ephemeral_command_failed dispatch distinct events", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const events = [];
    const fails = [];
    client.addEventListener("ephemeralEvent", (e) => events.push(e.detail));
    client.addEventListener("ephemeralCommandFailed", (e) => fails.push(e.detail));
    client.handleMessage({ type: "ephemeral_event", instanceId: "i", generation: 1, payload: {} });
    client.handleMessage({ type: "ephemeral_command_failed", requestId: "ep-1", error: "x" });
    expect(events).toHaveLength(1);
    expect(fails).toHaveLength(1);
  });

  test("disconnecting rejects pending control requests", async () => {
    const { client } = openClient();
    const result = client.sendControl("get_pi_version", {});
    client.rejectAllControls(new Error("WebSocket disconnected"));
    await expect(result).rejects.toThrow("WebSocket disconnected");
  });

  test("git_command_ack dispatches a correlated Git acknowledgement", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const acknowledgements = [];
    client.addEventListener("gitCommandAck", (event) => acknowledgements.push(event.detail));

    client.handleMessage({
      type: "git_command_ack",
      requestId: "git-7",
      workspaceGeneration: 4,
    });

    expect(acknowledgements).toEqual([
      { type: "git_command_ack", requestId: "git-7", workspaceGeneration: 4 },
    ]);
  });
});

describe("WebSocketClient broker routing", () => {
  test("wraps commands with the current session route", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
    });

    client.send({ type: "mirror_sync_request" });

    expect(sent).toEqual([
      {
        type: "runtime_request",
        protocolVersion: 2,
        requestId: "req-1",
        target: {
          workspaceId: "workspace:/tmp/project",
          sessionId: "/tmp/project/session-a.jsonl",
          instanceId: "primary",
        },
        command: { type: "mirror_sync_request" },
        idempotencyKey: "ui-req-1",
      },
    ]);
  });

  test("forwards sequenced runtime events to v2 listeners", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const events = [];
    client.addEventListener("runtimeEvent", (event) => events.push(event.detail));

    client.handleMessage({
      type: "runtime_event",
      target: {
        workspaceId: "workspace:/tmp/project",
        sessionId: "/tmp/project/session-b.jsonl",
        instanceId: "47822",
      },
      sequence: 1,
      event: { type: "agent_start" },
    });

    expect(events).toEqual([
      {
        type: "runtime_event",
        target: {
          workspaceId: "workspace:/tmp/project",
          sessionId: "/tmp/project/session-b.jsonl",
          instanceId: "47822",
        },
        sequence: 1,
        event: { type: "agent_start" },
      },
    ]);
  });

  test("can clear the current session route for a new active process", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
    });
    client.setRoutingContext({ sessionId: null });

    client.send({ type: "prompt", message: "hello" });

    expect(sent[0].target.sessionId).toBeNull();
    expect(sent[0].target.workspaceId).toBe("workspace:/tmp/project");
  });

  test("runtime snapshots do not hijack the routing context", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    // User is actively viewing session A on port 47821.
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
      instanceId: "47821",
    });

    // A background snapshot cannot alter client routing context.
    client.handleMessage({
      type: "runtime_snapshot",
      target: {
        workspaceId: "workspace:/tmp/project",
        sessionId: "/tmp/project/session-b.jsonl",
        instanceId: "secondary",
      },
      state: { messages: [], stats: {}, pi: {} },
    });

    // The next command must still target session A, not the background B.
    client.send({ type: "prompt", message: "hello" });
    expect(sent[0].target.sessionId).toBe("/tmp/project/session-a.jsonl");
    expect(sent[0].target.instanceId).toBe("47821");
  });

  test("runtime snapshots surface target instance to v2 listeners", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    const syncs = [];
    client.addEventListener("runtimeSnapshot", (event) => syncs.push(event.detail));

    client.handleMessage({
      type: "runtime_snapshot",
      target: {
        sessionId: "/tmp/project/session-b.jsonl",
        instanceId: "secondary",
      },
      state: { messages: [], stats: {}, pi: {} },
    });

    expect(syncs).toHaveLength(1);
    expect(syncs[0].target.instanceId).toBe("secondary");
  });

  test("frames carry the routing triple with the bootstrap instance", async () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    // Canonical page: bootstrap supplies the authoritative routing identity.
    client.canonicalRoute = true;
    client.workspaceId = "ws-uuid-1";
    client.sessionId = "session-a";
    await client.loadCanonicalTarget(async () => ({
      ok: true,
      json: async () => ({
        workspaceId: "ws-uuid-1",
        sessionId: "session-a",
        instanceId: "instance-1",
        ownerId: "owner-1",
        workspaceGeneration: 3,
      }),
    }));

    const sent = [];
    client.ws = { readyState: WebSocket.OPEN, send: (m) => sent.push(JSON.parse(m)) };
    client.send({ type: "get_state" });

    // Wire frames carry only the routing triple; owner/generation stay
    // host-side (host derives them from the live runtime on admission).
    expect(sent[0].target).toEqual({
      workspaceId: "ws-uuid-1",
      sessionId: "session-a",
      instanceId: "instance-1",
    });
  });

  test("send returns the requestId for runtime requests", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: () => {} };

    expect(client.send({ type: "prompt", message: "hello" })).toBe("req-1");
    // Caller payload cannot override transport correlation IDs.
    expect(client.send({ type: "runtime_request", requestId: "req-custom" })).toBe("req-2");
    // Not connected: nothing is sent and there is no requestId to track.
    client.ws = { readyState: WebSocket.CLOSED, send: () => {} };
    expect(client.send({ type: "prompt", message: "later" })).toBeNull();
  });

  test("structured runtime errors reject pending requests", async () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: () => {} };
    const pending = client.sendRuntime({ type: "prompt", message: "hello" });

    client.handleMessage({
      type: "error",
      requestId: "req-1",
      error: { code: "upstream_unavailable", message: "Runtime unavailable" },
    });

    await expect(pending).rejects.toThrow("Runtime unavailable");
  });

  test("normalizes v2 responses and forwards sequenced runtime events", async () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.setRoutingContext({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      instanceId: "47821",
    });
    const events = [];
    const syncs = [];
    client.addEventListener("runtimeEvent", (event) => events.push(event.detail));
    client.addEventListener("runtimeSnapshot", (event) => syncs.push(event.detail));
    client.handleMessage({
      type: "runtime_event",
      sequence: 4,
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
      event: { type: "message_update", text_delta: "hi" },
    });
    client.handleMessage({
      type: "runtime_snapshot",
      sequence: 5,
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
      state: { pi: { isStreaming: false }, messages: [{ role: "user" }], stats: { total: 1 } },
    });
    expect(events[0]).toMatchObject({
      type: "runtime_event",
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
      sequence: 4,
      event: { type: "message_update", text_delta: "hi" },
    });
    expect(syncs[0]).toMatchObject({
      type: "runtime_snapshot",
      sequence: 5,
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
      state: {
        messages: [{ role: "user" }],
        stats: { total: 1 },
      },
    });

    client.ws = { readyState: WebSocket.OPEN, send: () => {} };
    const result = client.sendControl("get_pi_version", {});
    client.handleMessage({
      type: "host_response",
      requestId: "ctl-1",
      operation: "get_pi_version",
      response: { version: "0.84.2" },
    });
    await expect(result).resolves.toEqual({ version: "0.84.2" });
  });

  test("sequence gap requests one authoritative snapshot for current target", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      instanceId: "47821",
    });
    client.handleMessage({
      type: "error",
      error: { code: "event_sequence_gap", message: "missed" },
    });
    client.handleMessage({
      type: "error",
      error: { code: "event_sequence_gap", message: "missed again" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "runtime_snapshot_request",
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
    });
  });

  test("wraps commands with the active runtime instance", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
      instanceId: "47822",
    });

    client.send({ type: "mirror_sync_request" });

    expect(sent[0].target.instanceId).toBe("47822");
  });

  test("sendRuntime correlates the v2 runtime reply and yields its data", async () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      instanceId: "47821",
    });

    const pending = client.sendRuntime({ type: "set_model", provider: "p", modelId: "m" });
    // Protocol shape comes from the host's RoutedAction::Runtime reply: the Pi
    // answer sits under `response`, next to acceptance/operationId.
    expect(sent[0]).toMatchObject({
      type: "runtime_request",
      protocolVersion: 2,
      target: { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "47821" },
      command: { type: "set_model", provider: "p", modelId: "m" },
    });
    expect(sent[0].idempotencyKey).toBe(`ui-${sent[0].requestId}`);
    client.handleMessage({
      type: "runtime_response",
      requestId: sent[0].requestId,
      acceptance: "accepted_pending",
      operationId: "op-1",
      response: { type: "response", command: "set_model", success: true, data: { model: "m" } },
    });

    await expect(pending).resolves.toEqual({ model: "m" });
    expect(client.pendingControls.size).toBe(0);
  });

  test("sendRuntime rejects with the runtime error text so retry logic still matches", async () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({ workspaceId: "workspace-a", sessionId: "session-a" });

    const pending = client.sendRuntime({ type: "set_model" });
    client.handleMessage({
      type: "runtime_response",
      requestId: sent[0].requestId,
      response: { success: false, error: "No context available" },
    });

    await expect(pending).rejects.toThrow("No context available");
  });

  test("sendData yields the data_response payload without its envelope", async () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({ workspaceId: "workspace-a", sessionId: "session-a" });

    const pending = client.sendData("file_mentions", { query: "src" });
    expect(sent[0]).toMatchObject({
      type: "data_request",
      protocolVersion: 2,
      operation: "file_mentions",
      workspaceId: "workspace-a",
      query: "src",
    });
    client.handleMessage({
      type: "data_response",
      requestId: sent[0].requestId,
      operation: "file_mentions",
      entries: [{ name: "a.ts", relativePath: "src/a.ts", kind: "file" }],
    });

    await expect(pending).resolves.toEqual({
      operation: "file_mentions",
      entries: [{ name: "a.ts", relativePath: "src/a.ts", kind: "file" }],
    });
  });

  test("structured error frames expose the machine code to callers", async () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({ workspaceId: "workspace-a", sessionId: "session-a" });

    const pending = client.sendData("file_write", { path: "a.ts" });
    client.handleMessage({
      type: "error",
      requestId: sent[0].requestId,
      error: { code: "file_conflict", message: "File changed on disk" },
    });

    const error = await pending.catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("File changed on disk");
    // The preview panel branches on the code, never on the human message.
    expect(error.code).toBe("file_conflict");
  });

  test("non-v2 WebSocket endpoints are rejected", () => {
    expect(() => new WebSocketClient("ws://127.0.0.1:49000/ws")).toThrow(
      "HostServer v2 WebSocket URL required",
    );
  });

  test("v2 clients provide data and runtime request helpers", async () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/v2/ws");
    client.ws = { readyState: WebSocket.OPEN, send: (message) => sent.push(JSON.parse(message)) };

    const dataPending = client.sendData("file_read", {});
    expect(sent[0]).toMatchObject({ type: "data_request", protocolVersion: 2 });
    client.handleMessage({
      type: "data_response",
      requestId: sent[0].requestId,
      path: "a.ts",
    });
    await expect(dataPending).resolves.toMatchObject({ path: "a.ts" });

    const runtimePending = client.sendRuntime({ type: "get_state" });
    expect(sent[1]).toMatchObject({ type: "runtime_request", protocolVersion: 2 });
    client.handleMessage({
      type: "runtime_response",
      requestId: sent[1].requestId,
      response: { success: true, data: { isStreaming: false } },
    });
    await expect(runtimePending).resolves.toEqual({ isStreaming: false });
  });
});
