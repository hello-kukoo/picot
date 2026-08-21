// ABOUTME: Verifies StateManager message/tool/streaming state and listener notifications.
// ABOUTME: Covers the full lifecycle: add, update, streaming toggle, tool execution map, reset.
import { expect, test } from "vitest";
import { StateManager } from "./state.js";

test("starts with empty state and idle streaming", () => {
  const sm = new StateManager();
  expect(sm.messages).toEqual([]);
  expect(sm.toolExecutions.size).toBe(0);
  expect(sm.isStreaming).toBe(false);
  expect(sm.currentStreamingMessage).toBe(null);
});

test("addMessage appends and notifies listeners", () => {
  const sm = new StateManager();
  const calls = [];
  const cb = () => calls.push(Date.now());
  sm.addListener(cb);
  sm.addMessage({ role: "user", content: "hi" });
  expect(sm.messages).toHaveLength(1);
  expect(sm.messages[0].content).toBe("hi");
  expect(calls).toHaveLength(1);
});

test("updateLastMessage merges fields and notifies when messages exist", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.addMessage({ role: "assistant", content: "partial" });
  sm.updateLastMessage({ content: "complete", done: true });
  expect(sm.messages[0]).toMatchObject({ role: "assistant", content: "complete", done: true });
  expect(notified).toBe(2); // addMessage + updateLastMessage
});

test("updateLastMessage is a no-op when messages is empty", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.updateLastMessage({ content: "orphan" });
  expect(sm.messages).toEqual([]);
  expect(notified).toBe(0);
});

test("setStreamingMessage stores and notifies on set/clear", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.setStreamingMessage({ role: "assistant", content: "..." });
  expect(sm.currentStreamingMessage).toMatchObject({ role: "assistant" });
  sm.clearStreamingMessage();
  expect(sm.currentStreamingMessage).toBe(null);
  expect(notified).toBe(2);
});

test("setStreaming toggles flag and notifies", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.setStreaming(true);
  expect(sm.isStreaming).toBe(true);
  sm.setStreaming(false);
  expect(sm.isStreaming).toBe(false);
  expect(notified).toBe(2);
});

test("removeListener stops further notifications", () => {
  const sm = new StateManager();
  const calls = [];
  const cb = () => calls.push(1);
  sm.addListener(cb);
  sm.addMessage({ content: "a" });
  sm.removeListener(cb);
  sm.addMessage({ content: "b" });
  expect(calls).toHaveLength(1);
});

test("addToolExecution stores with defaults overridden by provided data", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.addToolExecution("call-1", { toolName: "Read", args: { path: "/x" } });
  const exec = sm.getToolExecution("call-1");
  expect(exec).toMatchObject({
    toolCallId: "call-1",
    toolName: "Read",
    args: { path: "/x" },
    status: "pending",
    output: "",
    isError: false,
  });
  expect(notified).toBe(1);
});

test("addToolExecution lets caller override defaults like status and output", () => {
  const sm = new StateManager();
  sm.addToolExecution("call-2", {
    toolName: "Bash",
    args: {},
    status: "completed",
    output: "done",
    isError: true,
  });
  expect(sm.getToolExecution("call-2")).toMatchObject({
    status: "completed",
    output: "done",
    isError: true,
  });
});

test("updateToolExecution merges updates and notifies when tool exists", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.addToolExecution("call-3", { toolName: "Edit", args: {} });
  sm.updateToolExecution("call-3", { status: "completed", output: "edited" });
  expect(sm.getToolExecution("call-3")).toMatchObject({ status: "completed", output: "edited" });
  expect(notified).toBe(2);
});

test("updateToolExecution is a no-op for unknown toolCallId", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.updateToolExecution("nonexistent", { status: "completed" });
  expect(sm.getToolExecution("nonexistent")).toBeUndefined();
  expect(notified).toBe(0);
});

test("getToolExecution returns undefined for unknown id", () => {
  const sm = new StateManager();
  expect(sm.getToolExecution("missing")).toBeUndefined();
});

test("getAllToolExecutions returns insertion-ordered array", () => {
  const sm = new StateManager();
  sm.addToolExecution("a", { toolName: "A", args: {} });
  sm.addToolExecution("b", { toolName: "B", args: {} });
  const all = sm.getAllToolExecutions();
  expect(all.map((e) => e.toolCallId)).toEqual(["a", "b"]);
});

test("reset clears all state and notifies once", () => {
  const sm = new StateManager();
  let notified = 0;
  sm.addListener(() => notified++);
  sm.addMessage({ content: "x" });
  sm.addToolExecution("t", { toolName: "T", args: {} });
  sm.setStreaming(true);
  sm.setStreamingMessage({ content: "..." });
  sm.addTurnWrite("a.txt");
  sm.addTurnWrite("b.txt");

  sm.reset();

  expect(sm.messages).toEqual([]);
  expect(sm.toolExecutions.size).toBe(0);
  expect(sm.isStreaming).toBe(false);
  expect(sm.currentStreamingMessage).toBe(null);
  expect(sm.turnWrites).toEqual([]);
  // addMessage + addTool + setStreaming + setStreamingMessage + reset
  expect(notified).toBe(5);
});

test("addTurnWrite dedupes by filePath and appends to turnWrites", () => {
  const sm = new StateManager();
  sm.addTurnWrite("a.txt");
  sm.addTurnWrite("a.txt");
  sm.addTurnWrite("b.txt");
  expect(sm.turnWrites.map((e) => e.filePath)).toEqual(["a.txt", "b.txt"]);
});

test("addTurnWrite ignores empty and whitespace file paths", () => {
  const sm = new StateManager();
  sm.addTurnWrite("");
  sm.addTurnWrite("   ");
  expect(sm.turnWrites).toEqual([]);
});

test("settleTurnWrites returns copy and clears turnWrites", () => {
  const sm = new StateManager();
  sm.addTurnWrite("a.txt");
  sm.addTurnWrite("b.txt");
  const writes = sm.settleTurnWrites();
  expect(writes.map((e) => e.filePath)).toEqual(["a.txt", "b.txt"]);
  expect(sm.turnWrites).toEqual([]);
  // Returned array must not alias internal state.
  writes.push({ toolCallId: null, filePath: "leak.txt" });
  expect(sm.turnWrites).toEqual([]);
});

test("notifyListeners invokes every registered listener", () => {
  const sm = new StateManager();
  const seen = [];
  sm.addListener(() => seen.push("a"));
  sm.addListener(() => seen.push("b"));
  sm.notifyListeners();
  expect(seen).toEqual(["a", "b"]);
});
