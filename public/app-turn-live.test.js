// ABOUTME: P1 live-turn behavior: a scripted event stream renders one turn
// ABOUTME: section whose projection (rail order, answer, status) matches the
// ABOUTME: structural contract history rendering produces for the same blocks.
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
    // Async open so wsClient's onopen/onmessage assignments land first.
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

beforeEach(async () => {
  wsInstances.length = 0;
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
    if (String(input) === "/locales/en.json") {
      return new Response(JSON.stringify(enMessages));
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

test("a scripted live turn renders rail + answer + settled status in one section", async () => {
  await import("./app.js?turn-live-projection");

  const ws = wsInstances.at(-1);
  expect(ws).toBeTruthy();

  let sequence = 0;
  const target = { workspaceId: "w1", sessionId: "s1", instanceId: "primary" };
  const send = (event, extra = {}) =>
    ws.onmessage({
      data: JSON.stringify({
        type: "runtime_event",
        protocolVersion: 2,
        sequence: ++sequence,
        target,
        event,
        ...extra,
      }),
    });

  const assistantMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

  // ── The scripted sequence from the spec's verification note ──
  send({ type: "agent_start", turnId: "turn-7" });
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
    assistantMessageEvent: { type: "thinking_delta", delta: "pondering" },
  });
  send({
    type: "message_update",
    message: assistantMessage("Step one"),
    assistantMessageEvent: { type: "text_delta", delta: "Step one" },
  });
  send({ type: "message_end", message: assistantMessage("Step one"), entryId: "e1" });
  send({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "t1",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  });
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({
    type: "message_update",
    message: assistantMessage("Final answer"),
    assistantMessageEvent: { type: "text_delta", delta: "Final answer" },
  });
  send({ type: "message_end", message: assistantMessage("Final answer"), entryId: "e2" });
  send({ type: "agent_end" });

  // Let any pending microtasks (async handlers) settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const messages = document.getElementById("messages");
  const sections = messages.querySelectorAll("section.turn");
  expect(sections).toHaveLength(1);
  const section = sections[0];
  expect(section.dataset.turnId).toBe("turn-7");

  // Thinking renders ONCE, in the rail — never inside the answer's content
  // (the finalize path must not duplicate what the rail already owns).
  const thinkingBlocks = section.querySelectorAll(".thinking-block");
  expect(thinkingBlocks).toHaveLength(1);
  expect(section.querySelector(".turn-rail .thinking-block")).not.toBeNull();
  expect(section.querySelectorAll(".turn-answer .thinking-block")).toHaveLength(0);

  // Rail: thinking, then the demoted first text segment, then the tool card
  // (arrival order), styled like history rail rows.
  const railBody = section.querySelector(".turn-rail .process-details-body");
  const railChildren = [...railBody.children];
  expect(railChildren).toHaveLength(3);
  expect(railChildren[0].classList.contains("thinking-block")).toBe(true);
  expect(railChildren[0].textContent).toContain("pondering");
  expect(railChildren[1].classList.contains("assistant")).toBe(true);
  expect(railChildren[1].dataset.turnDemoted).toBe("true");
  expect(railChildren[1].classList.contains("history")).toBe(true);
  expect(railChildren[1].querySelector(".message-actions")).toBeNull();
  expect(railChildren[1].textContent).toContain("Step one");
  expect(railChildren[1].dataset.entryId).toBe("e1");
  expect(railChildren[2].classList.contains("tool-card")).toBe(true);
  expect(railChildren[2].dataset.toolCallId).toBe("t1");

  // Answer: the final assistant text stays in the answer slot with its toolbar.
  const answer = section.querySelector(".turn-answer");
  const answerMessages = answer.querySelectorAll(".message.assistant");
  expect(answerMessages).toHaveLength(1);
  expect(answerMessages[0].textContent).toContain("Final answer");
  expect(answerMessages[0].dataset.entryId).toBe("e2");
  expect(answerMessages[0].querySelector(".message-actions")).not.toBeNull();

  // Status settled, rail folded to its summary label.
  const status = section.querySelector(".turn-status");
  expect(status.classList.contains("settled")).toBe(true);
  expect(status.textContent).toContain("Worked for");
  expect(section.querySelector(".turn-rail").classList.contains("expanded")).toBe(false);
  expect(section.querySelector(".process-details-label").textContent).toContain("2");
  expect(section.querySelector(".process-details-label").textContent).toContain("1");
});

test("abort mid-turn closes the live turn — settled without duration, rail folded, no live spinner", async () => {
  await import("./app.js?turn-live-abort");

  const ws = wsInstances.at(-1);
  let sequence = 0;
  const target = { workspaceId: "w1", sessionId: "s1", instanceId: "primary" };
  const send = (event) =>
    ws.onmessage({
      data: JSON.stringify({
        type: "runtime_event",
        protocolVersion: 2,
        sequence: ++sequence,
        target,
        event,
      }),
    });

  send({ type: "agent_start", turnId: "turn-abort" });
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "partial work" }] },
    assistantMessageEvent: { type: "text_delta", delta: "partial work" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const messages = document.getElementById("messages");
  let section = messages.querySelector("section.turn[data-turn-id='turn-abort']");
  expect(section).not.toBeNull();
  expect(section.querySelector(".turn-status").classList.contains("live")).toBe(true);

  // User abort: agent_end is delayed/missing — the click alone must close
  // the turn (no leftover live spinner or 1s status timer).
  document.getElementById("abort-btn").click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  section = messages.querySelector("section.turn[data-turn-id='turn-abort']");
  expect(section).not.toBeNull();
  const status = section.querySelector(".turn-status");
  expect(status.classList.contains("live")).toBe(false);
  expect(status.classList.contains("settled")).toBe(true);
  // Aborted runs never completed: no duration is claimed.
  expect(status.textContent).not.toContain("Worked for");
  expect(section.querySelector(".turn-rail").classList.contains("expanded")).toBe(false);
});
