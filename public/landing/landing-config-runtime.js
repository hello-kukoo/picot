// ABOUTME: Landing bridge-service config runtime — lazily spawns a
// ABOUTME: sessionless/toolless Pi that hosts picot-bridge so ConfigGateway
// ABOUTME: ops (models, MCP, package skills, configuration, advisor) work
// ABOUTME: with no workspace open. See 2026-09-18-landing-bridge-runtime-design.md.
import { ConfigGateway } from "../settings/config-gateway.js";
import { createOauthGateway } from "../settings/oauth-gateway.js";

/**
 * One lazy config runtime per landing page. The spawn is idempotent
 * host-side; here we cache the descriptor and expose gateway PROXIES that
 * transparently ensure the runtime on first use — pages render against the
 * proxy exactly like a workspace gateway.
 *
 * Responses arrive as `ephemeral_event` frames (the ephemeral command
 * channel bypasses workspace-scoped runtime_request admission, which a
 * landing frame can never satisfy); notify payloads are routed back into
 * the gateways by request id.
 */
export function setupLandingConfigRuntime({ transport, wsClient }) {
  const state = { descriptor: null, spawnPromise: null, gateway: null, oauth: null };
  const oauthSubscribers = new Set();
  // Whichever frame answers a forwarded command — the runtime's reply or the
  // host's `ephemeral_command_failed` — settles that command's promise, so a
  // refused frame reports the host's real error instead of leaving the caller
  // to its own 30s timeout with no explanation.
  const commandOutcomes = new Map();

  function settleCommand(requestId, error) {
    const outcome = commandOutcomes.get(requestId);
    if (!outcome) return;
    commandOutcomes.delete(requestId);
    clearTimeout(outcome.timer);
    if (error) outcome.reject(new Error(error));
    else outcome.resolve(null);
  }

  function buildGateways(descriptor) {
    const send = (command) => {
      const accepted = wsClient.sendEphemeral(
        descriptor.instanceId,
        descriptor.generation,
        command,
      );
      if (accepted === null) {
        return Promise.reject(new Error("config runtime transport unavailable"));
      }
      return new Promise((resolve, reject) => {
        // Bounded: an unanswered frame must not pin the map entry forever.
        const timer = setTimeout(() => commandOutcomes.delete(accepted), 60_000);
        commandOutcomes.set(accepted, { resolve, reject, timer });
      });
    };
    const target = () => ({
      workspaceId: "landing",
      sessionId: `config-${descriptor.instanceId}`,
      instanceId: descriptor.instanceId,
    });
    state.gateway = new ConfigGateway({
      runtime: { request: send },
      getTarget: target,
      // The spawn control op resolves only after the health wait, so a
      // resolved spawn IS readiness — no foreground-snapshot gate needed.
      waitUntilReady: () => Promise.resolve(),
    });
    state.oauth = createOauthGateway({ runtime: { request: send }, getTarget: target });
    for (const listener of oauthSubscribers) listener();
    oauthSubscribers.clear();
  }

  function ensure() {
    if (state.descriptor) return Promise.resolve(state.descriptor);
    if (!state.spawnPromise) {
      state.spawnPromise = transport
        .spawnConfigRuntime()
        .then((descriptor) => {
          state.descriptor = descriptor;
          buildGateways(descriptor);
          return descriptor;
        })
        .catch((error) => {
          // A failed spawn must not poison the page: reset so the next
          // activation retries.
          state.spawnPromise = null;
          throw error;
        });
    }
    return state.spawnPromise;
  }

  /** Transparent gateway proxy: ensures the runtime, then delegates. */
  const configGateway = {
    call(op, params, options) {
      return ensure().then(() => state.gateway.call(op, params, options));
    },
  };

  /** OAuth proxy: command ensures + delegates; subscribe defers until built. */
  const oauthGateway = {
    command(frame, options) {
      return ensure().then(() => state.oauth.command(frame, options));
    },
    subscribe(listener) {
      if (state.oauth) return state.oauth.subscribe(listener);
      let unsubscribe = () => {};
      const forward = () => {
        unsubscribe = state.oauth.subscribe(listener);
      };
      oauthSubscribers.add(forward);
      return () => {
        oauthSubscribers.delete(forward);
        unsubscribe();
      };
    },
  };

  function handleEphemeralEvent(event) {
    const payload = event?.detail?.payload;
    settleCommand(event?.detail?.requestId, null);
    if (payload?.type !== "extension_ui_request") return;
    const message = payload?.message;
    if (typeof message !== "string") return;
    // OAuth frames settle first (M3 mutual exclusion), config frames second.
    // consumeFrame expects the runtime_event envelope shape ({ type, event }).
    if (message.includes("__picotOauth")) {
      state.oauth?.consumeFrame({ type: "runtime_event", event: payload });
      return;
    }
    if (message.includes("__picotConfig")) {
      state.gateway?.consumeNotify(payload, null);
    }
  }

  wsClient.addEventListener("ephemeralEvent", handleEphemeralEvent);
  wsClient.addEventListener("ephemeralCommandFailed", (event) => {
    const requestId = event?.detail?.requestId;
    if (typeof requestId === "string") settleCommand(requestId, event.detail?.error || "failed");
  });

  return {
    ensure,
    configGateway,
    oauthGateway,
    descriptor: () => state.descriptor,
  };
}
