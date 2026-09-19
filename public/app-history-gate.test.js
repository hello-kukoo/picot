// ABOUTME: P2 history fold gate — mount batching, reveal, search interaction.
// ABOUTME: Drives renderSessionHistory through the app harness like the
// ABOUTME: canonical-snapshot tests, then asserts what mounted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const wsInstances = [];

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    wsInstances.push(this);
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  reply(frame) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0);
  }

  send(raw) {
    const envelope = JSON.parse(raw);
    if (envelope.type === "hello") {
      this.reply({ type: "hello_ack", protocolVersion: 2 });
      return;
    }
    if (envelope.type === "runtime_subscribe") {
      this.reply({ type: "runtime_subscribed", requestId: envelope.requestId });
      return;
    }
    if (envelope.type === "host_request") {
      // The sidebar's registry load answers an empty registry, which
      // satisfies sessionsLoaded so mirror sync stops deferring.
      let response = null;
      if (envelope.operation === "workspace.list") {
        response = { workspaces: [], removed: [] };
      } else if (envelope.operation === "runtime_instances") {
        response = { instances: [] };
      }
      if (response) {
        this.reply({
          type: "host_response",
          requestId: envelope.requestId,
          ok: true,
          response,
        });
      }
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

beforeEach(async () => {
  wsInstances.length = 0;
  window.history.pushState(null, "", "/workspaces/w1/sessions/s1");
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
    if (url === "/locales/en.json") {
      return new Response(JSON.stringify(enMessages));
    }
    if (url.startsWith("/v2/bootstrap")) {
      return new Response(
        JSON.stringify({ workspaceId: "w1", sessionId: "s1", instanceId: "primary" }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
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
  document.documentElement.innerHTML = "";
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

const target = { workspaceId: "w1", sessionId: "s1", instanceId: "primary" };

function makeTurnEntries(n) {
  const entries = [];
  for (let i = 0; i < n; i += 1) {
    entries.push({
      id: `u${i}`,
      parentId: i === 0 ? null : `a${i - 1}`,
      type: "message",
      message: { role: "user", content: `prompt ${i}` },
    });
    entries.push({
      id: `a${i}`,
      parentId: `u${i}`,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] },
    });
  }
  return entries;
}

test("gate mounts the newest 2 turns plus one batch control; reveal mounts the next 2", async () => {
  const entries = makeTurnEntries(6);
  await import("./app.js?history-gate");

  const ws = wsInstances.at(-1);
  // Dispatch a foreground snapshot whose message list carries the entries
  // (the runtimeSnapshot handler maps bare messages into session entries).
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_snapshot",
      protocolVersion: 2,
      sequence: 1,
      target,
      state: {
        pi: { sessionFile: "/pi/sessions/s1.jsonl", isStreaming: false },
        messages: entries.map((entry) => entry.message),
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const messages = document.getElementById("messages");
  const userMessages = [...messages.querySelectorAll(".message.user")];
  const gate = messages.querySelector(".history-gate");

  // Newest 2 turns mounted; the gate control exists with the remaining count.
  expect(userMessages).toHaveLength(2);
  expect(userMessages[0].textContent).toContain("prompt 4");
  expect(userMessages[1].textContent).toContain("prompt 5");
  expect(gate).not.toBeNull();
  expect(gate.textContent).toContain("4");

  // P1: history turns render through the same turn-section contract as the
  // live stream — one <section class="turn" data-turn-id> per mounted turn,
  // minus the status header (logs carry no run duration). The section is the
  // rail registry's mounted anchor.
  const sections = [...messages.querySelectorAll("section.turn")];
  expect(sections).toHaveLength(2);
  for (const section of sections) {
    expect(section.dataset.turnId).toBeTruthy();
    expect(section.querySelector(".turn-status")).toBeNull();
    expect(section.querySelector(".turn-rail")).not.toBeNull();
    expect(section.querySelector(".turn-answer")).not.toBeNull();
  }

  // P2 interaction: with the gate closed the rail registry lists EVERY turn
  // of the session, not the mounted subset — folded turns carry previews with
  // a null anchor until revealed.
  const ticks = document.querySelectorAll("#conv-nav-track .conv-nav-dot");
  expect(ticks.length).toBeGreaterThan(2); // windowed, but sourced from all 6
  const railLabels = [...ticks].map((tick) => tick.getAttribute("aria-label"));
  expect(railLabels.some((label) => label.includes("prompt 0"))).toBe(true);

  // "Load older history" mounts the next 2 in order, anchored above.
  const scrollTopBefore = messages.scrollTop;
  gate.querySelector(".history-gate-btn").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const usersAfter = [...messages.querySelectorAll(".message.user")];
  expect(usersAfter).toHaveLength(4);
  expect(usersAfter[0].textContent).toContain("prompt 2");
  expect(messages.scrollTop).toBeGreaterThanOrEqual(scrollTopBefore);
  // Control remains with the updated count.
  expect(messages.querySelector(".history-gate").textContent).toContain("2");

  // "Load all history" mounts every remaining turn.
  messages.querySelector(".history-gate-all").click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(6);
  expect(messages.querySelector(".history-gate")).toBeNull();
});

test("a search render mounts all turns before highlighting; the gate re-applies next plain render", async () => {
  const entries = makeTurnEntries(5);
  await import("./app.js?history-gate-search");
  const ws = wsInstances.at(-1);

  const snapshot = (messages, seq, sessionFile = "/pi/sessions/s2.jsonl") =>
    ws.onmessage({
      data: JSON.stringify({
        type: "runtime_snapshot",
        protocolVersion: 2,
        sequence: seq,
        target,
        state: { pi: { sessionFile, isStreaming: false }, messages },
      }),
    });

  snapshot(
    entries.map((e) => e.message),
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const messages = document.getElementById("messages");
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(2);
  expect(messages.querySelector(".history-gate")).not.toBeNull();

  // The real search path: the sidebar search input drives sidebar.searchQuery
  // (via setupSidebarSearchControl), and the next transcript render passes it
  // into renderSessionHistory — the same chain production uses.
  const searchInput = document.getElementById("session-search-input");
  searchInput.value = "1";
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  snapshot(
    entries.map((e) => e.message),
    2,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // (a) The search render mounts every folded turn before highlighting, so
  // old matches are findable; highlights are applied to the mounted DOM.
  const users = [...messages.querySelectorAll(".message.user")];
  expect(users).toHaveLength(5);
  expect(users.some((el) => el.textContent.includes("prompt 1"))).toBe(true);
  expect(messages.querySelectorAll("mark[data-search-highlight='true']").length).toBeGreaterThan(0);

  // (b) Clearing the query and re-rendering restores the gate: newest 2
  // mounted plus one batch control (forceReset from the search render).
  searchInput.value = "";
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  snapshot(
    entries.map((e) => e.message),
    3,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(2);
  expect(messages.querySelector(".history-gate")).not.toBeNull();

  // A session switch resets the reveal state.
  const otherEntries = makeTurnEntries(4);
  window.history.pushState(null, "", "/workspaces/w1/sessions/s9");
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_snapshot",
      protocolVersion: 2,
      sequence: 4,
      target: { workspaceId: "w1", sessionId: "s9", instanceId: "primary" },
      state: {
        pi: { sessionFile: "/pi/sessions/s9.jsonl", isStreaming: false },
        messages: otherEntries.map((e) => e.message),
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect([...messages.querySelectorAll(".message.user")]).toHaveLength(2);
});

test("history turns render the user row above the rail and the answer", async () => {
  // Regression: the turn section is built rail → answer, so a user bubble simply
  // appended into it lands BELOW its own answer (observed on real sessions:
  // every turn read assistant-first, user-last). The bubble must be claimed
  // into the user slot, as the live path does.
  const entries = [
    {
      id: "u1",
      parentId: null,
      type: "message",
      message: { role: "user", content: "first prompt" },
    },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
      },
    },
    {
      id: "r1",
      parentId: "a1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "ok" }],
      },
    },
    {
      id: "a2",
      parentId: "r1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    },
  ];

  await import("./app.js?history-turn-order");
  const ws = wsInstances.at(-1);
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_snapshot",
      protocolVersion: 2,
      sequence: 1,
      target,
      state: {
        pi: { sessionFile: "/pi/sessions/order.jsonl", isStreaming: false },
        messages: entries.map((entry) => entry.message),
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const turn = document.querySelector("#messages section.turn");
  expect(turn).not.toBeNull();
  expect([...turn.children].map((child) => child.className.split(" ")[0])).toEqual([
    "message",
    "process-details-group",
    "turn-answer",
  ]);
  expect(turn.querySelector(".message.user")?.textContent).toContain("first prompt");
  expect(turn.querySelector(".turn-answer")?.textContent).toContain("first answer");
});

test("turns revealed by the batch controls keep the user row above the answer", async () => {
  // Regression: the reveal path renders each turn into a DocumentFragment, so a
  // user-slot claim that requires an attached node silently does nothing there —
  // the first paint looked right while every batch-revealed turn read
  // assistant-first, user-last.
  const entries = makeTurnEntries(6);
  await import("./app.js?history-gate-reveal-order");
  const ws = wsInstances.at(-1);
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_snapshot",
      protocolVersion: 2,
      sequence: 1,
      target,
      state: {
        pi: { sessionFile: "/pi/sessions/reveal.jsonl", isStreaming: false },
        messages: entries.map((entry) => entry.message),
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const messages = document.getElementById("messages");
  const assertTurnOrder = () => {
    for (const turn of messages.querySelectorAll("section.turn")) {
      const first = turn.firstElementChild;
      expect(first.classList.contains("message")).toBe(true);
      expect(first.classList.contains("user")).toBe(true);
      const answer = turn.querySelector(".turn-answer");
      if (answer) {
        // 4 = DOCUMENT_POSITION_FOLLOWING: the answer follows the user row.
        expect(first.compareDocumentPosition(answer) & 4).toBeTruthy();
      }
    }
  };
  assertTurnOrder();

  messages.querySelector(".history-gate-btn")?.click(); // Load older history
  await new Promise((resolve) => setTimeout(resolve, 60));
  // The newly revealed turns must obey the same order as the first paint.
  expect(messages.querySelectorAll("section.turn").length).toBeGreaterThan(2);
  assertTurnOrder();

  messages.querySelector(".history-gate-all")?.click(); // Load all history
  await new Promise((resolve) => setTimeout(resolve, 120));
  assertTurnOrder();
});
