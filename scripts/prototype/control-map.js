// ABOUTME: Maps representative legacy broker v1 controls to canonical v2 wire frames.
// ABOUTME: Shared by the server-side v1 facade and the client-side wrap adapter prototype.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Canonical mutation classification comes from the same single source the Rust
// router uses (`shared/mutation-types.json`, see P0 in the migration design).
// Controls mapped to `runtime_request` that mutate session state must carry an
// idempotencyKey even when the shared manifest does not list them, because the
// manifest classifies Pi stdin RPC commands, not broker lifecycle controls.
const MUTATION_TYPES = new Set(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../shared/mutation-types.json"), "utf8"),
  ),
);

export function isV2MutationCommand(commandType) {
  return MUTATION_TYPES.has(commandType);
}

/**
 * Representative v1 broker_control → v2 mapping table.
 *
 * Every entry names:
 * - `toV2(args, ctx)`: builds the v2 frame. `ctx` carries the resolved routing
 *   context (`{ workspaceId, sessionId, instanceId, sourcePort }`) and a
 *   `targetFor(kind)` resolver.
 * - `kind`: `runtime` (runtime_request) or `host` (host_request lifecycle op).
 * - `desktopOnly`: per the Gate B §6.3 command-class baseline, host controls
 *   (picker / system open / skills / workspace transition) are NativeDesktop
 *   only; PairedRemote defaults to deny.
 * - `mutation`: the translated v2 frame requires an idempotencyKey.
 * - `category`: which D-GAP/GD-2 control class the entry represents.
 *
 * The full v1 surface is 44 controls + 43 WS commands (Gate A inventory); this
 * table intentionally covers one representative control per authority class so
 * the prototype can measure per-class translation cost, not the whole surface.
 */
export const CONTROL_MAP = {
  // ── session routing class ─────────────────────────────────────────────────
  new_session: {
    kind: "runtime",
    mutation: true,
    category: "session-routing",
    toV2: (args, ctx) => ({
      type: "runtime_request",
      command: { type: "new_session", port: args.port ?? ctx?.sourcePort ?? null },
      target: ctx.target,
    }),
  },
  fork: {
    kind: "runtime",
    mutation: true,
    category: "session-routing",
    toV2: (args, ctx) => ({
      type: "runtime_request",
      command: { type: "fork", entryId: args.entryId },
      target: ctx.target,
    }),
  },
  navigate_tree: {
    kind: "runtime",
    mutation: true,
    category: "session-routing",
    // `summarize:false` must survive translation (session-tree invariant).
    toV2: (args, ctx) => ({
      type: "runtime_request",
      command: { type: "navigate_tree", entryId: args.entryId, summarize: args.summarize ?? false },
      target: ctx.target,
    }),
  },
  // ── picker class (OS dialogs; NativeDesktop only) ─────────────────────────
  pick_folder: {
    kind: "host",
    desktopOnly: true,
    category: "picker",
    toV2: () => ({ type: "host_request", operation: "pick_folder" }),
  },
  // ── system open class (path/URL authority; NativeDesktop only) ────────────
  open_in_app: {
    kind: "host",
    desktopOnly: true,
    category: "open",
    toV2: (args) => ({ type: "host_request", operation: "open_in_app", path: args.path ?? null }),
  },
  open_external: {
    kind: "host",
    desktopOnly: true,
    category: "open",
    toV2: (args) => ({ type: "host_request", operation: "open_external", url: args.url ?? null }),
  },
  // ── skill install class (owner + source-handle binding; NativeDesktop only) ─
  skill_install_links: {
    kind: "host",
    desktopOnly: true,
    category: "skill",
    toV2: (args) => ({ type: "host_request", operation: "skill_install_links", request: args }),
  },
  // ── workspace transition class (generation binding; NativeDesktop only) ───
  workspace_target_prepare: {
    kind: "host",
    desktopOnly: true,
    category: "workspace-transition",
    toV2: (args) => ({
      type: "host_request",
      operation: "workspace_target_prepare",
      targetCwd: args.targetCwd ?? null,
      sessionPath: args.sessionPath ?? null,
      forceNewSession: args.forceNewSession ?? false,
      reuseExisting: args.reuseExisting ?? false,
      targetPort: args.targetPort ?? null,
    }),
  },
  workspace_transition_commit: {
    kind: "host",
    desktopOnly: true,
    category: "workspace-transition",
    // Generation binding must survive: the v2 host validates
    // args.transitionGeneration against the owner's pending transition.
    toV2: (args) => ({
      type: "host_request",
      operation: "workspace_transition_commit",
      transitionGeneration: args.transitionGeneration,
    }),
  },
};

/** Map a v1 broker_command payload to a v2 runtime frame.
 * Returns `{ frame, origin }` or `{ error: code }` when the payload has no
 * placeable v2 mapping (recorded, never silently dropped). */
export function brokerCommandToV2(payload, requestId, ctx) {
  const commandType = payload?.type;
  if (typeof commandType !== "string" || !commandType) {
    return { error: "invalid_command" };
  }
  if (commandType === "mirror_sync_request") {
    // v1 snapshot request → v2 snapshot request; the reply is translated back
    // into a v1 `mirror_sync` payload by whichever adapter owns the wire.
    return {
      origin: "broker_command",
      frame: { type: "runtime_snapshot_request", requestId, target: ctx.target },
    };
  }
  if (commandType === "abort") {
    // v1 abort carries NO turn identity. The v2 contract is turn-bound, so the
    // adapter must supply `turnId` from the runtime events it has observed.
    // See the evidence doc: this is the sharpest lossless-mapping risk found.
    if (!ctx.activeTurnId) {
      return { error: "no_active_turn" };
    }
    // Abort is a turn-bound command, NOT a mutation: no idempotencyKey slot.
    return {
      origin: "broker_command",
      frame: {
        type: "runtime_request",
        requestId,
        target: ctx.target,
        command: { type: "abort", turnId: ctx.activeTurnId },
      },
    };
  }
  if (isV2MutationCommand(commandType)) {
    return {
      origin: "broker_command",
      frame: {
        type: "runtime_request",
        requestId,
        target: ctx.target,
        idempotencyKey: `v1-cmd-${requestId}`,
        command: payload,
      },
    };
  }
  // Read-style RPC payloads (get_messages/get_state/get_session_stats/...)
  // translate without an idempotency key.
  return {
    origin: "broker_command",
    frame: {
      type: "runtime_request",
      requestId,
      target: ctx.target,
      command: payload,
    },
  };
}
