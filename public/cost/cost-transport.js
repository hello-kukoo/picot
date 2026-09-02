// ABOUTME: Desktop transport for the /cost settings embed: authenticated v2
// ABOUTME: WebSocket plus the `cost_dashboard` data operation the iframe needs.

import { readInjectedCapability } from "../app/host-origin.js";
import { WebSocketClient } from "../app/websocket-client.js";

/**
 * Build the minimal transport surface the cost dashboard needs. The embed
 * shares the HostServer origin, so its WebSocket is the same authenticated
 * v2 socket the workspace windows use; the capability is injected by the
 * host's initialization script for every same-origin loopback frame.
 */
export function createCostTransport() {
  const capability = readInjectedCapability(globalThis);
  if (!capability) return null;
  let wsClient;
  try {
    wsClient = new WebSocketClient(resolveUrl());
  } catch {
    return null;
  }
  // hello as a desktop client; the host answers hello_ack only when the
  // injected capability authenticates, and `connected` fires after that.
  wsClient.connect?.();
  const client = {
    costDashboard(options = {}) {
      return wsClient.sendData("cost_dashboard", { ...options });
    },
    close() {
      wsClient.disconnect?.();
    },
  };
  return client;
}

function resolveUrl() {
  // Same resolution precedence as WebSocketClient: the window location wins
  // over any ambient global location (test environments differ).
  const loc = globalThis.window?.location || globalThis.location;
  if (!loc?.host) throw new Error("HostServer origin is unavailable");
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}/v2/ws`;
}
