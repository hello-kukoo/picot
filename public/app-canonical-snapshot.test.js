// ABOUTME: Reproduces the full canonical-page snapshot chain against the
// ABOUTME: production document: bootstrap target echo, hello_ack, subscribe,
// ABOUTME: runtime_snapshot with Pi AgentMessage payloads, and history render.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const BOOTSTRAP_TARGET = {
  workspaceId: "ws-uuid-1",
  sessionId: "session-a",
  instanceId: "instance-1",
  ownerId: "owner-1",
  workspaceGeneration: 2,
};

// Pi get_messages returns AgentMessage objects (no {type:"message"} wrapper).
// The snapshot must bridge them into the session-file entry shape the
// renderer consumes, or every entry is dropped and the transcript stays empty.
const AGENT_MESSAGES = [
  {
    id: "entry-1",
    role: "user",
    content: [{ type: "text", text: "hello from snapshot" }],
  },
  {
    id: "entry-2",
    role: "assistant",
    content: [{ type: "text", text: "snapshot reply" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  },
];

function hostSnapshotFrame() {
  return {
    type: "runtime_snapshot",
    requestId: "snapshot-1",
    target: BOOTSTRAP_TARGET,
    sequence: 1,
    state: {
      lifecycle: "Ready",
      pi: {
        model: { id: "claude-sonnet", provider: "anthropic", contextWindow: 200000 },
        thinkingLevel: "off",
        isStreaming: false,
        sessionFile: "/pi/sessions/--ws-1--/session-a.jsonl",
        sessionId: "pi-session-id",
      },
      messages: AGENT_MESSAGES,
      stats: {
        sessionFile: "/pi/sessions/--ws-1--/session-a.jsonl",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0.01,
      },
    },
  };
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    // connect() assigns onopen synchronously after construction; the
    // microtask fires after that assignment, mirroring a real socket open.
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  reply(frame) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }

  send(message) {
    const frame = JSON.parse(message);
    this.sent.push(frame);
    if (frame.type === "hello") {
      this.reply({ type: "hello_ack", protocolVersion: 2 });
      return;
    }
    if (frame.type === "runtime_subscribe") {
      this.reply({
        type: "runtime_subscribed",
        requestId: frame.requestId,
      });
      return;
    }
    if (frame.type === "runtime_snapshot_request") {
      const reply = hostSnapshotFrame();
      reply.requestId = frame.requestId;
      this.reply(reply);
      return;
    }
    if (frame.type === "host_request") {
      let response = null;
      if (frame.operation === "workspace.list") {
        response = {
          workspaces: [
            {
              workspaceId: "ws-uuid-1",
              canonicalPath: "/work/repo",
              displayName: "repo",
              pinned: false,
              lastOpenedAt: 100,
            },
          ],
          removed: [],
        };
      } else if (frame.operation === "runtime_instances") {
        response = { instances: [] };
      } else if (frame.operation === "list_skill_inventory") {
        response = { skills: [] };
      }
      if (response) {
        this.reply({
          type: "host_response",
          requestId: frame.requestId,
          ok: true,
          response,
        });
      }
      return;
    }
    if (frame.type === "data_request") {
      if (frame.operation === "workspace_info") {
        this.reply({
          type: "data_response",
          requestId: frame.requestId,
          ok: true,
          isGit: false,
        });
      } else {
        // Generic ack for every other data op so no request dangles.
        this.reply({
          type: "data_response",
          requestId: frame.requestId,
          ok: true,
        });
      }
      return;
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

beforeEach(async () => {
  // Canonical route page: the shell boots at /workspaces/:wid/sessions/:sid,
  // bootstraps its target from the host, and renders the runtime snapshot.
  window.history.pushState(null, "", "/workspaces/ws-uuid-1/sessions/session-a");

  const fixture = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public/index.html"), "utf8"),
    "text/html",
  );
  document.documentElement.replaceChildren(...fixture.documentElement.childNodes);
  const storage = new Map();
  const storageApi = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  vi.stubGlobal("localStorage", storageApi);
  vi.stubGlobal("sessionStorage", storageApi);
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input);
    if (url.startsWith("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    if (url.startsWith("/v2/bootstrap")) {
      return new Response(JSON.stringify(BOOTSTRAP_TARGET));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState(null, "", "/");
  document.documentElement.replaceChildren();
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

test("canonical page renders history from the runtime snapshot", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await import("./app.js?canonical-snapshot");

  // The snapshot's AgentMessages must surface in the transcript.
  await vi.waitFor(() => {
    expect(document.getElementById("messages").textContent).toContain("hello from snapshot");
    expect(document.getElementById("messages").textContent).toContain("snapshot reply");
  });

  // Viewing the live session must not lock the composer into mirror-readonly.
  // (The composer may still be disabled by onboarding when no API key is
  // configured — that is product behavior, not a snapshot-chain bug.)
  const inputArea = document.querySelector(".input-area");
  expect(inputArea.classList.contains("mirror-readonly")).toBe(false);

  // Every host reply type is recognized (no unknown-frame warnings).
  expect(warn).not.toHaveBeenCalledWith(
    expect.stringContaining("Unknown HostServer v2 message type"),
  );

  // Frames carry only the routing triple; owner/generation are host-side.
  const socket = FakeWebSocket.instances.at(-1);
  const snapshotRequest = socket.sent.find((frame) => frame.type === "runtime_snapshot_request");
  expect(snapshotRequest.target).toEqual({
    workspaceId: "ws-uuid-1",
    sessionId: "session-a",
    instanceId: "instance-1",
  });

  // Workspace identity flows natively: the snapshot's DB uuid resolves the
  // registry row's display path for the toolbar indicator...
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("/work/repo");
  });
  // ...and data-plane frames carry the DB uuid, never a display id.
  const dataFrames = socket.sent.filter((frame) => frame.type === "data_request");
  expect(dataFrames.length).toBeGreaterThan(0);
  expect(
    dataFrames.every(
      (frame) => frame.workspaceId === undefined || frame.workspaceId === "ws-uuid-1",
    ),
  ).toBe(true);
});
