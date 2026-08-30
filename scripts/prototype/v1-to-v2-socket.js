// ABOUTME: Client-side wrap adapter turning the unmodified v1 WebSocketClient into a v2 speaker.
// ABOUTME: Installs as the global WebSocket so production transport code stays untouched.

// Wrap-mode prototype: `public/app/websocket-client.js` is imported AS-IS and
// kept unmodified. The adapter masquerades as the WebSocket class: everything
// the client sends is translated v1→v2 onto the wire; everything the wire
// returns is translated v2→v1 into `onmessage`. Gap→snapshot recovery runs on
// the CLIENT side here (contrast with the server facade, where the unmodified
// client never learns about sequences).

import {
  brokerCommandToV2,
  CONTROL_MAP,
  DEFERRED_V1_SURFACES,
  deferredSurfaceError,
} from "./control-map.js";

let adapterCounter = 0;
// Capability cache scoped to this module (= one page/window realm). The
// production client deletes the injected global after the first read, but v1
// reconnects create a NEW socket instance — a per-socket cache would lose the
// credential. D3 capabilities are per-window, in-memory, non-persistent, so a
// module-level cache is the correct lifetime (never storage, never URL).
let realmCapability = null;

/**
 * wire: { send(text) } — outbound v2 JSON text.
 * The harness (or a real socket transport) calls `adapter.receive(text)` with
 * inbound v2 JSON text from the server.
 */
export class V1ToV2Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, wire) {
    this.url = url;
    this.wire = wire;
    this.readyState = V1ToV2Socket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this.id = `adapter-${++adapterCounter}`;
    this.authenticated = false;
    this.activeTurnId = null;
    this.subscriptions = new Map(); // targetKey → target
    // Client-side gap recovery state: buffer runtime_events between the gap
    // marker and the snapshot, then emit mirror_sync FIRST (§7.3 order).
    this.gapRecovery = null;

    // The production client deletes __PICOT_NATIVE_CAPABILITY__ after the
    // first read, but v1 reconnects re-run _sendClientHello. The adapter must
    // cache the capability in memory (never in storage) to survive reconnects.
    queueMicrotask(() => {
      this.readyState = V1ToV2Socket.OPEN;
      this.onopen?.();
    });
  }

  send(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    this.__sendV1(frame);
  }

  close() {
    this.readyState = V1ToV2Socket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client closed" });
  }

  receive(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.__emitV1({ type: "error", error: "invalid_json" });
      return;
    }
    this.__handleV2(frame);
  }

  // ── v1 → v2 ────────────────────────────────────────────────────────────────

  __readCapability() {
    if (realmCapability) return realmCapability;
    const injected = globalThis.__PICOT_NATIVE_CAPABILITY__;
    if (typeof injected === "string" && injected) realmCapability = injected;
    return realmCapability;
  }

  __sendV1(frame) {
    if (frame?.type === "client_hello") {
      // The real v1 client reads+deletes the injected global and forwards the
      // capability inside the hello frame. Prime the realm cache from the
      // inline capability too: the `??` fallback below only populates it when
      // the inline field is absent, so without priming a reconnect hello
      // (global already deleted) would find the cache empty and silently
      // downgrade to an unauthenticated remote hello.
      if (typeof frame.capability === "string" && frame.capability) {
        realmCapability ??= frame.capability;
      }
      const capability = frame.capability ?? this.__readCapability();
      this.__sendV2({
        type: "hello",
        protocolVersion: 2,
        clientType: capability ? "desktop" : "remote",
        clientId: this.id,
        ...(capability ? { desktopCapability: capability } : {}),
      });
      return;
    }
    if (!this.authenticated) {
      this.__emitV1({ type: "error", error: "handshake_required" });
      return;
    }
    if (frame?.type === "broker_control") {
      const mapping = CONTROL_MAP[frame.command];
      if (!mapping) {
        this.__emitV1({
          type: "control_response",
          requestId: frame.requestId,
          ok: false,
          error: DEFERRED_V1_SURFACES.has(frame.command)
            ? deferredSurfaceError(frame.command)
            : `unimplemented_route: control "${frame.command}" has no v2 mapping yet`,
        });
        return;
      }
      const ctx = { target: this.__targetFromRouting(frame), sourcePort: frame.args?.port ?? null };
      const v2Frame = { ...mapping.toV2(frame.args ?? {}, ctx), requestId: frame.requestId };
      if (mapping.mutation) v2Frame.idempotencyKey = `v1-ctl-${frame.requestId}`;
      this.__ensureSubscribed(v2Frame.target);
      this.__sendV2(v2Frame);
      return;
    }
    if (frame?.type === "broker_command") {
      const target = this.__targetFromRouting(frame);
      if (!target) {
        this.__emitV1({
          type: "command_undeliverable",
          requestId: frame.requestId,
          reason: "no_route",
        });
        return;
      }
      this.__ensureSubscribed(target);
      const mapped = brokerCommandToV2(frame.payload, frame.requestId, {
        target,
        activeTurnId: this.activeTurnId,
      });
      if (mapped.error) {
        this.__emitV1({
          type: "command_undeliverable",
          requestId: frame.requestId,
          reason: mapped.error,
        });
        return;
      }
      this.__sendV2(mapped.frame);
      return;
    }
    // Deferred P4/P5/P6 families fail with stable route code. Other unknown
    // frames remain protocol errors, never silent forwards.
    this.__emitV1({
      type: "error",
      error: DEFERRED_V1_SURFACES.has(frame?.type)
        ? deferredSurfaceError(frame.type)
        : `unmapped_v1_frame:${frame?.type}`,
    });
  }

  __targetFromRouting(frame) {
    const sessionId = frame.sessionId ?? frame.payload?.sessionId ?? null;
    const bySession = sessionId ? this.__routes?.bySession.get(sessionId) : null;
    if (bySession) return bySession.target;
    const port =
      typeof frame.sourcePort === "number"
        ? frame.sourcePort
        : typeof frame.args?.port === "number"
          ? frame.args.port
          : null;
    if (port != null && this.__routes?.byPort.has(port)) {
      return this.__routes.byPort.get(port);
    }
    // Fail closed: the v1 envelope's own workspaceId hint must agree with the
    // fallback target — a Temporary/unregistered workspace never borrows the
    // registered default target.
    if (frame.workspaceId && this.__defaultTarget) {
      return this.__defaultTarget.workspaceId === frame.workspaceId ? this.__defaultTarget : null;
    }
    return this.__defaultTarget ?? null;
  }

  /** Prototype bootstrap: seed the target resolution the production adapter
   * would derive from /v2/bootstrap + the window route. */
  seedRoutes({ defaultTarget, byPort = new Map(), bySession = new Map() }) {
    this.__defaultTarget = defaultTarget ?? null;
    this.__routes = { byPort, bySession };
  }

  __ensureSubscribed(target) {
    if (!target) return;
    const key = `${target.workspaceId}|${target.sessionId}|${target.instanceId}`;
    if (this.subscriptions.has(key)) return;
    this.subscriptions.set(key, target);
    this.__sendV2({
      type: "runtime_subscribe",
      requestId: `${this.id}-sub-${key}`,
      target,
    });
  }

  // ── v2 → v1 ────────────────────────────────────────────────────────────────

  __sendV2(frame) {
    this.wire.send(JSON.stringify(frame));
  }

  __emitV1(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
  }

  __handleV2(frame) {
    if (frame.type === "hello_ack") {
      this.authenticated = true;
      this.__emitV1({
        type: "capabilities",
        protocolVersion: 1,
        class: "native",
      });
      return;
    }
    if (frame.type === "error") {
      const code = frame.error?.code ?? "internal_error";
      if (code === "event_sequence_gap") {
        // Client-side recovery: request snapshots for every subscribed target
        // and buffer runtime_events until each snapshot lands (mirror_sync
        // payload first, then withheld increments).
        this.gapRecovery = { pending: new Set(this.subscriptions.keys()), buffer: [] };
        for (const target of this.subscriptions.values()) {
          this.__sendV2({
            type: "runtime_snapshot_request",
            requestId: `${this.id}-gap-${target.sessionId}`,
            target,
          });
        }
        return;
      }
      if (frame.requestId == null) {
        // Handshake-level failure surfaces as a closed socket; the v1 wire has
        // no error frame for this (design gap recorded in the evidence doc).
        this.readyState = V1ToV2Socket.CLOSED;
        this.onclose?.({ code: 1008, reason: code });
        return;
      }
      const isControl = frame.requestId.startsWith("ctl-");
      if (isControl) {
        this.__emitV1({
          type: "control_response",
          requestId: frame.requestId,
          ok: false,
          error: `${code}: ${frame.error?.message ?? ""}`,
        });
      } else {
        this.__emitV1({
          type: "command_undeliverable",
          requestId: frame.requestId,
          reason: code,
        });
      }
      return;
    }
    if (frame.type === "runtime_response") {
      // v1 controls resolve exactly once: hold the acceptance handshake, answer
      // only on the terminal response (mirror of the facade policy).
      if (frame.acceptance === "accepted_pending" || frame.acceptance === "duplicate_pending") {
        return;
      }
      if (frame.acceptance === "completed" || frame.acceptance === "duplicate_completed") {
        this.__emitV1({
          type: frame.requestId?.startsWith("ctl-") ? "control_response" : "response",
          requestId: frame.requestId,
          ...(frame.requestId?.startsWith("ctl-")
            ? { ok: true, result: frame.response }
            : { response: frame.response }),
        });
      }
      return;
    }
    if (
      frame.type === "host_response" ||
      frame.type === "data_response" ||
      frame.type === "runtime_subscribed" ||
      frame.type === "operation_status"
    ) {
      if (frame.type === "runtime_subscribed") return; // internal bookkeeping
      const result =
        frame.type === "data_response"
          ? (frame.sessions ?? frame.results ?? frame.dashboard ?? frame)
          : frame.type === "operation_status"
            ? frame.state
            : frame.result;
      const isControl = frame.requestId?.startsWith("ctl-");
      if (isControl) {
        this.__emitV1({
          type: "control_response",
          requestId: frame.requestId,
          ok: true,
          result,
        });
      } else {
        this.__emitV1({ type: "response", requestId: frame.requestId, response: result });
      }
      return;
    }
    if (frame.type === "control_progress") {
      this.__emitV1({ type: "control_progress", requestId: frame.requestId, data: frame.data });
      return;
    }
    if (frame.type === "runtime_event") {
      if (frame.event?.type === "agent_start")
        this.activeTurnId = frame.event.turnId ?? this.activeTurnId;
      if (frame.event?.type === "agent_end") this.activeTurnId = null;
      // v1 payloads wrap streamed events in {type:"event", event:{...}};
      // the v2 wire carries the bare event.
      const payload = { type: "event", event: frame.event };
      if (this.gapRecovery) {
        this.gapRecovery.buffer.push({
          type: "broker_event",
          protocolVersion: 1,
          workspaceId: frame.target.workspaceId,
          sessionId: frame.target.sessionId,
          sourcePort: this.__portForTarget(frame.target),
          payload,
        });
        return;
      }
      this.__emitV1({
        type: "broker_event",
        protocolVersion: 1,
        workspaceId: frame.target.workspaceId,
        sessionId: frame.target.sessionId,
        sourcePort: this.__portForTarget(frame.target),
        payload,
      });
      return;
    }
    if (frame.type === "runtime_snapshot") {
      // v2 snapshot → v1 mirror_sync broker_event (this covers both an
      // explicit mirror_sync_request reply and gap-recovery snapshots).
      this.__emitV1({
        type: "broker_event",
        protocolVersion: 1,
        workspaceId: frame.target.workspaceId,
        sessionId: frame.target.sessionId,
        sourcePort: this.__portForTarget(frame.target),
        payload: {
          type: "mirror_sync",
          workspaceId: frame.target.workspaceId,
          sessionId: frame.target.sessionId,
          sequence: frame.sequence,
          state: frame.state,
          messages: frame.state?.messages ?? [],
          stats: frame.state?.stats ?? {},
        },
      });
      if (this.gapRecovery) {
        const key = `${frame.target.workspaceId}|${frame.target.sessionId}|${frame.target.instanceId}`;
        this.gapRecovery.pending.delete(key);
        if (this.gapRecovery.pending.size === 0) {
          for (const buffered of this.gapRecovery.buffer) this.__emitV1(buffered);
          this.gapRecovery = null;
        }
      }
      return;
    }
    // Unknown v2 frame: surface as v1 error; the v1 client tolerates unknown
    // types with a console.warn, and must keep processing later frames.
    this.__emitV1({ type: "error", error: `unmapped_v2_frame:${frame.type}` });
  }

  __portForTarget(target) {
    for (const [port, candidate] of this.__routes?.byPort ?? new Map()) {
      if (candidate === target) return port;
    }
    for (const [sessionId, entry] of this.__routes?.bySession ?? new Map()) {
      if (sessionId === target.sessionId) return entry.port ?? null;
    }
    return null;
  }
}

/** Install the adapter as the global WebSocket for wrap-mode boot.
 * Returns a restore() that puts the previous class back. */
export function installV2Adapter(globalScope, wire) {
  const previous = globalScope.WebSocket;
  globalScope.WebSocket = class extends V1ToV2Socket {
    constructor(url) {
      super(url, wire);
    }
  };
  // WebSocketClient compares `readyState === WebSocket.OPEN` against the
  // global constant; keep the numeric contract.
  globalScope.WebSocket.OPEN = V1ToV2Socket.OPEN;
  globalScope.WebSocket.CONNECTING = V1ToV2Socket.CONNECTING;
  globalScope.WebSocket.CLOSING = V1ToV2Socket.CLOSING;
  globalScope.WebSocket.CLOSED = V1ToV2Socket.CLOSED;
  return () => {
    globalScope.WebSocket = previous;
  };
}

/** Test-only: clear the realm-scoped capability cache between fixtures. */
export function __resetRealmCapabilityForTests() {
  realmCapability = null;
}
