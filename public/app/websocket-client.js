// ABOUTME: Maintains the broker WebSocket, authentication handshake, and reconnect state.
// ABOUTME: Dispatches correlated control, session, and owner-scoped ephemeral frames.

import { consumeInjectedCapability } from "./host-origin.js";

/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

const BROKER_WS_STORAGE_KEY = "pi-studio:broker-ws-url";

// The shared broker URL is delivered to each page via the `?brokerWs=` query
// param (the Rust host appends it when opening a window, and in-app navigations
// carry it forward — see workspace-actions.withBrokerWs). We persist it to
// sessionStorage so a reload without the param still finds it. Keeping this in
// the transport-agnostic WS layer means the frontend does not depend on any
// desktop-specific bridge to discover the broker.
export function resolveBrokerWsUrl(env = globalThis.window || globalThis) {
  try {
    const loc = env?.location || globalThis.location;
    const search = loc?.search || "";
    const fromUrl = new URLSearchParams(search).get("brokerWs");
    if (fromUrl) {
      env?.sessionStorage?.setItem?.(BROKER_WS_STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    return env?.sessionStorage?.getItem?.(BROKER_WS_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function resolveWebSocketUrl(env = globalThis.window || globalThis) {
  const loc = env?.location || globalThis.location;
  const hostOrigin = typeof loc?.pathname === "string" && loc.pathname.startsWith("/workspaces/");
  // Existing-shell pages served by HostServer have one canonical transport. Do
  // not consult brokerWs (or fall back to Pi's /ws) on this origin.
  if (hostOrigin) {
    const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${loc?.host || "127.0.0.1:47821"}/v2/ws`;
  }
  const brokerUrl = resolveBrokerWsUrl(env);
  if (brokerUrl.trim()) {
    return brokerUrl.trim();
  }

  const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc?.host || "127.0.0.1:47821"}/ws`;
}

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = "idle";
    this.protocolVersion = url.endsWith("/v2/ws") ? 2 : 1;
    this.clientId = null;
    this.workspaceId = null;
    this.sessionId = null;
    this.canonicalRoute = this._readCanonicalRoute();
    this.sourcePort = null;
    this.requestCounter = 0;
    // Whether the broker advertised native (OS/window) capabilities. Updated by
    // the authenticated `capabilities` handshake frame; consumers gate native-only
    // UI on it.
    this.capabilities = { native: false };
    // True once the broker has authenticated our `client_hello`. `connected` only
    // fires after this, so no command is sent before the owner/class is verified.
    this.authenticated = false;
    this._pendingConnect = false;
    // Pending control requests keyed by requestId. Each entry resolves/rejects
    // the promise returned by sendControl() when a matching control_response
    // arrives (or on timeout / disconnect). `onProgress` receives streamed
    // control_progress frames (e.g. updater download chunks).
    this.pendingControls = new Map();
    this.controlTimeoutMs = 30000;
    this.sequenceGapRecoveryPending = false;
  }

  _readCanonicalRoute() {
    if (this.protocolVersion !== 2) return false;
    const match = (globalThis.location?.pathname || "").match(
      /^\/workspaces\/([^/]+)\/sessions\/([^/]+)/,
    );
    if (!match) return false;
    this.workspaceId = decodeURIComponent(match[1]);
    this.sessionId = decodeURIComponent(match[2]);
    return true;
  }

  setRoutingContext({ workspaceId, sessionId, sourcePort }) {
    // Host-origin route IDs are authoritative. Legacy app.js updates must not
    // replace them with path-derived IDs after a native navigation.
    if (!this.canonicalRoute) {
      if (typeof workspaceId === "string" && workspaceId.trim())
        this.workspaceId = workspaceId.trim();
      if (sessionId === null) this.sessionId = null;
      if (typeof sessionId === "string" && sessionId.trim()) this.sessionId = sessionId.trim();
    }
    if (sourcePort === null) this.sourcePort = null;
    if (typeof sourcePort === "number" && Number.isFinite(sourcePort)) {
      this.sourcePort = sourcePort;
    }
    console.debug("[WS route] setRoutingContext", {
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      sourcePort: this.sourcePort,
    });
  }

  connect() {
    if (this.connectionState === "connecting") return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = "connecting";
    this._pendingConnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)
    ) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[WS] Open; sending client_hello");
      this.reconnectAttempts = 0;
      this.connectionState = "open";
      this.authenticated = false;
      this._sendClientHello();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error("[WS] Failed to parse message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("[WS] Error:", error);
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || "n/a"})`);
      this.connectionState = "closed";
      this.dispatchEvent(new CustomEvent("disconnected"));

      this.rejectAllControls(new Error("WebSocket disconnected"));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = "closed";
    this.authenticated = false;
    this._pendingConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  // Force reconnect — resets attempt counter and connects fresh
  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = "closed";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, "force reconnect");
      } catch (_e) {}
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WS] Max reconnection attempts reached");
      this.dispatchEvent(new CustomEvent("reconnectFailed"));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.maxReconnectDelay,
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
    );

    console.log(
      `[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Prefer broker envelope, while remaining backward-compatible with
      // servers that still expect raw command payloads.
      const requestId = `req-${++this.requestCounter}`;
      const payload =
        this.protocolVersion === 2
          ? {
              type: "runtime_request",
              protocolVersion: 2,
              requestId,
              target: {
                workspaceId: this.workspaceId,
                sessionId: this.sessionId,
                instanceId: String(this.sourcePort || "primary"),
              },
              command: data,
              idempotencyKey: `ui-${requestId}`,
            }
          : data && data.type === "broker_command"
            ? data
            : {
                type: "broker_command",
                protocolVersion: this.protocolVersion,
                requestId,
                workspaceId: this.workspaceId || undefined,
                sessionId: this.sessionId || undefined,
                sourcePort: this.sourcePort || undefined,
                payload: data,
              };
      console.debug("[WS route] send", {
        command: payload.payload?.type || payload.type,
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        sourcePort: payload.sourcePort,
      });
      this.ws.send(JSON.stringify(payload));
      // Return the requestId so callers can correlate a later
      // `command_undeliverable` reply back to the message they sent.
      return payload.requestId || null;
    } else {
      console.error("[WS] Cannot send, not connected");
      return null;
    }
  }

  _readNativeCapability() {
    return consumeInjectedCapability(globalThis);
  }

  // Send the first-frame `client_hello`. Native clients present the injected
  // capability; remote (LAN/mobile) clients send a bare hello with no secret.
  _sendClientHello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const capability = this._readNativeCapability();
    this._readCanonicalRoute();
    const hello =
      this.protocolVersion === 2
        ? {
            type: "hello",
            protocolVersion: 2,
            clientType: "desktop",
            clientId: this.clientId || `desktop-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
            desktopCapability: capability,
          }
        : { type: "client_hello", protocolVersion: this.protocolVersion };
    if (capability && this.protocolVersion !== 2) hello.capability = capability;
    try {
      this.ws.send(JSON.stringify(hello));
    } catch (err) {
      console.error("[WS] Failed to send client_hello:", err);
    }
  }

  // Send an owner-scoped ephemeral command and return its requestId. The broker
  // derives the owner from the authenticated connection, never from the payload.
  sendEphemeral(instanceId, generation, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const requestId = `ep-${++this.requestCounter}`;
      const envelope = {
        type: "ephemeral_command",
        protocolVersion: this.protocolVersion,
        requestId,
        ephemeralInstanceId: instanceId,
        generation,
        payload,
      };
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (err) {
        console.error("[WS] Failed to send ephemeral command:", err);
        return null;
      }
      return requestId;
    }
    console.error("[WS] Cannot send ephemeral command, not connected");
    return null;
  }

  // Resolve once the socket is OPEN, or reject after `timeoutMs`. Lets control
  // commands sent during startup wait briefly for the broker connection instead
  // of failing the race between page load and the WS handshake.
  waitForOpen(timeoutMs = 5000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventListener("connected", onConnected);
        reject(new Error("WebSocket not connected"));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        this.removeEventListener("connected", onConnected);
        resolve();
      };
      this.addEventListener("connected", onConnected);
    });
  }

  // Send a control command (process/window lifecycle or native op handled by
  // the broker host, not forwarded to a pi upstream) and resolve with the
  // broker's result. Mirrors the promise semantics of a Tauri `invoke()` so
  // callers can stay transport-agnostic. `onProgress` (optional) receives
  // streamed control_progress frames; `timeoutMs` overrides the default for
  // long/interactive ops (folder picker, updater download).
  //
  // When already connected we register + send synchronously (snappy + makes the
  // requestId correlation deterministic). When not yet connected we wait briefly
  // for the broker handshake to win the page-load race before sending.
  sendControl(command, args = {}, options = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this._sendControlNow(command, args, options);
    }
    return this.waitForOpen().then(() => this._sendControlNow(command, args, options));
  }

  _sendControlNow(command, args = {}, { onProgress = null, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected; cannot send control command"));
        return;
      }
      const requestId = `ctl-${++this.requestCounter}`;
      const entry = { resolve, reject, onProgress, timer: null };
      const effectiveTimeout = typeof timeoutMs === "number" ? timeoutMs : this.controlTimeoutMs;
      if (effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          if (this.pendingControls.has(requestId)) {
            this.pendingControls.delete(requestId);
            reject(new Error(`Control command "${command}" timed out`));
          }
        }, effectiveTimeout);
      }
      this.pendingControls.set(requestId, entry);

      const envelope =
        this.protocolVersion === 2
          ? this._canonicalControlEnvelope(command, requestId, args)
          : {
              type: "broker_control",
              protocolVersion: this.protocolVersion,
              requestId,
              command,
              args: args || {},
            };
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingControls.delete(requestId);
        reject(err);
      }
    });
  }

  _subscribeCanonicalTarget() {
    if (this.protocolVersion !== 2 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.workspaceId || !this.sessionId) return;
    this.ws.send(
      JSON.stringify({
        type: "runtime_subscribe",
        protocolVersion: 2,
        requestId: `sub-${++this.requestCounter}`,
        target: {
          workspaceId: this.workspaceId,
          sessionId: this.sessionId,
          instanceId: String(this.sourcePort || "primary"),
        },
      }),
    );
  }

  _requestCanonicalSnapshot() {
    if (this.protocolVersion !== 2 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.workspaceId || !this.sessionId) return;
    this.ws.send(
      JSON.stringify({
        type: "runtime_snapshot_request",
        protocolVersion: 2,
        requestId: `snapshot-${++this.requestCounter}`,
        target: {
          workspaceId: this.workspaceId,
          sessionId: this.sessionId,
          instanceId: String(this.sourcePort || "primary"),
        },
      }),
    );
  }

  _canonicalControlEnvelope(command, requestId, args) {
    // Host owns process/workspace lifecycle. Keep this classification aligned
    // with `scripts/prototype/control-map.js` and Rust `v1_control_adapter`;
    // routing these controls as runtime requests sends them to Pi instead of
    // the host lifecycle handler.
    return {
      type: "host_request",
      protocolVersion: 2,
      requestId,
      operation: command,
      args: args || {},
      idempotencyKey: `ui-${requestId}`,
    };
  }

  _recoverFromSequenceGap() {
    if (this.sequenceGapRecoveryPending || this.protocolVersion !== 2) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.workspaceId || !this.sessionId) return;
    this.sequenceGapRecoveryPending = true;
    this.ws.send(
      JSON.stringify({
        type: "runtime_snapshot_request",
        protocolVersion: 2,
        requestId: `snapshot-gap-${++this.requestCounter}`,
        target: {
          workspaceId: this.workspaceId,
          sessionId: this.sessionId,
          instanceId: String(this.sourcePort || "primary"),
        },
      }),
    );
  }

  resolveControl(message) {
    const requestId = message?.requestId;
    if (!requestId) return;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok === false) {
      pending.reject(new Error(message.error || "Control command failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  handleControlProgress(message) {
    const pending = this.pendingControls.get(message?.requestId);
    if (pending && typeof pending.onProgress === "function") {
      try {
        pending.onProgress(message.data);
      } catch (err) {
        console.error("[WS] control progress handler failed:", err);
      }
    }
  }

  rejectAllControls(error) {
    for (const [, pending] of this.pendingControls) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingControls.clear();
  }

  handleMessage(message, route = null) {
    if (message.type === "broker_event") {
      const payload = message.payload || {};
      // Extract routing metadata from the broker envelope but do NOT call
      // setRoutingContext here — incoming events must not silently hijack the
      // routing context that the user (or an explicit session-select action)
      // set. If session B streams an event while the user is viewing session A,
      // the next command must still go to A.
      const eventRoute = {
        workspaceId: message.workspaceId || payload.workspaceId || undefined,
        sessionId: message.sessionId || payload.sessionId || undefined,
        sourcePort: message.sourcePort || payload.port || undefined,
      };
      console.debug("[WS route] broker_event", {
        payloadType: payload.type,
        eventType: payload.event?.type,
        workspaceId: eventRoute.workspaceId,
        sessionId: eventRoute.sessionId,
        sourcePort: eventRoute.sourcePort,
      });
      this.dispatchEvent(new CustomEvent("brokerEvent", { detail: message }));
      this.handleMessage(payload, eventRoute);
      return;
    }

    // Broker reply for a broker_control we sent (requestId-keyed).
    if (
      message.type === "control_response" ||
      message.type === "runtime_response" ||
      message.type === "host_response" ||
      message.type === "data_response"
    ) {
      // Canonical v2 uses `response` for runtime/host results; legacy callers
      // consume `result`. Normalize only at this compatibility boundary.
      const normalized =
        message.result === undefined && message.response !== undefined
          ? { ...message, result: message.response }
          : message;
      this.resolveControl(normalized);
      this.dispatchEvent(new CustomEvent("controlResponse", { detail: normalized }));
      return;
    }

    if (message.type === "error") {
      if (message.error?.code === "event_sequence_gap") {
        this._recoverFromSequenceGap();
      }
      this.resolveControl({
        requestId: message.requestId,
        ok: false,
        error: message.error?.message || message.error?.code || "Request failed",
      });
      return;
    }

    if (message.type === "runtime_event") {
      const route = {
        workspaceId: message.target?.workspaceId,
        sessionId: message.target?.sessionId,
        sourcePort: message.target?.instanceId,
      };
      this.dispatchEvent(new CustomEvent("runtimeEvent", { detail: message }));
      this.dispatchEvent(new CustomEvent("brokerEvent", { detail: message }));
      // Existing shell owns event rendering through rpcEvent. Translate v2's
      // sequenced envelope without dropping sequence/target metadata.
      this.dispatchEvent(
        new CustomEvent("rpcEvent", {
          detail: message.event
            ? { ...message.event, __broker: route, __sequence: message.sequence }
            : {},
        }),
      );
      return;
    }

    if (message.type === "runtime_snapshot") {
      this.sequenceGapRecoveryPending = false;
      const state = message.state || {};
      const piState = state.pi && typeof state.pi === "object" ? state.pi : {};
      const target = message.target || {};
      this.dispatchEvent(
        new CustomEvent("mirrorSync", {
          detail: {
            ...piState,
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            port: target.instanceId,
            sequence: message.sequence,
            messages: state.messages || [],
            stats: state.stats || {},
          },
        }),
      );
      return;
    }

    // The broker could not route/deliver a broker_command we sent (the target
    // pi process is gone or no session is reachable). Surface it so a dropped
    // prompt does not vanish silently — callers correlate via requestId.
    if (message.type === "command_undeliverable") {
      this.dispatchEvent(new CustomEvent("commandUndeliverable", { detail: message }));
      return;
    }

    // Streamed progress for an in-flight broker_control (e.g. updater download).
    if (message.type === "control_progress") {
      this.handleControlProgress(message);
      return;
    }

    // Host v2 acknowledges its authenticated hello directly. Legacy broker
    // connections advertise capabilities in a second frame.
    if (message.type === "hello_ack" && this.protocolVersion === 2) {
      this.capabilities = { native: true, class: "native" };
      this.authenticated = true;
      this.dispatchEvent(new CustomEvent("capabilities", { detail: this.capabilities }));
      this._subscribeCanonicalTarget();
      this._requestCanonicalSnapshot();
      if (this._pendingConnect) {
        this._pendingConnect = false;
        this.dispatchEvent(new CustomEvent("connected"));
      }
      return;
    }

    // Broker capability handshake — authenticates the client and tells the UI
    // whether native (OS/window) operations are available (class "native"
    // inside the desktop host, "remote" for LAN/mobile).
    if (message.type === "capabilities") {
      const cls = message.class === "native" ? "native" : "remote";
      this.capabilities = {
        native: cls === "native" || Boolean(message.native),
        class: cls,
      };
      this.authenticated = true;
      this.dispatchEvent(new CustomEvent("capabilities", { detail: this.capabilities }));
      if (this._pendingConnect) {
        this._pendingConnect = false;
        console.log("[WS] Authenticated; connected");
        this.dispatchEvent(new CustomEvent("connected"));
      }
      return;
    }

    // Owner-scoped bootstrap (live ephemeral descriptors) for a native client.
    if (message.type === "owner_bootstrap") {
      this.dispatchEvent(new CustomEvent("ownerBootstrap", { detail: message }));
      return;
    }

    // App-global registry mutated by ANY native window (or host prune).
    // Every authenticated native client refreshes its sidebar.
    if (message.type === "registry_changed") {
      this.dispatchEvent(new CustomEvent("registryChanged", { detail: message }));
      return;
    }

    if (message.type === "git_status" || message.type === "git_diff") {
      this.dispatchEvent(
        new CustomEvent(message.type === "git_status" ? "gitStatus" : "gitDiff", {
          detail: message,
        }),
      );
      return;
    }
    if (
      message.type === "git_log" ||
      message.type === "git_log_detail" ||
      message.type === "git_commit_diff"
    ) {
      const eventName = {
        git_log: "gitLog",
        git_log_detail: "gitLogDetail",
        git_commit_diff: "gitCommitDiff",
      }[message.type];
      this.dispatchEvent(new CustomEvent(eventName, { detail: message }));
      return;
    }
    if (message.type === "git_ai_commit_message") {
      this.dispatchEvent(new CustomEvent("gitAiCommitMessage", { detail: message }));
      return;
    }
    if (message.type === "git_commit_confirmation_required") {
      this.dispatchEvent(new CustomEvent("gitCommitConfirmationRequired", { detail: message }));
      return;
    }
    if (message.type === "git_commit_result") {
      this.dispatchEvent(new CustomEvent("gitCommitResult", { detail: message }));
      return;
    }
    if (message.type === "git_commit_started") {
      this.dispatchEvent(new CustomEvent("gitCommitStarted", { detail: message }));
      return;
    }
    if (message.type === "git_command_ack") {
      this.dispatchEvent(new CustomEvent("gitCommandAck", { detail: message }));
      return;
    }
    if (message.type === "git_command_failed" || message.type === "git_ai_commit_message_failed") {
      this.dispatchEvent(new CustomEvent("gitCommandFailed", { detail: message }));
      return;
    }

    // A sequenced event from one of this owner's ephemeral runtimes.
    if (message.type === "ephemeral_event") {
      this.dispatchEvent(new CustomEvent("ephemeralEvent", { detail: message }));
      return;
    }

    // An ephemeral command could not be routed/delivered (correlated by
    // requestId); the error is generic and never reveals instance existence.
    if (message.type === "ephemeral_command_failed") {
      this.dispatchEvent(new CustomEvent("ephemeralCommandFailed", { detail: message }));
      return;
    }

    // Terminal PTY events (owner-scoped): the host terminal manager delivers
    // these only to the current authenticated native client. They never pass
    // through Pi or the embedded server.
    if (message.type === "terminal_event") {
      this.dispatchEvent(new CustomEvent("terminalEvent", { detail: message }));
      return;
    }
    if (message.type === "terminal_command_failed") {
      this.dispatchEvent(new CustomEvent("terminalCommandFailed", { detail: message }));
      return;
    }
    // Manager synchronous responses (terminal_created/listed/closed/restarted/...)
    // are delivered on this socket too; surface them as terminalEvent so the
    // panel can rebuild tab state.
    if (typeof message.type === "string" && message.type.startsWith("terminal_")) {
      this.dispatchEvent(new CustomEvent("terminalEvent", { detail: message }));
      return;
    }

    // Host-targeted window close request: the coordinator runs its serialized
    // risk/settlement flow and replies with window_close_approve.
    if (message.type === "window_close_request") {
      this.dispatchEvent(new CustomEvent("windowCloseRequest", { detail: message }));
      return;
    }

    // Emit events based on message type
    switch (message.type) {
      case "event":
        this.dispatchEvent(
          new CustomEvent("rpcEvent", {
            detail: message.event
              ? {
                  ...message.event,
                  __broker: route,
                }
              : message.event,
          }),
        );
        break;
      case "state":
        this.dispatchEvent(new CustomEvent("stateUpdate", { detail: message }));
        break;
      case "error":
        this.dispatchEvent(new CustomEvent("serverError", { detail: message }));
        break;
      case "response":
        // Broker acknowledgment for a broker_command we sent (requestId-keyed).
        // No frontend handler needed currently; dispatch for future use.
        this.dispatchEvent(new CustomEvent("commandResponse", { detail: message }));
        break;
      case "session_switch":
        this.dispatchEvent(new CustomEvent("sessionSwitch"));
        break;
      case "mirror_sync":
        // Do NOT call setRoutingContext here. The broker broadcasts every
        // upstream's `mirror_sync` to all UI clients, so a snapshot emitted by
        // a *background* pi process (e.g. the previously-running session that
        // keeps streaming after the user switched away) must not silently
        // hijack the routing context — otherwise the user's next command would
        // be routed to that background session. Routing context is owned by the
        // app layer (`handleMirrorSync`), which guards against background
        // snapshots by source port. Surface the source port so it can decide.
        if (message.port == null && route?.sourcePort != null) {
          message = { ...message, port: route.sourcePort };
        }
        this.dispatchEvent(new CustomEvent("mirrorSync", { detail: message }));
        break;
      default:
        console.warn("[WS] Unknown message type:", message.type);
    }
  }
}
