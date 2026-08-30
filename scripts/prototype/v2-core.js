// ABOUTME: Test-only canonical protocol v2 core mirroring the approved Gate B wire contract.
// ABOUTME: Hello/capability validation, Registered-only targets, operation idempotency,
// ABOUTME: per-target event sequences, gap→snapshot ordering, and the Gate B command-class matrix.

// This module is a prototype stand-in for the production HostServer/HostRouter
// v2 surface. It implements the CONTRACT (stable codes, frame shapes,
// ordering rules) from docs/superpowers/specs/2026-08-27-protocol-v2-capability.md
// §3–§7 — including checks the current production host does NOT perform yet
// (desktop capability validation, HostClientContext, target authorization).
// Divergences from current src-tauri behavior are listed in the prototype
// evidence doc; nothing here touches production code.

import { isV2MutationCommand } from "./control-map.js";

export const V2_PROTOCOL_VERSION = 2;

const HOST_OPERATIONS = new Set([
  "open_workspace",
  "new_session",
  "switch_session",
  "fork",
  "navigate_tree",
  "stop_instance",
  "spawn_session_process",
  "pick_folder",
  "open_in_app",
  "open_external",
  "skill_install_links",
  "workspace_target_prepare",
  "workspace_transition_commit",
  "compat_api_issue",
]);

function stableError(requestId, code, message) {
  return {
    type: "error",
    requestId: requestId ?? null,
    error: { code, message },
  };
}

function targetKey(target) {
  return `${target.workspaceId}|${target.sessionId}|${target.instanceId}`;
}

let capabilityCounter = 0;
let deviceCounter = 0;
let clientCounter = 0;
let operationCounter = 0;
let compatTokenCounter = 0;

/**
 * The shared host: registries (capabilities, workspaces, device tokens),
 * operation records, per-target event sequences, and fan-out to connections.
 */
export function createV2Host() {
  // capability token → { ownerId, workspaceId, generation }
  const capabilities = new Map();
  // device token → ownerId (paired-remote identity)
  const deviceTokens = new Map();
  // workspaceId → { ownerId, sessionId, instanceId } (Registered only)
  const workspaces = new Map();
  // pending workspace transitions per owner: ownerId → transitionGeneration
  const pendingTransitions = new Map();
  // operationId → record { idempotencyKey, scope, state, terminalResponse }
  const operations = new Map();
  // `${ownerId}|${workspaceId}|${sessionId}|${idempotencyKey}` → operationId
  const idempotencyIndex = new Map();
  // targetKey → monotonic sequence
  const sequences = new Map();
  // targetKey → snapshot store { sequence, lifecycle, messages, stats }
  const snapshots = new Map();
  // targetKey → active turnId (scripted runtime turn state)
  const activeTurns = new Map();
  const connections = new Set();
  // compat tokens minted over the authenticated WS; bind an owner for the
  // retained /api/* compatibility middleware.
  const compatTokens = new Map();
  // Test hooks: `holdPrompts` keeps a prompt turn mid-flight so abort/
  // stale-turn/replay behavior can be exercised against a genuinely active
  // turn (the scripted runtime otherwise completes synchronously).
  const testHooks = { holdPrompts: false };
  const pendingPrompts = new Map();

  function fanoutEvent(target, event, meta = {}) {
    const key = targetKey(target);
    const sequence = nextSequence(target);
    const frame = {
      type: "runtime_event",
      target,
      sequence,
      ...(meta.operationId ? { operationId: meta.operationId } : {}),
      ...(meta.turnId ? { turnId: meta.turnId } : {}),
      event,
    };
    for (const connection of connections) {
      if (connection.subscriptions.has(key)) connection.deliverEvent(frame);
    }
    // Maintain the snapshot watermark even with no live subscriber so a later
    // snapshot request reports the true current sequence.
    const snapshot = snapshots.get(key) ?? {
      sequence: 0,
      lifecycle: "Ready",
      messages: [],
      stats: {},
    };
    snapshot.sequence = sequence;
    if (event.type === "message_start") {
      snapshot.messages.push({ id: event.messageId, role: "assistant", text: "" });
    } else if (event.type === "message_update" && event.text_delta) {
      const last = snapshot.messages[snapshot.messages.length - 1];
      if (last) last.text = `${last.text}${event.text_delta}`;
    }
    snapshots.set(key, snapshot);
    return frame;
  }

  function nextSequence(target) {
    const key = targetKey(target);
    const next = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, next);
    return next;
  }

  function createConnection(onFrame) {
    const connection = {
      id: `client-${++clientCounter}`,
      authenticated: false,
      clientClass: null, // "desktop" | "remote"
      ownerId: null,
      workspaceId: null,
      generation: null,
      subscriptions: new Set(),
      // targetKey → sequence watermark after which events are withheld while
      // the subscriber is stale after an event_sequence_gap (§7.3: snapshot
      // before incremental).
      staleSince: null,
      withheld: new Map(),
      // Frames produced while handling one inbound frame queue here so the
      // requesting connection sees acceptance → events → progress in order.
      __outbound: null,

      send(text) {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          onFrame(stableError(null, "invalid_json", "Invalid JSON frame"));
          return;
        }
        for (const outgoing of connection.handleFrame(frame)) onFrame(outgoing);
      },

      handleFrame(frame) {
        const out = [];
        const push = out.push.bind(out);
        connection.__outbound = out;
        try {
          if (!connection.authenticated) {
            handleHello(frame, push);
          } else {
            handleAuthenticated(frame, push);
          }
        } finally {
          connection.__outbound = null;
        }
        return out;
      },

      deliverEvent(frame) {
        const key = targetKey(frame.target);
        const staleSince = connection.staleSince?.get(key);
        if (staleSince != null && frame.sequence > staleSince) {
          const queue = connection.withheld.get(key) ?? [];
          queue.push(frame);
          connection.withheld.set(key, queue);
          return;
        }
        // During an inbound frame, queue so acceptance-first ordering holds.
        if (connection.__outbound) connection.__outbound.push(frame);
        else onFrame(frame);
      },

      // Simulate a broadcast lag: the subscriber misses everything after the
      // given sequence and must re-hydrate from a snapshot.
      forceLag(target, missedAfterSequence) {
        connection.staleSince = connection.staleSince ?? new Map();
        connection.staleSince.set(targetKey(target), missedAfterSequence);
        onFrame(
          stableError(null, "event_sequence_gap", "Runtime events were missed; request a snapshot"),
        );
      },
    };

    function handleHello(frame, push) {
      if (frame?.type !== "hello") {
        push(stableError(null, "handshake_required", "First frame must be hello"));
        return;
      }
      if (frame.protocolVersion !== V2_PROTOCOL_VERSION) {
        push(
          stableError(
            null,
            "protocol_mismatch",
            `Picot protocol v${V2_PROTOCOL_VERSION} is required`,
          ),
        );
        return;
      }
      if (typeof frame.clientId !== "string" || !frame.clientId) {
        push(stableError(null, "invalid_client_id", "clientId is required"));
        return;
      }
      if (frame.clientType === "desktop") {
        // Gate B §3.2: desktop MUST carry a capability; a missing/invalid/
        // expired capability never downgrades to remote or anonymous.
        const capability = capabilities.get(frame.desktopCapability);
        if (!capability) {
          push(stableError(null, "unauthenticated", "Desktop capability rejected"));
          return;
        }
        connection.clientClass = "desktop";
        connection.ownerId = capability.ownerId;
        connection.workspaceId = capability.workspaceId;
        connection.generation = capability.generation;
      } else if (frame.clientType === "remote") {
        const owner = deviceTokens.get(frame.deviceToken);
        if (!owner) {
          push(stableError(null, "unauthorized_device", "Device token rejected"));
          return;
        }
        connection.clientClass = "remote";
        connection.ownerId = owner;
      } else {
        push(stableError(null, "invalid_client_type", "Unsupported client type"));
        return;
      }
      connection.authenticated = true;
      connections.add(connection);
      // hello_ack echoes no credential, root, token, or target (§3.2).
      push({ type: "hello_ack", protocolVersion: V2_PROTOCOL_VERSION });
    }

    function authorizeTarget(target) {
      if (!target || typeof target !== "object") {
        return { error: "invalid_target" };
      }
      const workspace = workspaces.get(target.workspaceId);
      if (!workspace) {
        // Temporary synthetic workspace IDs fail closed (D5 / Gate B §6.1).
        return {
          error: target.workspaceId?.startsWith("temporary-")
            ? "not_registered"
            : "workspace_not_found",
        };
      }
      if (workspace.ownerId !== connection.ownerId) {
        return { error: "cross_workspace" };
      }
      if (target.sessionId !== workspace.sessionId || target.instanceId !== workspace.instanceId) {
        return { error: "unknown_target" };
      }
      return { workspace };
    }

    function beginOperation({ requestId, target, commandType, idempotencyKey, push }) {
      if (!idempotencyKey) {
        push(
          stableError(
            requestId,
            "idempotency_key_required",
            "Runtime mutations require idempotencyKey",
          ),
        );
        return null;
      }
      const scopeKey = `${connection.ownerId}|${target.workspaceId}|${target.sessionId}|${idempotencyKey}`;
      const existing = idempotencyIndex.get(scopeKey);
      if (existing) {
        const record = operations.get(existing);
        if (record.state === "Pending") {
          push({
            type: "runtime_response",
            requestId,
            acceptance: "duplicate_pending",
            operationId: record.operationId,
            response: {},
          });
        } else {
          push({
            type: "runtime_response",
            requestId,
            acceptance: "duplicate_completed",
            operationId: record.operationId,
            response: record.terminalResponse ?? {},
          });
        }
        return null;
      }
      const operationId = `op-${++operationCounter}`;
      operations.set(operationId, {
        operationId,
        idempotencyKey,
        scope: {
          ownerId: connection.ownerId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
        },
        commandType,
        state: "Pending",
        terminalResponse: null,
      });
      idempotencyIndex.set(scopeKey, operationId);
      push({
        type: "runtime_response",
        requestId,
        acceptance: "accepted_pending",
        operationId,
        response: {},
      });
      return operationId;
    }

    function completeOperation(operationId, terminalResponse) {
      const record = operations.get(operationId);
      if (record) {
        record.state = "Completed";
        record.terminalResponse = terminalResponse;
      }
    }

    // Scripted deterministic runtime: `prompt` starts a turn that streams a
    // fixed event sequence and completes; `abort` fast-forwards the active
    // turn; reads answer from the snapshot store.
    function runScriptedCommand({ target, command, operationId, push }) {
      const key = targetKey(target);
      if (command.type === "prompt") {
        const turnId = `turn-${operationId}`;
        activeTurns.set(key, turnId);
        fanoutEvent(target, { type: "agent_start", turnId }, { turnId });
        fanoutEvent(
          target,
          { type: "message_start", turnId, messageId: `msg-${operationId}` },
          { turnId },
        );
        const finishPrompt = () => {
          fanoutEvent(
            target,
            {
              type: "message_update",
              turnId,
              messageId: `msg-${operationId}`,
              text_delta: "hello ",
            },
            { turnId },
          );
          fanoutEvent(
            target,
            {
              type: "message_update",
              turnId,
              messageId: `msg-${operationId}`,
              text_delta: "world",
            },
            { turnId },
          );
          fanoutEvent(
            target,
            { type: "message_end", turnId, messageId: `msg-${operationId}` },
            { turnId },
          );
          fanoutEvent(target, { type: "agent_end", turnId }, { operationId, turnId });
          activeTurns.delete(key);
          completeOperation(operationId, { ok: true });
          push({
            type: "control_progress",
            requestId: command.__requestId,
            sequence: 1,
            data: { phase: "done", percent: 100 },
          });
        };
        if (testHooks.holdPrompts) {
          pendingPrompts.set(key, () => {
            pendingPrompts.delete(key);
            finishPrompt();
          });
          return;
        }
        finishPrompt();
        return;
      }
      if (command.type === "abort") {
        const activeTurnId = activeTurns.get(key);
        if (command.turnId !== activeTurnId) {
          // Stale/ended/superseded turn: success no-op, NEVER forwarded to a
          // successor turn (§7.2). Abort consumes no idempotency slot.
          push({
            type: "runtime_response",
            requestId: command.__requestId,
            acceptance: "completed",
            response: { staleTurn: true, aborted: false },
          });
          return;
        }
        fanoutEvent(
          target,
          { type: "agent_end", turnId: activeTurnId, aborted: true },
          { turnId: activeTurnId },
        );
        activeTurns.delete(key);
        pendingPrompts.delete(key);
        push({
          type: "runtime_response",
          requestId: command.__requestId,
          acceptance: "completed",
          response: { aborted: true },
        });
        return;
      }
      if (command.type === "get_messages") {
        const snapshot = snapshots.get(key) ?? { messages: [] };
        push({
          type: "runtime_response",
          requestId: command.__requestId,
          acceptance: "completed",
          response: { messages: snapshot.messages },
        });
        return;
      }
      // Session-lifecycle mutations the prototype accepts but does not script
      // (new_session/fork/navigate_tree): complete immediately with a marker.
      completeOperation(operationId, { ok: true, command: command.type });
      push({
        type: "runtime_response",
        requestId: command.__requestId,
        acceptance: "completed",
        response: { ok: true, command: command.type },
      });
    }

    function handleAuthenticated(frame, push) {
      const requestId = frame.requestId;
      switch (frame.type) {
        case "runtime_subscribe": {
          const auth = authorizeTarget(frame.target);
          if (auth.error) {
            push(stableError(requestId, auth.error, `Target rejected: ${auth.error}`));
            return;
          }
          connection.subscriptions.add(targetKey(frame.target));
          push({ type: "runtime_subscribed", requestId });
          return;
        }
        case "runtime_request": {
          const auth = authorizeTarget(frame.target);
          if (auth.error) {
            push(stableError(requestId, auth.error, `Target rejected: ${auth.error}`));
            return;
          }
          const commandType = frame.command?.type;
          if (!commandType) {
            push(stableError(requestId, "invalid_command", "Runtime command type is required"));
            return;
          }
          if (commandType === "abort") {
            if (!frame.command.turnId) {
              push(stableError(requestId, "invalid_command", "abort requires turnId"));
              return;
            }
            runScriptedCommand({
              target: frame.target,
              command: { ...frame.command, __requestId: requestId },
              operationId: null,
              push,
            });
            return;
          }
          const isMutation = frame.idempotencyKey != null || requiresKey(commandType);
          if (isMutation) {
            const operationId = beginOperation({
              requestId,
              target: frame.target,
              commandType,
              idempotencyKey: frame.idempotencyKey,
              push,
            });
            if (!operationId) return;
            runScriptedCommand({
              target: frame.target,
              command: { ...frame.command, __requestId: requestId },
              operationId,
              push,
            });
            return;
          }
          runScriptedCommand({
            target: frame.target,
            command: { ...frame.command, __requestId: requestId },
            operationId: null,
            push,
          });
          return;
        }
        case "runtime_snapshot_request": {
          const auth = authorizeTarget(frame.target);
          if (auth.error) {
            push(stableError(requestId, auth.error, `Target rejected: ${auth.error}`));
            return;
          }
          const key = targetKey(frame.target);
          const snapshot = snapshots.get(key) ?? {
            sequence: 0,
            lifecycle: "Ready",
            messages: [],
            stats: {},
          };
          push({
            type: "runtime_snapshot",
            requestId,
            target: frame.target,
            sequence: snapshot.sequence,
            state: {
              lifecycle: snapshot.lifecycle,
              messages: snapshot.messages,
              stats: snapshot.stats,
            },
          });
          // The snapshot clears the stale flag and flushes withheld events
          // AFTER the snapshot frame (§7.3 reconnect order).
          if (connection.staleSince?.has(key)) {
            connection.staleSince.delete(key);
            for (const withheldFrame of connection.withheld.get(key) ?? []) {
              onFrame(withheldFrame);
            }
            connection.withheld.delete(key);
          }
          return;
        }
        case "host_request": {
          // Gate B §6.3: picker / system open / skills / workspace transition
          // are NativeDesktop-only; remote defaults to deny.
          if (connection.clientClass !== "desktop") {
            push(
              stableError(
                requestId,
                "forbidden_class",
                `Host operation ${frame.operation} is NativeDesktop only`,
              ),
            );
            return;
          }
          if (!HOST_OPERATIONS.has(frame.operation)) {
            push(stableError(requestId, "unknown_host_operation", "Unsupported host operation"));
            return;
          }
          if (frame.operation === "workspace_target_prepare") {
            const transitionGeneration = (pendingTransitions.get(connection.ownerId) ?? 0) + 1;
            pendingTransitions.set(connection.ownerId, transitionGeneration);
            push({
              type: "host_response",
              requestId,
              operation: frame.operation,
              result: { transitionGeneration },
            });
            return;
          }
          if (frame.operation === "workspace_transition_commit") {
            const pending = pendingTransitions.get(connection.ownerId);
            if (pending !== frame.transitionGeneration) {
              push(
                stableError(
                  requestId,
                  "stale_generation",
                  "transitionGeneration does not match the pending transition",
                ),
              );
              return;
            }
            pendingTransitions.delete(connection.ownerId);
            push({
              type: "host_response",
              requestId,
              operation: frame.operation,
              result: { workspaceGeneration: frame.transitionGeneration },
            });
            return;
          }
          if (frame.operation === "compat_api_issue") {
            const token = `compat-${++compatTokenCounter}`;
            compatTokens.set(token, connection.ownerId);
            push({
              type: "host_response",
              requestId,
              operation: frame.operation,
              result: { token },
            });
            return;
          }
          push({
            type: "host_response",
            requestId,
            operation: frame.operation,
            result: hostOperationResult(frame.operation),
          });
          return;
        }
        case "data_request": {
          if (frame.operation !== "list_sessions") {
            push(stableError(requestId, "unknown_data_operation", "Unsupported data operation"));
            return;
          }
          const workspace = workspaces.get(frame.workspaceId);
          if (!workspace) {
            push(stableError(requestId, "workspace_not_found", "Workspace is not registered"));
            return;
          }
          if (workspace.ownerId !== connection.ownerId) {
            push(stableError(requestId, "cross_workspace", "Workspace belongs to another owner"));
            return;
          }
          push({
            type: "data_response",
            requestId,
            operation: "list_sessions",
            sessions: [{ sessionId: workspace.sessionId, instanceId: workspace.instanceId }],
          });
          return;
        }
        case "operation_status_request": {
          const record = operations.get(frame.operationId);
          if (!record) {
            push(stableError(requestId, "operation_not_found", "Unknown operation"));
            return;
          }
          if (record.scope.ownerId !== connection.ownerId) {
            push(stableError(requestId, "cross_workspace", "Operation belongs to another owner"));
            return;
          }
          push({
            type: "operation_status",
            requestId,
            operationId: record.operationId,
            state: record.state,
          });
          return;
        }
        default:
          push(stableError(requestId, "unknown_frame_type", "Unsupported protocol v2 frame type"));
      }
    }

    return connection;
  }

  // Session-lifecycle translations that arrive without an idempotencyKey still
  // count as mutations when the control map marked them so; the core itself
  // only enforces the shared manifest for broker_command-shaped commands.
  function requiresKey(commandType) {
    return isV2MutationCommand(commandType);
  }

  const host = {
    capabilities,
    deviceTokens,
    workspaces,
    operations,
    compatTokens,

    registerWorkspace({ workspaceId, ownerId, sessionId, instanceId }) {
      workspaces.set(workspaceId, { ownerId, sessionId, instanceId });
    },

    mintDesktopCapability({ ownerId, workspaceId, generation }) {
      const token = `cap-${++capabilityCounter}-${Math.random().toString(36).slice(2, 8)}`;
      capabilities.set(token, { ownerId, workspaceId, generation });
      return token;
    },

    registerDeviceToken(ownerId) {
      const token = `device-${++deviceCounter}`;
      deviceTokens.set(token, ownerId);
      return token;
    },

    connect(onFrame) {
      return createConnection(onFrame);
    },

    // Test hooks for the contract suite (holdPrompts / flushPrompt create a
    // genuinely active turn window in the scripted runtime).
    __test: {
      get holdPrompts() {
        return testHooks.holdPrompts;
      },
      set holdPrompts(value) {
        testHooks.holdPrompts = value;
      },
      flushPrompt(target) {
        const key = targetKey(target);
        const resume = pendingPrompts.get(key);
        if (resume) resume();
      },
    },

    // Test hook: force a turn on a target without going through a connection
    // (used to drive events while a subscriber is mid-frame).
    __fanout: fanoutEvent,
  };

  return host;
}

function hostOperationResult(operation) {
  switch (operation) {
    case "pick_folder":
      return { path: "/tmp/picked-folder" };
    case "open_in_app":
    case "open_external":
      return { opened: true };
    case "skill_install_links":
      return { installed: true };
    default:
      return {};
  }
}
