// ABOUTME: Locks the log-derived pending-questionnaire lookup used to rebuild
// ABOUTME: the card after a reload or cross-workspace return, with no park.
import { describe, expect, test } from "vitest";
import { findPendingQuestionnaire } from "./pending-questionnaire.js";

const toolCall = (id, name, argumentsValue) => ({
  type: "toolCall",
  id,
  name,
  arguments: argumentsValue,
});
const assistant = (...content) => ({ role: "assistant", content });
const toolResult = (toolCallId) => ({ role: "toolResult", toolCallId, content: [] });

describe("findPendingQuestionnaire", () => {
  test("finds the unanswered ask_user_question in the newest turn", () => {
    const questions = [{ question: "Which database?", options: ["Postgres", "SQLite"] }];
    const messages = [
      { role: "user", content: "prompt" },
      assistant(toolCall("call-1", "ask_user_question", { questions })),
    ];
    expect(findPendingQuestionnaire(messages, new Map(), 0)).toEqual({
      toolCallId: "call-1",
      questions,
    });
  });

  test("a call with a tool result is answered, not pending", () => {
    const messages = [
      { role: "user", content: "prompt" },
      assistant(toolCall("call-1", "ask_user_question", { questions: [{ question: "q" }] })),
      toolResult("call-1"),
    ];
    expect(
      findPendingQuestionnaire(messages, new Map([["call-1", toolResult("call-1")]]), 0),
    ).toBeNull();
  });

  test("only the newest turn counts: an older unanswered call is history", () => {
    const messages = [
      { role: "user", content: "older" },
      assistant(toolCall("call-old", "ask_user_question", { questions: [{ question: "old q" }] })),
      { role: "user", content: "newer" },
      assistant({ type: "thinking", thinking: "no question here" }),
    ];
    // The newest turn starts at index 2, so the older call is out of scope.
    expect(findPendingQuestionnaire(messages, new Map(), 2)).toBeNull();
    expect(findPendingQuestionnaire(messages, new Map(), 0)).toEqual({
      toolCallId: "call-old",
      questions: [{ question: "old q" }],
    });
  });

  test("tool arguments may arrive as a JSON string", () => {
    const messages = [
      assistant(
        toolCall(
          "call-2",
          "ask_user_question",
          JSON.stringify({ questions: [{ question: "from string" }] }),
        ),
      ),
    ];
    expect(findPendingQuestionnaire(messages, new Map(), 0)).toEqual({
      toolCallId: "call-2",
      questions: [{ question: "from string" }],
    });
  });

  test("calls without questions to show, other tools, and malformed input are ignored", () => {
    const messages = [
      assistant(toolCall("call-3", "read", { path: "/tmp/a" })),
      assistant(toolCall("call-4", "ask_user_question", { questions: [] })),
      assistant(toolCall("call-5", "ask_user_question", "not json")),
    ];
    expect(findPendingQuestionnaire(messages, new Map(), 0)).toBeNull();
    expect(findPendingQuestionnaire(null, new Map(), 0)).toBeNull();
    expect(findPendingQuestionnaire([], new Map(), 0)).toBeNull();
  });
});
