// ABOUTME: WebView-side session registry for Codex OAuth operations.
// ABOUTME: Reuses the /picot-config prompt round-trip; events stream as __picotOauth frames.

import { randomId } from "../utils/random-id.js";

const DEFAULT_TIMEOUT_MS = 120_000;

function extractOauthEnvelope(message) {
  if (typeof message !== "string") return null;
  if (message.includes("__picotOauth")) {
    try {
      const payload = JSON.parse(message);
      if (!payload || payload.__picotOauth === undefined) return null;
      return {
        kind: "event",
        configId: String(payload.__picotOauth),
        event: payload.event ?? null,
      };
    } catch {
      return null;
    }
  }
  // This gateway's own synchronous responses arrive as regular __picotConfig
  // frames tagged with the oa- id prefix; without settling them here they
  // would fall through to chat rendering.
  if (message.includes("__picotConfig")) {
    try {
      const payload = JSON.parse(message);
      const configId = String(payload?.__picotConfig ?? "");
      if (configId.startsWith("oa-")) {
        return { kind: "response", configId, payload };
      }
    } catch {
      return null;
    }
  }
  return null;
}

const TERMINAL_EVENTS = new Set(["complete", "failed", "cancelled", "expired"]);

/**
 * Session registry for OAuth login flows over the config transport.
 *
 * `command(frame)` sends a v3-shaped command frame (`{ type, ...params }`)
 * over the /picot-config channel and resolves with the v3 response shape
 * (`{ success, data?, error? }`). Events for the active operation stream to
 * the single handler registered via `subscribe`; terminal events settle the
 * originating request and clear the subscription. Frames without an active
 * matching session are dropped — other windows subscribed to the same target
 * never render them (design §5 convergence rule).
 */
export function createOauthGateway({ runtime, getTarget }) {
  const pending = new Map();
  let activeHandler = null;
  let nextRequestId = 1;

  function send(commandFrame, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = getTarget();
    if (!target) return Promise.reject(new Error("No active session for OAuth request"));
    const type = commandFrame?.type;
    if (!type) return Promise.reject(new Error("OAuth command type is required"));
    const { type: _type, ...params } = commandFrame;
    const id = `oa-${nextRequestId++}`;
    const message = `/picot-config ${JSON.stringify({ id, op: type, params })}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`OAuth request "${type}" timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      runtime
        .request({ type: "prompt", message }, target, { idempotencyKey: id })
        .catch((error) => {
          const entry = pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(id);
          reject(error);
        });
    });
  }

  /**
   * Consume one runtime_event frame. Returns true when the frame was an
   * OAuth envelope (the caller must then NOT feed it to other consumers —
   * design §5 M3 mutual exclusion).
   *
   * Two gates, one per envelope kind (the bridge resolves start_oauth_login
   * immediately and streams later events under the same request id):
   * - `response` frames (`__picotConfig:"oa-…"`) must match a live pending
   *   entry — a start command resolves exactly once from its response;
   *   unknown/stale ids are swallowed.
   * - `event` frames (`__picotOauth`) dispatch whenever a subscription is
   *   active (session-level gate): they outlive the pending entry that
   *   started the flow. No subscription → swallow, never render (other
   *   windows subscribed to the same target drop them, design §5).
   */
  function consumeFrame(frame) {
    if (frame?.type !== "runtime_event") return false;
    if (frame.event?.type !== "extension_ui_request") return false;
    const envelope = extractOauthEnvelope(frame.event?.message);
    if (!envelope) return false;
    if (envelope.kind === "response") {
      const entry = pending.get(envelope.configId);
      if (!entry) return true; // ours but unknown/stale — swallow it
      clearTimeout(entry.timer);
      pending.delete(envelope.configId);
      const payload = envelope.payload ?? {};
      entry.resolve(
        payload.ok
          ? { success: true, data: payload.data ?? {} }
          : { success: false, error: payload.error },
      );
      return true;
    }
    const event = envelope.event;
    if (!event) return true;
    if (!activeHandler) return true; // ours but no active session — swallow it
    try {
      activeHandler({ event });
    } catch (error) {
      console.warn("[OauthGateway] event handler failed:", error);
    }
    // Terminal events complete the flow: settle the originating request if
    // still pending and drop the subscription so later frames are swallowed.
    if (TERMINAL_EVENTS.has(event.type)) {
      const entry = pending.get(envelope.configId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(envelope.configId);
        entry.resolve({ success: true, data: { state: event.type } });
      }
      activeHandler = null;
    }
    return true;
  }

  return {
    /** Send a v3-shaped command; resolves with `{ success, data?, error? }`. */
    command: send,
    /**
     * Consume one runtime_event frame. Returns true when the frame was an
     * OAuth envelope (M3 mutual exclusion: caller skips other consumers).
     */
    consumeFrame,
    /** Register the single active event handler; returns unsubscribe. */
    subscribe(handler) {
      activeHandler = handler;
      return () => {
        if (activeHandler === handler) activeHandler = null;
      };
    },
    /** Test/diagnostic hook: number of in-flight requests. */
    size() {
      return pending.size;
    },
  };
}

export { randomId };
