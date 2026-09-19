// ABOUTME: Steering/queue UX integration (2026-09-19 spec) — streaming Enter
// ABOUTME: sends a steer, queue pills come from queue_update, clear_queue is
// ABOUTME: reachable from the WebView, and Esc clears before aborting.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";

// The composer only enables sending once Pi has reported configured models, and
// that list arrives through the picot-config bridge — outside this test's fake
// WebSocket. Pin the onboarding gate open so the send paths are reachable; the
// gate itself is covered by its own module test.
vi.mock("./session/onboarding.js", () => ({
  getOnboardingState: () => ({
    canQuery: true,
    canType: true,
    needsProject: false,
    needsModel: false,
    message: "",
  }),
}));

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const wsInstances = [];
let clearQueueData = { steering: [], followUp: [] };
let clearQueueFails = false;
let commandRegistry = [];
let swallowClearQueue = false;
let promptFails = false;

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
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
    this.sent.push(envelope);
    if (envelope.type === "hello") {
      this.reply({ type: "hello_ack", protocolVersion: 2 });
      return;
    }
    if (envelope.type === "runtime_subscribe") {
      this.reply({ type: "runtime_subscribed", requestId: envelope.requestId });
      return;
    }
    if (envelope.type === "host_request") {
      let response = null;
      if (envelope.operation === "workspace.list") response = { workspaces: [], removed: [] };
      else if (envelope.operation === "runtime_instances") response = { instances: [] };
      if (response) {
        this.reply({ type: "host_response", requestId: envelope.requestId, ok: true, response });
      }
      return;
    }
    if (envelope.type === "runtime_request") {
      const command = envelope.command || {};
      if (command.type === "prompt" && promptFails) {
        this.reply({
          type: "runtime_response",
          requestId: envelope.requestId,
          response: { success: false, error: "steer rejected by pi" },
        });
        return;
      }
      if (command.type === "clear_queue" && swallowClearQueue) {
        // Deliberately never answer: exercises the abort cap.
        return;
      }
      if (command.type === "clear_queue" && clearQueueFails) {
        this.reply({
          type: "runtime_response",
          requestId: envelope.requestId,
          response: { success: false, error: "clear_queue rejected" },
        });
        return;
      }
      const data =
        command.type === "get_commands"
          ? { commands: commandRegistry }
          : command.type === "clear_queue"
            ? clearQueueData
            : {};
      this.reply({
        type: "runtime_response",
        requestId: envelope.requestId,
        response: { success: true, data },
      });
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

beforeEach(async () => {
  wsInstances.length = 0;
  clearQueueData = { steering: [], followUp: [] };
  clearQueueFails = false;
  commandRegistry = [];
  swallowClearQueue = false;
  promptFails = false;
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
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function runtimeEvent(ws, event, sequence = 1) {
  ws.onmessage({
    data: JSON.stringify({ type: "runtime_event", protocolVersion: 2, sequence, target, event }),
  });
}

const commandFrames = (ws, type) =>
  ws.sent.filter((frame) => frame.type === "runtime_request" && frame.command?.type === type);

function typeIntoComposer(text) {
  const input = document.getElementById("message-input");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

function pressAltEnter() {
  document
    .getElementById("message-input")
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }),
    );
}

function pressEnter() {
  document
    .getElementById("message-input")
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function renderPiQueue(ws, steering, followUp, sequence) {
  runtimeEvent(ws, { type: "queue_update", steering, followUp }, sequence);
}

test("streaming Enter sends a steer prompt with no optimistic bubble", async () => {
  await import("./app.js?steering-enter");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t1" });
  await settle();

  typeIntoComposer("switch to tabs");
  pressEnter();
  await settle();

  const steers = commandFrames(ws, "prompt").filter(
    (frame) => frame.command.streamingBehavior === "steer",
  );
  expect(steers).toHaveLength(1);
  expect(steers[0].command.message).toBe("switch to tabs");
  // The pill comes from queue_update, never from a hand-rendered bubble.
  expect(document.querySelectorAll("#messages .message.user")).toHaveLength(0);
});

test("idle Enter still sends a plain prompt without streamingBehavior", async () => {
  await import("./app.js?steering-idle");
  const ws = wsInstances.at(-1);
  await settle();

  typeIntoComposer("plain question");
  pressEnter();
  await settle();

  const prompts = commandFrames(ws, "prompt");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].command.streamingBehavior).toBeUndefined();
});

test("queue_update renders read-only pills and clear_queue refills the composer", async () => {
  await import("./app.js?steering-clear");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t2" });
  await settle();
  renderPiQueue(ws, ["switch to tabs"], ["summarize"], 2);
  await settle();

  const queueEl = document.getElementById("pi-queue");
  expect(queueEl.classList.contains("hidden")).toBe(false);
  expect([...queueEl.querySelectorAll(".queued-msg-label")].map((el) => el.textContent)).toEqual([
    "Steer",
    "Follow-up",
  ]);
  // Per-item removal does not exist in the protocol, so rows carry no control.
  expect(queueEl.querySelectorAll(".queued-msg button")).toHaveLength(0);

  clearQueueData = { steering: ["switch to tabs"], followUp: ["summarize"] };
  queueEl.querySelector(".pi-queue-clear").click();
  await settle();

  // The P0 regression guard: the frame must actually reach the runtime.
  expect(commandFrames(ws, "clear_queue")).toHaveLength(1);
  const input = document.getElementById("message-input");
  expect(input.value).toContain("switch to tabs");
  expect(input.value).toContain("summarize");
  expect(document.getElementById("pi-queue").classList.contains("hidden")).toBe(true);
});

test("a rejected clear keeps the pills and leaves the composer untouched", async () => {
  await import("./app.js?steering-clear-fails");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t3" });
  await settle();
  renderPiQueue(ws, ["keep me queued"], [], 2);
  await settle();

  clearQueueFails = true;
  const input = document.getElementById("message-input");
  input.value = "";
  // rpcCommand logs the rejection; assert the exact expected line instead of
  // letting it pollute the run output.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  document.getElementById("pi-queue").querySelector(".pi-queue-clear").click();
  await settle();

  expect(errorSpy).toHaveBeenCalledWith(
    "rpcCommand failed:",
    "clear_queue",
    "clear_queue rejected",
  );
  expect(commandFrames(ws, "clear_queue")).toHaveLength(1);
  // Nothing was cleared at pi, so nothing may claim it was.
  expect(input.value).toBe("");
  expect(document.getElementById("pi-queue").classList.contains("hidden")).toBe(false);
});

test("Escape clears the pi queue before aborting and restores the text", async () => {
  await import("./app.js?steering-esc");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t4" });
  await settle();
  clearQueueData = { steering: ["hold on"], followUp: [] };

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(80);

  const clearIndex = ws.sent.findIndex((frame) => frame.command?.type === "clear_queue");
  // Every runtime command rides `{type:"runtime_request", command:{...}}`.
  const abortIndex = ws.sent.findIndex((frame) => frame.command?.type === "abort");
  expect(clearIndex).toBeGreaterThanOrEqual(0);
  expect(abortIndex).toBeGreaterThan(clearIndex);
  expect(document.getElementById("message-input").value).toContain("hold on");
});

test("an extension command while streaming goes out as a bare prompt", async () => {
  commandRegistry = [{ name: "mycommand", source: "extension", description: "runs code" }];
  await import("./app.js?steering-extension");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t6" });
  await settle();

  typeIntoComposer("/mycommand now");
  pressEnter();
  await settle();

  // rpc.md: extension commands execute immediately even mid-run, so the send
  // must stay a bare prompt — never a queued steer.
  const prompts = commandFrames(ws, "prompt");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].command.message).toBe("/mycommand now");
  expect(prompts[0].command.streamingBehavior).toBeUndefined();
});

test("clearing appends the restored text below an existing draft", async () => {
  await import("./app.js?steering-refill-append");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t7" });
  await settle();
  renderPiQueue(ws, ["queued follow-up text"], [], 2);
  await settle();

  clearQueueData = { steering: ["queued follow-up text"], followUp: [] };
  const input = typeIntoComposer("draft I typed");
  document.getElementById("pi-queue").querySelector(".pi-queue-clear").click();
  await settle();

  expect(input.value).toBe("draft I typed\nqueued follow-up text");
});

test("Escape aborts even when clear_queue fails", async () => {
  await import("./app.js?steering-esc-clear-fails");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t8" });
  await settle();
  clearQueueFails = true;
  // rpcCommand logs the rejection; assert the exact line so the run stays clean.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(80);

  expect(errorSpy).toHaveBeenCalledWith(
    "rpcCommand failed:",
    "clear_queue",
    "clear_queue rejected",
  );
  // Spec Q3-A: a failed clear must not hold the abort back.
  expect(commandFrames(ws, "clear_queue")).toHaveLength(1);
  expect(commandFrames(ws, "abort")).toHaveLength(1);
});

test("Escape aborts within the cap when clear_queue never answers", async () => {
  await import("./app.js?steering-esc-cap");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t9" });
  await settle();
  swallowClearQueue = true;

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(1200);

  // The review correction recorded in the spec: an unresponsive pi must not
  // delay the real stop behind wsRequest's 15s default.
  expect(commandFrames(ws, "clear_queue")).toHaveLength(1);
  expect(commandFrames(ws, "abort")).toHaveLength(1);
}, 15000);

test("Alt+Enter while streaming queues a follow_up, not a steer", async () => {
  await import("./app.js?steering-alt-enter");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t10" });
  await settle();

  typeIntoComposer("summarize when done");
  pressAltEnter();
  await settle();

  const followUps = commandFrames(ws, "follow_up");
  expect(followUps).toHaveLength(1);
  expect(followUps[0].command.message).toBe("summarize when done");
  expect(followUps[0].command.streamingBehavior).toBeUndefined();
  // C5: the queued message surfaces via queue_update, never as a local bubble.
  expect(commandFrames(ws, "prompt")).toHaveLength(0);
  expect(document.querySelectorAll("#messages .message.user")).toHaveLength(0);
});

test("a rejected steer keeps the run's streaming state", async () => {
  await import("./app.js?steering-steer-rejected");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t11" });
  await settle();

  const abortBtn = document.getElementById("abort-btn");
  const typing = document.getElementById("typing-indicator");
  expect(abortBtn.classList.contains("hidden")).toBe(false);

  promptFails = true;
  typeIntoComposer("steer that pi rejects");
  pressEnter();
  await settle();

  expect(commandFrames(ws, "prompt")).toHaveLength(1);
  // The steer dispatch rides promptDelivery (not rpcCommand), so the failure
  // surfaces as a transcript error row carrying pi's message.
  const errorRow = document.querySelector("#messages .error-message");
  expect(errorRow).not.toBeNull();
  expect(errorRow.textContent).toContain("steer rejected by pi");
  // Q1-A: a rejection of a dispatch made MID-RUN must not end the run's
  // streaming state — the run is still going, only this steer failed.
  expect(abortBtn.classList.contains("hidden")).toBe(false);
  expect(typing.classList.contains("hidden")).toBe(false);
  // And the failed text comes back to the composer.
  expect(document.getElementById("message-input").value).toContain("steer that pi rejects");
});

test("a steer renders no optimistic bubble, and pi's echo still appears", async () => {
  await import("./app.js?steering-echo");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t12" });
  await settle();

  typeIntoComposer("steer me");
  pressEnter();
  await settle();
  // Mid-run sends draw no bubble of their own (the pill comes from queue_update).
  expect(document.querySelectorAll("#messages .message.user")).toHaveLength(0);

  // Later pi delivers it and echoes the user message: with no `lastSentMessage`
  // accounting for steers, that echo is what puts the prompt in the transcript.
  runtimeEvent(
    ws,
    {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "steer me" }] },
    },
    2,
  );
  await settle();
  const bubbles = [...document.querySelectorAll("#messages .message.user")];
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0].textContent).toContain("steer me");
});

test("an idle direct send still dedupes its own echo", async () => {
  await import("./app.js?steering-echo-idle");
  const ws = wsInstances.at(-1);
  await settle();

  typeIntoComposer("plain question");
  pressEnter();
  await settle();
  // The optimistic bubble is rendered up front for a direct send...
  expect(document.querySelectorAll("#messages .message.user")).toHaveLength(1);

  // ...so pi's echo of the same text must not double it (lastSentMessage).
  runtimeEvent(
    ws,
    {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "plain question" }] },
    },
    1,
  );
  await settle();
  expect(document.querySelectorAll("#messages .message.user")).toHaveLength(1);
});

test("the delayed-send caret exists only while a run is active", async () => {
  await import("./app.js?steering-caret");
  const ws = wsInstances.at(-1);
  await settle();
  const caret = document.getElementById("send-caret-btn");
  const abortBtn = document.getElementById("abort-btn");
  expect(caret.classList.contains("hidden")).toBe(true);
  // Spec 按钮可见性: while streaming the caret must sit to the LEFT of the red
  // abort button (4 = DOCUMENT_POSITION_FOLLOWING).
  expect(caret.compareDocumentPosition(abortBtn) & 4).toBeTruthy();

  runtimeEvent(ws, { type: "agent_start", turnId: "t5" });
  await settle();
  expect(caret.classList.contains("hidden")).toBe(false);

  runtimeEvent(ws, { type: "agent_end" }, 2);
  await settle();
  expect(caret.classList.contains("hidden")).toBe(true);
});
