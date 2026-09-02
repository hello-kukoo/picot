// ABOUTME: Verifies the /cost settings-embed transport: capability gating and
// ABOUTME: the cost_dashboard data-request mapping over the v2 WebSocket.

import { afterEach, describe, expect, test, vi } from "vitest";

const sockets = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    sockets.push(this);
  }
  send(text) {
    this.lastSent = text;
    this.sent = (this.sent ?? []).concat(text);
  }
  close() {
    this.readyState = 3;
  }
}

describe("cost-transport", () => {
  afterEach(() => {
    vi.resetModules();
    sockets.length = 0;
    delete globalThis.__PICOT_NATIVE_CAPABILITY__;
    vi.restoreAllMocks();
  });

  test("returns null when no capability was injected (non-native context)", async () => {
    globalThis.window = {
      location: { host: "127.0.0.1:60529", protocol: "http:", pathname: "/cost/" },
    };
    globalThis.WebSocket = FakeWebSocket;
    const { createCostTransport } = await import("./cost-transport.js");
    expect(createCostTransport()).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  test("authenticates as desktop and maps costDashboard to a data_request", async () => {
    globalThis.window = {
      location: { host: "127.0.0.1:60529", protocol: "http:", pathname: "/cost/" },
    };
    // The host init script defines the capability on the global scope; in a
    // real frame window === globalThis, so the module reads it from globalThis.
    globalThis.__PICOT_NATIVE_CAPABILITY__ = "cap-token";
    globalThis.WebSocket = FakeWebSocket;
    const { createCostTransport } = await import("./cost-transport.js");
    const transport = createCostTransport();
    expect(transport).not.toBeNull();
    const socket = sockets.at(-1);
    expect(socket.url).toBe("ws://127.0.0.1:60529/v2/ws");

    // Opening the socket triggers the desktop hello (capability attached).
    socket.readyState = 1;
    socket.onopen?.();
    const hello = JSON.parse(socket.sent.at(0));
    expect(hello.type).toBe("hello");
    expect(hello.clientType).toBe("desktop");
    expect(hello.desktopCapability).toBe("cap-token");

    socket.onmessage?.({
      data: JSON.stringify({ type: "hello_ack", protocolVersion: 2 }),
    });

    const pending = transport.costDashboard({ range: "30d" });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "data_response",
        requestId: "req-1",
        operation: "cost_dashboard",
        totals: { cost: 1.5 },
      }),
    });
    // The client normalizes data replies to the top-level payload fields
    // (type/requestId stripped); `operation` travels along by design.
    await expect(pending).resolves.toEqual({
      operation: "cost_dashboard",
      totals: { cost: 1.5 },
    });
  });
});
