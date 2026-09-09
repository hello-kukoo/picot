// ABOUTME: Verifies assembly of Pi delta-only assistant message events.
// ABOUTME: The accumulator must work without cumulative message snapshots.

import { describe, expect, test } from "vitest";
import { createAssistantMessageStream } from "./assistant-message-stream.js";

describe("assistant message stream", () => {
  test("assembles text and thinking deltas without an event.message snapshot", () => {
    const stream = createAssistantMessageStream();

    expect(
      stream.update({
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking" },
      }),
    ).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Checking" }],
    });
    expect(
      stream.update({
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello" },
      }),
    ).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Checking" },
        { type: "text", text: "Hello" },
      ],
    });
  });

  test("uses the message_end snapshot as the final message", () => {
    const stream = createAssistantMessageStream();
    stream.update({
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    });
    const finalMessage = { role: "assistant", content: [{ type: "text", text: "final" }] };

    expect(stream.finish(finalMessage)).toEqual(finalMessage);
  });
});
