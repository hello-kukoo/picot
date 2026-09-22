// ABOUTME: Verifies the per-session parking of ask_user_question state while backgrounded.
// ABOUTME: Proves queued walker requests survive until the session returns to the foreground.

import { describe, expect, it } from "vitest";
import { BackgroundQuestionnaireStore } from "./background-questionnaire-store.js";

const FILE = "/sessions/alpha.jsonl";
const RUNTIME = "ws\u0000session-1\u0000primary";
const QUESTIONS = [{ prompt: "Pick one", options: [{ label: "A" }, { label: "B" }] }];

function askStartEvent(toolCallId = "tool-1", questions = QUESTIONS) {
  return { toolCallId, toolName: "ask_user_question", args: { questions } };
}

describe("BackgroundQuestionnaireStore parking", () => {
  it("parks a background ask_user_question tool start with questions and toolCallId", () => {
    const store = new BackgroundQuestionnaireStore();
    expect(store.parkToolStart(FILE, RUNTIME, askStartEvent())).toBe(true);

    const entry = store.take(FILE, RUNTIME);
    expect(entry).not.toBeNull();
    expect(entry.questions).toEqual(QUESTIONS);
    expect(entry.toolCallId).toBe("tool-1");
    expect(entry.queuedRequests).toEqual([]);
  });

  it("ignores other tools and malformed ask events", () => {
    const store = new BackgroundQuestionnaireStore();
    expect(store.parkToolStart(FILE, RUNTIME, { toolCallId: "t", toolName: "bash" })).toBe(false);
    expect(store.parkToolStart(FILE, RUNTIME, askStartEvent("t2", []))).toBe(false);
    expect(store.take(FILE, RUNTIME)).toBeNull();
  });

  it("drops the parked entry when its tool_execution_end arrives", () => {
    const store = new BackgroundQuestionnaireStore();
    store.parkToolStart(FILE, RUNTIME, askStartEvent("tool-9"));

    store.handleToolEnd(FILE, RUNTIME, "other-tool");
    expect(store.take(FILE, RUNTIME)).not.toBeNull();

    store.handleToolEnd(FILE, RUNTIME, "tool-9");
    expect(store.take(FILE, RUNTIME)).toBeNull();
  });
});

describe("BackgroundQuestionnaireStore request queue", () => {
  it("queues blocking walker requests and reports them for the unread badge", () => {
    const store = new BackgroundQuestionnaireStore();
    const request = { id: "req-1", method: "select", title: "Pick one", options: ["1. A"] };

    expect(store.queueRequest(FILE, RUNTIME, request)).toBe(true);
    const entry = store.take(FILE, RUNTIME);
    expect(entry.queuedRequests).toEqual([request]);
    // No tool start was seen: questions stay null so replay falls back to dialogs.
    expect(entry.questions).toBeNull();
  });

  it("never queues ambient widget methods", () => {
    const store = new BackgroundQuestionnaireStore();
    for (const method of ["notify", "setWidget", "setStatus"]) {
      expect(store.queueRequest(FILE, RUNTIME, { id: "x", method })).toBe(false);
    }
    expect(store.take(FILE, RUNTIME)).toBeNull();
  });

  it("keeps queued requests when the active card is parked on top", () => {
    const store = new BackgroundQuestionnaireStore();
    store.parkToolStart(FILE, RUNTIME, askStartEvent());
    store.queueRequest(FILE, RUNTIME, { id: "req-1", method: "select" });

    const cardState = {
      questions: QUESTIONS,
      answers: [{ selected: 1, custom: "" }],
      toolCallId: "tool-1",
      cursor: 0,
      submitted: false,
      pendingRequest: null,
      pendingSentinel: false,
      cancelRequested: false,
    };
    store.parkActive(FILE, RUNTIME, cardState);

    const entry = store.take(FILE, RUNTIME);
    expect(entry.cardState).toBe(cardState);
    expect(entry.queuedRequests).toHaveLength(1);
  });

  it("ignores parking an empty card state", () => {
    const store = new BackgroundQuestionnaireStore();
    store.parkActive(FILE, RUNTIME, { questions: [], answers: [], cursor: 0 });
    expect(store.take(FILE, RUNTIME)).toBeNull();
  });
});

describe("BackgroundQuestionnaireStore take", () => {
  it("matches by runtime id when the session file is unknown", () => {
    const store = new BackgroundQuestionnaireStore();
    store.parkToolStart(null, RUNTIME, askStartEvent());

    expect(store.take(FILE, RUNTIME)).not.toBeNull();
    expect(store.take(FILE, RUNTIME)).toBeNull();
  });

  it("does not hand another session's entry to an unrelated runtime", () => {
    const store = new BackgroundQuestionnaireStore();
    store.parkToolStart("/sessions/beta.jsonl", "ws\u0000session-2\u0000primary", askStartEvent());

    expect(store.take(FILE, RUNTIME)).toBeNull();
    expect(store.take("/sessions/beta.jsonl", "ws\u0000session-2\u0000primary")).not.toBeNull();
  });
});
