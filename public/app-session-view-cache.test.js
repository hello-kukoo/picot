// ABOUTME: Integration test for Phase A session view cache — no-op switch-back
// ABOUTME: without snapshot/disk reads, scroll+gate restore, background increments.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const WORKSPACE_ID = "w1";

const SESSIONS = {
  "/pi/sessions/a.jsonl": {
    sessionId: "session-a",
    instanceId: "instance-a",
    turns: 6,
    mtime: 1_000,
    sizeBytes: 6_000,
  },
  "/pi/sessions/b.jsonl": {
    sessionId: "session-b",
    instanceId: "instance-b",
    turns: 2,
    mtime: 2_000,
    sizeBytes: 2_000,
  },
};

function diskMessages(file) {
  const { turns } = SESSIONS[file];
  const messages = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ entryId: `u-${i}`, role: "user", content: `prompt ${file} ${i}` });
    messages.push({ entryId: `a-${i}`, role: "assistant", content: `answer ${file} ${i}` });
  }
  return messages;
}

function snapshotFor(file) {
  return {
    type: "runtime_snapshot",
    protocolVersion: 2,
    sequence: 1,
    target: {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSIONS[file].sessionId,
      instanceId: SESSIONS[file].instanceId,
    },
    state: {
      lifecycle: "Ready",
      pi: { sessionFile: file, isStreaming: false },
      messages: diskMessages(file).map(({ entryId, ...rest }) => ({ ...rest, id: entryId })),
      stats: {},
    },
  };
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static snapshotLog = [];
  static diskReadLog = [];

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  reply(frame) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0);
  }

  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      this.reply({ type: "hello_ack", protocolVersion: 2 });
      return;
    }
    if (frame.type === "runtime_subscribe") {
      this.reply({ type: "runtime_subscribed", requestId: frame.requestId });
      return;
    }
    if (frame.type === "runtime_snapshot_request") {
      FakeWebSocket.snapshotLog.push(frame.target.sessionId);
      const file = frame.target.sessionId;
      this.reply({ requestId: frame.requestId, ...snapshotFor(file) });
      return;
    }
    if (frame.type === "runtime_request") {
      if (frame.command?.type === "get_state") {
        this.reply({
          type: "runtime_response",
          requestId: frame.requestId,
          ok: true,
          response: { success: true, data: { sessionFile: frame.target?.sessionId } },
        });
      }
      return;
    }
    if (frame.type === "data_request") {
      if (frame.operation === "read_session_messages") {
        FakeWebSocket.diskReadLog.push(frame.sessionId);
        const file = frame.sessionId;
        this.reply({
          type: "data_response",
          requestId: frame.requestId,
          ok: true,
          messages: diskMessages(file),
        });
        return;
      }
      if (frame.operation === "workspace_sessions") {
        const rows = Object.entries(SESSIONS).map(([file, session]) => ({
          filePath: file,
          id: session.sessionId,
          timestamp: "2026-09-22T00:00:00.000Z",
          cwd: "/w",
          mtime: session.mtime,
          sizeBytes: session.sizeBytes,
        }));
        this.reply({
          type: "data_response",
          requestId: frame.requestId,
          ok: true,
          bucketName: "bucket",
          sessions: rows,
          sessionCount: rows.length,
          hiddenSubagentCount: 0,
        });
        return;
      }
      this.reply({ type: "data_response", requestId: frame.requestId, ok: true });
      return;
    }
    if (frame.type === "host_request") {
      console.log("[HARNESS] host_request", frame.operation, JSON.stringify(frame.params));
      let response = null;
      if (frame.operation === "workspace.list") {
        response = {
          workspaces: [
            { workspaceId: WORKSPACE_ID, canonicalPath: "/w", lastOpenedAt: 0, pinned: false },
          ],
          removed: [],
        };
      } else if (frame.operation === "runtime_instances") {
        response = {
          instances: Object.keys(SESSIONS).map((file) => ({
            workspaceId: WORKSPACE_ID,
            sessionId: file,
            instanceId: SESSIONS[file].instanceId,
            cwd: "/w",
          })),
        };
      } else if (frame.operation === "workspace_target_prepare") {
        response = {
          transitionGeneration: 1,
          targetWorkspaceId: WORKSPACE_ID,
          // Native session identity IS the jsonl path (mirrorActiveSessionFile).
          targetSessionId: frame.args?.sessionPath ?? null,
        };
      } else if (frame.operation === "workspace_transition_commit") {
        response = { committed: true };
      }
      if (response) {
        this.reply({ type: "host_response", requestId: frame.requestId, ok: true, response });
      }
      return;
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function selectSession(file) {
  const session = SESSIONS[file];
  return globalThis.__picotSessionView.select(
    // cwd stays unset so the select takes the same-workspace in-place path.
    { filePath: file, mtime: session.mtime, sizeBytes: session.sizeBytes },
    null,
  );
}

beforeEach(async () => {
  FakeWebSocket.snapshotLog = [];
  FakeWebSocket.diskReadLog = [];
  window.history.pushState(null, "", `/workspaces/${WORKSPACE_ID}/sessions/session-a`);
  document.documentElement.innerHTML = readFileSync(
    join(process.cwd(), "public/index.html"),
    "utf8",
  );
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
    if (url === "/locales/en.json") return new Response(JSON.stringify(enMessages));
    if (url.startsWith("/v2/bootstrap")) {
      return new Response(
        JSON.stringify({
          workspaceId: WORKSPACE_ID,
          sessionId: "session-a",
          instanceId: "instance-a",
        }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
  // vi.spyOn(console, "debug").mockImplementation(() => {});
  // vi.spyOn(console, "log").mockImplementation(() => {});
  // vi.spyOn(console, "info").mockImplementation(() => {});
  // vi.spyOn(console, "warn").mockImplementation(() => {});
  globalThis.requestAnimationFrame = (callback) => callback();
  // jsdom lacks requestIdleCallback; the sidebar's registry-session warmup
  // (the source of mtime/size stamps) is scheduled through it.
  globalThis.requestIdleCallback = (callback) =>
    setTimeout(() => callback({ didTimeout: false }), 0);
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
  document.documentElement.innerHTML = "";
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.requestIdleCallback;
  delete globalThis.ResizeObserver;
  delete globalThis.IntersectionObserver;
});

async function settle(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("switching back to a cached session performs no snapshot or disk read and restores the view", async () => {
  await import("./app.js?svc-noop");

  const messages = document.getElementById("messages");

  // Foreground A via snapshot/disk (the full path), then reveal two batches.
  await selectSession("/pi/sessions/a.jsonl");
  await settle();
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(2);
  messages.querySelector(".history-gate-btn")?.click();
  await settle(20);
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(4);

  // The user scrolled up while reading; leave capture must remember it.
  // jsdom clamps scrollTop to (0-height) unless the property is owned.
  Object.defineProperty(messages, "scrollTop", {
    configurable: true,
    value: 480,
    writable: true,
  });
  await selectSession("/pi/sessions/b.jsonl");
  await settle();
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(2);
  const bFirst = messages.querySelector(".message.user").textContent;
  expect(bFirst).toContain("/pi/sessions/b.jsonl");

  FakeWebSocket.snapshotLog.length = 0;
  FakeWebSocket.diskReadLog.length = 0;

  await selectSession("/pi/sessions/a.jsonl");
  await settle();

  // No-op switch-back: no snapshot request, no disk read …
  expect(FakeWebSocket.snapshotLog).toHaveLength(0);
  expect(FakeWebSocket.diskReadLog).toHaveLength(0);
  // … the cached render is present with the restored gate reveal …
  const users = [...messages.querySelectorAll(".message.user")];
  expect(users).toHaveLength(4);
  expect(users[0].textContent).toContain("/pi/sessions/a.jsonl");
  // … and the scroll position was restored.
  expect(messages.scrollTop).toBe(480);
});

test("background message_end increments the cached view and stays no-op on switch-back", async () => {
  await import("./app.js?svc-increment");
  const messages = document.getElementById("messages");

  await selectSession("/pi/sessions/a.jsonl");
  await settle();
  await selectSession("/pi/sessions/b.jsonl");
  await settle();

  // A background message_end for session A arrives while B is foreground.
  const ws = FakeWebSocket.instances.at(-1);
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_event",
      target: {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSIONS["/pi/sessions/a.jsonl"].sessionId,
        instanceId: SESSIONS["/pi/sessions/a.jsonl"].instanceId,
      },
      event: {
        type: "message_end",
        sessionFile: "/pi/sessions/a.jsonl",
        entryId: "u-extra",
        message: { role: "user", content: "background follow-up" },
      },
    }),
  });
  await settle(20);

  FakeWebSocket.snapshotLog.length = 0;
  FakeWebSocket.diskReadLog.length = 0;
  await selectSession("/pi/sessions/a.jsonl");
  await settle();

  // Trusted cache: still no fetches …
  expect(FakeWebSocket.snapshotLog).toHaveLength(0);
  expect(FakeWebSocket.diskReadLog).toHaveLength(0);
  // … and the incremented content renders.
  expect(messages.textContent).toContain("background follow-up");
});

test("cache-hit switch-back re-arms the config readiness gate via a get_state probe", async () => {
  await import("./app.js?svc-readiness");

  await selectSession("/pi/sessions/a.jsonl");
  await settle();
  await selectSession("/pi/sessions/b.jsonl");
  await settle();

  FakeWebSocket.snapshotLog.length = 0;
  FakeWebSocket.diskReadLog.length = 0;
  await selectSession("/pi/sessions/a.jsonl");
  await settle();

  // No-op switch-back contract still holds …
  expect(FakeWebSocket.snapshotLog).toHaveLength(0);
  expect(FakeWebSocket.diskReadLog).toHaveLength(0);
  // … and the adopted target proved itself live through the get_state
  // probe, so ConfigGateway calls no longer gate until their 30s timeout
  // ("timed out waiting for runtime").
  expect(globalThis.__picotSessionView.configReady()).toBe(true);
});

test("cache-hit switch-back leaves the gate closed without a live probe reply", async () => {
  await import("./app.js?svc-readiness-neg");
  await selectSession("/pi/sessions/a.jsonl");
  await settle();
  await selectSession("/pi/sessions/b.jsonl");
  await settle();

  // The runtime never answers get_state: the gate must stay closed so
  // config calls surface the readiness timeout instead of firing blind.
  const ws = FakeWebSocket.instances.at(-1);
  const original = ws.send.bind(ws);
  ws.send = (raw) => {
    const frame = JSON.parse(raw);
    if (frame.type === "runtime_request" && frame.command?.type === "get_state") return;
    return original(raw);
  };

  await selectSession("/pi/sessions/a.jsonl");
  await settle();
  expect(globalThis.__picotSessionView.configReady()).toBe(false);
});
