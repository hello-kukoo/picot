// ABOUTME: Server-side v1 facade translating the legacy broker wire onto the v2 core.
// ABOUTME: Test-only prototype proving the existing shell can run unmodified over v2.

// The facade accepts exactly what `public/app/websocket-client.js` emits today
// (client_hello / broker_control / broker_command envelopes) and translates it
// to canonical v2 frames on a shared v2 core, then translates responses and
// events back to v1 shapes. Gap→snapshot recovery lives HERE so the unmodified
// v1 client never sees a sequence concept. Production notes and measured costs
// go in docs/superpowers/specs/2026-08-27-adapter-prototype-evidence.md.

import { brokerCommandToV2, CONTROL_MAP } from "./control-map.js";

const V1_PROTOCOL_VERSION = 1;

let facadeSessionCounter = 0;

export class V1Facade {
  constructor(v2Host, options = {}) {
    this.host = v2Host;
    // A capability-less v1 hello is remote-class; the prototype bridges it to
    // a device token minted by the harness. Production must decide how the
    // legacy remote auth flow maps to v2 device tokens (open design gap).
    this.remoteDeviceToken = options.remoteDeviceToken ?? null;
  }

  /** Register the production-equivalent route knowledge: which port maps to
   * which v2 target. The real broker learns this from upstream traffic; a
   * production facade derives it from the registry/runtime coordinator. */
  registerRoute(port, target) {
    this.__routes = this.__routes ?? new Map();
    this.__routes.set(port, target);
    this.__routesBySession = this.__routesBySession ?? new Map();
    this.__routesBySession.set(target.sessionId, { port, target });
  }

  /** The window's current target, mirroring the broker's single-upstream
   * active-port fallback: used when a control carries no port/session hint
   * (e.g. navigate_tree with port:null). Production derives it from the
   * owner's current workspace snapshot. */
  setDefaultTarget(target) {
    this.__defaultTarget = target;
  }

  createSession({ onClose }) {
    const facade = this;
    let activeTurnId = null;
    const inbound = [];

    const v2 = facade.host.connect(handleV2Frame);
    const clientId = `facade-${++facadeSessionCounter}`;

    // The core's handleFrame returns the frames produced for this connection
    // (responses + same-connection events, acceptance-first); feed them back
    // through the v2→v1 translator.
    function sendV2(frame) {
      for (const outgoing of v2.handleFrame(frame)) handleV2Frame(outgoing);
    }

    function reply(frame) {
      inbound.push(frame);
    }

    // Translate v2 → v1. Ordering comes from the core: responses, then events;
    // a gap triggers the facade-owned snapshot recovery (mirror_sync payload
    // first, withheld increments after).
    function handleV2Frame(frame) {
      if (frame.type === "hello_ack") {
        reply({
          type: "capabilities",
          protocolVersion: V1_PROTOCOL_VERSION,
          class: v2.clientClass === "desktop" ? "native" : "remote",
        });
        return;
      }
      // The facade's own bookkeeping frames (subscribe acks, gap-recovery
      // snapshots) never leak onto the v1 wire as client-visible noise.
      if (frame.type === "runtime_subscribed") return;
      if (frame.type === "error" && String(frame.requestId ?? "").startsWith("facade-internal-")) {
        return;
      }
      if (frame.type === "error") {
        const code = frame.error?.code ?? "internal_error";
        if (frame.requestId == null) {
          if (code === "event_sequence_gap") {
            // Facade-owned recovery: ask the core for snapshots of every
            // subscribed target. The core emits runtime_snapshot first and
            // flushes withheld events after — we translate in that order.
            for (const key of v2.subscriptions) {
              const [workspaceId, sessionId, instanceId] = key.split("|");
              sendV2({
                type: "runtime_snapshot_request",
                requestId: `facade-gap-${key}`,
                target: { workspaceId, sessionId, instanceId },
              });
            }
            return;
          }
          // Connection-scoped failure: the v1 wire has no error surface for
          // handshake/auth failures, so the only honest move is to close with
          // the stable code as the close reason (recorded design gap).
          onClose?.(code);
          return;
        }
        const pending = pendingByRequestId.get(frame.requestId);
        if (pending?.origin === "broker_control") {
          reply({
            type: "control_response",
            requestId: frame.requestId,
            ok: false,
            // v1 error is a plain string; keep the stable code machine-readable.
            error: `${code}: ${frame.error?.message ?? ""}`,
          });
        } else {
          reply({
            type: "command_undeliverable",
            requestId: frame.requestId,
            reason: code,
          });
        }
        return;
      }
      if (frame.type === "runtime_response") {
        // v1 controls resolve exactly once — the v2 acceptance handshake must
        // not leak an empty premature result. Pending acceptances are held;
        // only the terminal response answers the v1 caller.
        if (frame.acceptance === "accepted_pending" || frame.acceptance === "duplicate_pending") {
          const pending = pendingByRequestId.get(frame.requestId);
          if (pending) pending.operationId = frame.operationId;
          return;
        }
        if (frame.acceptance === "duplicate_completed" || frame.acceptance === "completed") {
          const pending = pendingByRequestId.get(frame.requestId);
          if (pending?.origin === "broker_control") {
            reply({
              type: "control_response",
              requestId: frame.requestId,
              ok: true,
              result: frame.response,
            });
          } else {
            reply({ type: "response", requestId: frame.requestId, response: frame.response });
          }
          return;
        }
        return;
      }
      if (frame.type === "host_response" || frame.type === "data_response") {
        const pending = pendingByRequestId.get(frame.requestId);
        const result = frame.type === "host_response" ? frame.result : (frame.sessions ?? frame);
        if (pending?.origin === "broker_control") {
          reply({
            type: "control_response",
            requestId: frame.requestId,
            ok: true,
            result,
          });
        } else {
          // v1 upstream replies to broker_commands arrive as `response` frames
          // the client dispatches as commandResponse (fire-and-forget callers
          // ignore them; correlated callers can consume them).
          reply({ type: "response", requestId: frame.requestId, response: result });
        }
        return;
      }
      if (frame.type === "control_progress") {
        // v1 control_progress has no sequence field; the drop is lossless for
        // the current onProgress(data) consumer contract.
        reply({ type: "control_progress", requestId: frame.requestId, data: frame.data });
        return;
      }
      if (frame.type === "runtime_event") {
        if (frame.event?.type === "agent_start") activeTurnId = frame.event.turnId ?? activeTurnId;
        if (frame.event?.type === "agent_end") activeTurnId = null;
        const route = facade.__routesBySession?.get(frame.target.sessionId);
        reply({
          type: "broker_event",
          protocolVersion: V1_PROTOCOL_VERSION,
          workspaceId: frame.target.workspaceId,
          sessionId: frame.target.sessionId,
          sourcePort: route?.port ?? null,
          // The v1 payload layer wraps every streamed Pi event in an
          // {type:"event", event:{...}} envelope (websocket-client.js case
          // "event" → rpcEvent); the v2 layer carries the bare event.
          payload: { type: "event", event: frame.event },
        });
        return;
      }
      if (frame.type === "runtime_snapshot") {
        // v2 snapshot → v1 mirror_sync payload, broadcast-shaped so the
        // unmodified client dispatches mirrorSync with the fields the UI
        // consumes (port / sessionId / workspaceId / messages).
        const route = facade.__routesBySession?.get(frame.target.sessionId);
        reply({
          type: "broker_event",
          protocolVersion: V1_PROTOCOL_VERSION,
          workspaceId: frame.target.workspaceId,
          sessionId: frame.target.sessionId,
          sourcePort: route?.port ?? null,
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
        return;
      }
      // Unknown v2 frame: surface, never swallow.
      reply({ type: "error", error: `unmapped_v2_frame:${frame.type}` });
    }

    // requestId → { origin } for reply shaping.
    const pendingByRequestId = new Map();

    // Facade-owned subscription lifecycle: the v2 core only delivers events
    // to subscribed connections, but the v1 client has no subscribe concept —
    // the facade subscribes on first target use (production would derive this
    // from the window's bound workspace).
    function ensureSubscribed(target) {
      if (!target) return;
      const key = `${target.workspaceId}|${target.sessionId}|${target.instanceId}`;
      if (v2.subscriptions.has(key)) return;
      sendV2({
        type: "runtime_subscribe",
        requestId: `facade-internal-sub-${key}`,
        target,
      });
    }

    function resolveTarget(value) {
      const sessionId =
        value.sessionId ?? value.payload?.sessionId ?? value.payload?.sessionPath ?? null;
      if (sessionId && facade.__routesBySession?.has(sessionId)) {
        return facade.__routesBySession.get(sessionId).target;
      }
      const sourcePort = typeof value.sourcePort === "number" ? value.sourcePort : null;
      const port = sourcePort ?? (typeof value.args?.port === "number" ? value.args.port : null);
      if (port != null && facade.__routes?.has(port)) {
        return facade.__routes.get(port);
      }
      // Fail closed: the envelope's own workspaceId hint must agree with the
      // default target — a Temporary/unregistered workspace never borrows the
      // registered default.
      if (value.workspaceId && facade.__defaultTarget) {
        return facade.__defaultTarget.workspaceId === value.workspaceId
          ? facade.__defaultTarget
          : null;
      }
      return facade.__defaultTarget ?? null;
    }

    return {
      v2,
      /** Feed one v1 text frame; returns the v1 frames to send back. */
      handleText(text) {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          reply({ type: "error", error: "invalid_json" });
          return drain();
        }
        handleV1Frame(value);
        return drain();
      },
      /** Drain frames produced out-of-band (gap markers, withheld flushes). */
      drain,
    };

    function handleV1Frame(value) {
      const type = value?.type;
      if (type === "client_hello") {
        // v1 hello has no clientId; the facade synthesizes one (mapping note:
        // v1 has no client identity concept).
        if (value.capability) {
          sendV2({
            type: "hello",
            protocolVersion: 2,
            clientType: "desktop",
            clientId,
            desktopCapability: value.capability,
          });
        } else if (facade.remoteDeviceToken) {
          sendV2({
            type: "hello",
            protocolVersion: 2,
            clientType: "remote",
            clientId,
            deviceToken: facade.remoteDeviceToken,
          });
        } else {
          sendV2({
            type: "hello",
            protocolVersion: 2,
            clientType: "remote",
            clientId,
          });
        }
        return;
      }
      if (!v2.authenticated) {
        reply({ type: "error", error: "handshake_required" });
        return;
      }
      if (type === "broker_control") {
        const mapping = CONTROL_MAP[value.command];
        if (!mapping) {
          // Visible failure for unmapped controls; never a silent 200-style ok.
          reply({
            type: "control_response",
            requestId: value.requestId,
            ok: false,
            error: `unimplemented_route: control "${value.command}" has no v2 mapping yet`,
          });
          return;
        }
        const target = resolveTarget(value);
        const ctx = { target, sourcePort: value.args?.port ?? value.sourcePort ?? null };
        const v2Frame = mapping.toV2(value.args ?? {}, ctx);
        const frame = { ...v2Frame, requestId: value.requestId };
        if (mapping.mutation) {
          frame.idempotencyKey = `v1-ctl-${value.requestId}`;
        }
        pendingByRequestId.set(value.requestId, { origin: "broker_control" });
        if (frame.target) ensureSubscribed(frame.target);
        sendV2(frame);
        return;
      }
      if (type === "broker_command") {
        const target = resolveTarget(value);
        if (!target) {
          reply({
            type: "command_undeliverable",
            requestId: value.requestId,
            reason: "no_route",
          });
          return;
        }
        ensureSubscribed(target);
        const mapped = brokerCommandToV2(value.payload, value.requestId, {
          target,
          activeTurnId,
        });
        if (mapped.error) {
          reply({
            type: "command_undeliverable",
            requestId: value.requestId,
            reason: mapped.error,
          });
          return;
        }
        pendingByRequestId.set(value.requestId, { origin: "broker_command" });
        sendV2(mapped.frame);
        return;
      }
      if (type === "mirror_sync_request") {
        const target = resolveTarget(value);
        if (!target) {
          reply({ type: "command_undeliverable", requestId: value.requestId, reason: "no_route" });
          return;
        }
        ensureSubscribed(target);
        pendingByRequestId.set(value.requestId, { origin: "broker_command" });
        sendV2({
          type: "runtime_snapshot_request",
          requestId: value.requestId,
          target,
        });
        return;
      }
      // Unknown v1 frame: explicit error, never silence.
      reply({ type: "error", error: `unmapped_v1_frame:${type}` });
    }

    function drain() {
      const frames = inbound.splice(0, inbound.length);
      return frames;
    }
  }
}
