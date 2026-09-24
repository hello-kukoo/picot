// ABOUTME: Steering/queue UX integration (2026-09-19 spec) — streaming Enter
// ABOUTME: sends a steer, queue pills come from queue_update, clear_queue is
// ABOUTME: reachable, Esc clears before aborting, and steer attachments stay
// ABOUTME: composer-owned until the correlated acceptance releases them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";

// The real processor decodes/resizes via canvas, which jsdom cannot run. The
// logic under test is the composer→C3 attachment ownership, not the codec.
vi.mock("./image-attachments.js", () => ({
  processImageFile: async (file) => ({ data: "FAKE-BASE64", mimeType: file?.type || "image/png" }),
  processImagePayload: async (payload) => ({
    data: payload?.data ?? "FAKE-BASE64",
    mimeType: payload?.mimeType || "image/png",
  }),
  isSupportedImageMime: () => true,
}));

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
let deferPromptResponse = false;
let deferredPromptId = null;

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
      if (command.type === "prompt" && deferPromptResponse) {
        deferredPromptId = envelope.requestId;
        return;
      }
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
  deferPromptResponse = false;
  deferredPromptId = null;
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
  ws.sent.filter(
    (frame) =>
      frame.type === "runtime_request" &&
      frame.command?.type === type &&
      // The picot-config bridge rides the same `prompt` command type; it is
      // infrastructure traffic (config reads released by the readiness gate),
      // never part of the chat flows these assertions count.
      !String(frame.command.message ?? "").startsWith("/picot-config"),
  );

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

function pasteImage() {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      // A real paste carries text accessors too; the paste-offload listener
      // reads them, so the stub must not be image-only.
      getData: () => "",
      files: [],
      items: [
        {
          type: "image/png",
          getAsFile: () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }),
        },
      ],
    },
  });
  document.getElementById("message-input").dispatchEvent(event);
}

function pendingPreviews() {
  return [...document.querySelectorAll("#image-previews .image-preview")];
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
  // "run 真正终止" from the UI's side: back to idle (send visible, abort gone).
  expect(document.getElementById("abort-btn").classList.contains("hidden")).toBe(true);
  expect(document.getElementById("send-btn").classList.contains("hidden")).toBe(false);
  expect(document.getElementById("send-caret-btn").classList.contains("hidden")).toBe(true);
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

test("idle Alt+Enter degrades to a direct send", async () => {
  await import("./app.js?steering-alt-enter-idle");
  const ws = wsInstances.at(-1);
  await settle();

  typeIntoComposer("idle alt enter");
  pressAltEnter();
  await settle();

  // Spec 按钮可见性: a bare keypress has no disabled state to show, so idle
  // Alt+Enter degrades to the ordinary send instead of blocking.
  expect(commandFrames(ws, "follow_up")).toHaveLength(0);
  const prompts = commandFrames(ws, "prompt");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].command.message).toBe("idle alt enter");
  expect(prompts[0].command.streamingBehavior).toBeUndefined();
});

test("switching the session identity drops the previous session's queue pills", async () => {
  await import("./app.js?steering-queue-scope");
  const ws = wsInstances.at(-1);
  await settle();
  const snapshot = (sessionFile, sequence) =>
    ws.onmessage({
      data: JSON.stringify({
        type: "runtime_snapshot",
        protocolVersion: 2,
        sequence,
        target,
        state: { pi: { sessionFile, isStreaming: true }, messages: [] },
      }),
    });

  snapshot("/pi/sessions/s1.jsonl", 1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t13" });
  await settle();
  renderPiQueue(ws, ["belongs to s1"], [], 2);
  await settle();
  const queueEl = document.getElementById("pi-queue");
  expect(queueEl.classList.contains("hidden")).toBe(false);

  // Same-runtime session switch: the identity changes without a page reload.
  snapshot("/pi/sessions/s2.jsonl", 3);
  await settle();

  expect(queueEl.classList.contains("hidden")).toBe(true);
});

test("the panel comes back when pi reports a new queue after a clear", async () => {
  await import("./app.js?steering-queue-repaint");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t14" });
  await settle();
  renderPiQueue(ws, ["first"], [], 2);
  await settle();

  clearQueueData = { steering: ["first"], followUp: [] };
  document.getElementById("pi-queue").querySelector(".pi-queue-clear").click();
  await settle();
  expect(document.getElementById("pi-queue").classList.contains("hidden")).toBe(true);

  // The hide was a confirmed clear, not a permanent one.
  renderPiQueue(ws, ["second"], ["after"], 3);
  await settle();
  const queueEl = document.getElementById("pi-queue");
  expect(queueEl.classList.contains("hidden")).toBe(false);
  expect([...queueEl.querySelectorAll(".queued-msg-label")].map((el) => el.textContent)).toEqual([
    "Steer",
    "Follow-up",
  ]);
});

test("Esc during an in-flight steer keeps the restored text", async () => {
  await import("./app.js?steering-esc-inflight");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t15" });
  await settle();

  deferPromptResponse = true;
  typeIntoComposer("hold on please");
  pressEnter();
  await settle();
  expect(commandFrames(ws, "prompt")).toHaveLength(1);

  // pi had queued it, so Esc's clear returns exactly that text.
  clearQueueData = { steering: ["hold on please"], followUp: [] };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(120);
  const input = document.getElementById("message-input");
  expect(input.value).toContain("hold on please");

  // The steer's own acceptance lands after the clear: it must not now wipe the
  // text that the clear just restored (Q3-A: 不丢字).
  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_response",
      requestId: deferredPromptId,
      response: { success: true, data: {} },
    }),
  });
  await settle();
  expect(input.value).toContain("hold on please");
});

test("clearing restores both buckets, in queue order, when the composer is empty", async () => {
  await import("./app.js?steering-clear-both");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t16" });
  await settle();
  renderPiQueue(ws, ["steer text"], ["follow-up text"], 2);
  await settle();

  // pi returns both buckets (verified against 0.85.1); the refill joins them.
  clearQueueData = { steering: ["steer text"], followUp: ["follow-up text"] };
  document.getElementById("pi-queue").querySelector(".pi-queue-clear").click();
  await settle();

  expect(document.getElementById("message-input").value).toBe("steer text\nfollow-up text");
  expect(document.getElementById("pi-queue").classList.contains("hidden")).toBe(true);
});

test("a steer carries the pending image and acceptance releases exactly it", async () => {
  await import("./app.js?steering-attachments");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t17" });
  await settle();

  pasteImage();
  await settle();
  expect(pendingPreviews()).toHaveLength(1);

  deferPromptResponse = true;
  typeIntoComposer("look at this");
  pressEnter();
  await settle();

  const steers = commandFrames(ws, "prompt").filter(
    (frame) => frame.command.streamingBehavior === "steer",
  );
  expect(steers).toHaveLength(1);
  expect(steers[0].command.images).toEqual([
    { type: "image", data: "FAKE-BASE64", mimeType: "image/png" },
  ]);
  // C3 keeps the attachments owned by the composer until pi answers.
  expect(pendingPreviews()).toHaveLength(1);

  ws.onmessage({
    data: JSON.stringify({
      type: "runtime_response",
      requestId: deferredPromptId,
      response: { success: true, data: {} },
    }),
  });
  await settle();
  expect(pendingPreviews()).toHaveLength(0);
  expect(document.getElementById("image-previews").classList.contains("hidden")).toBe(true);
});

test("a rejected steer leaves the pending image attached", async () => {
  await import("./app.js?steering-attachments-rejected");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t18" });
  await settle();

  pasteImage();
  await settle();
  expect(pendingPreviews()).toHaveLength(1);

  promptFails = true;
  typeIntoComposer("this one gets rejected");
  pressEnter();
  await settle();

  expect(commandFrames(ws, "prompt")).toHaveLength(1);
  // The steer never reached pi, so the attachment must still be there to send.
  expect(pendingPreviews()).toHaveLength(1);
});

test("pi's echo of a steer renders above that turn's answer, not below it", async () => {
  await import("./app.js?steering-echo-order");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t19" });
  await settle();

  // A steer draws no optimistic bubble, and pi emits agent_start BEFORE the
  // user echo (probe: 0.4s agent_start, 0.4s message_start(user)). So the echo
  // is the turn's only user row and must land inside the turn, above its
  // status/rail/answer — otherwise the prompt shows up under its own answer.
  runtimeEvent(
    ws,
    {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "steer me" }] },
    },
    2,
  );
  await settle();
  runtimeEvent(ws, { type: "message_start", message: { role: "assistant", content: [] } }, 3);
  runtimeEvent(
    ws,
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      assistantMessageEvent: { type: "text_delta", delta: "the answer" },
    },
    4,
  );
  await settle();

  const messages = document.getElementById("messages");
  const turn = messages.querySelector("section.turn");
  expect(turn).not.toBeNull();
  const userRow = turn.querySelector(".message.user");
  expect(userRow).not.toBeNull();
  expect(userRow.textContent).toContain("steer me");
  // Order inside the turn: user → status → rail → answer.
  const ordered = [...turn.children].map((child) => child.className.split(" ")[0]);
  expect(ordered[0]).toBe("message");
  expect(turn.firstElementChild).toBe(userRow);
});

test("a follow-up delivered inside the same run opens its own turn", async () => {
  // pi sends NO agent_start for a follow-up: it drains inside the running turn
  // (probe: queue_update followUp=[] → message_start(user) → assistant, one
  // agent_end). Without a turn boundary here the second task's answer keeps
  // appending to the first turn and its prompt lands below both answers.
  await import("./app.js?steering-followup-turn");
  const ws = wsInstances.at(-1);
  await settle();
  runtimeEvent(ws, { type: "agent_start", turnId: "t20" });
  await settle();

  const userStart = (text, sequence) =>
    runtimeEvent(
      ws,
      { type: "message_start", message: { role: "user", content: [{ type: "text", text }] } },
      sequence,
    );
  const assistantText = (text, sequence) => {
    runtimeEvent(
      ws,
      { type: "message_start", message: { role: "assistant", content: [] } },
      sequence,
    );
    runtimeEvent(
      ws,
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text }] },
        assistantMessageEvent: { type: "text_delta", delta: text },
      },
      sequence + 1,
    );
  };

  userStart("first prompt", 2);
  await settle();
  assistantText("first answer", 3);
  await settle();

  userStart("follow-up prompt", 5); // same run: no agent_start
  await settle();
  assistantText("second answer", 6);
  await settle();

  const messages = document.getElementById("messages");
  const turns = [...messages.querySelectorAll("section.turn")];
  expect(turns).toHaveLength(2);
  // No user row may be left floating outside a turn.
  expect(messages.querySelectorAll(":scope > .message.user")).toHaveLength(0);

  expect(turns[0].firstElementChild?.textContent).toContain("first prompt");
  expect(turns[0].querySelector(".turn-answer")?.textContent).toContain("first answer");
  expect(turns[0].querySelector(".turn-answer")?.textContent).not.toContain("second answer");
  expect(turns[1].firstElementChild?.textContent).toContain("follow-up prompt");
  expect(turns[1].querySelector(".turn-answer")?.textContent).toContain("second answer");
  // The first task really did finish at that boundary, so its status row
  // settles with a duration instead of going blank; the new turn is live.
  expect(turns[0].querySelector(".turn-status")?.textContent).toContain("Worked for");
  expect(turns[1].querySelector(".turn-status")?.classList.contains("live")).toBe(true);
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
