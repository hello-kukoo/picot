import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import {
  assistantHasText,
  classifyTurnSegments,
  formatTurnDuration,
  HISTORY_FULL_MOUNT_TURNS,
  HISTORY_REVEAL_BATCH_TURNS,
  resolveTurnDurationMs,
  segmentOfMessage,
  splitFinalAssistantBlocks,
  summarizeTurnRail,
} from "./turn-model.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/en.json")) {
      return { ok: true, status: 200, json: async () => enMessages };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

const seg = (hasText, hasToolCall) => ({ hasText, hasToolCall });
const classify = (...segments) => classifyTurnSegments(segments);

describe("classifyTurnSegments (spec matrix)", () => {
  test("text-only turn: the text is the answer", () => {
    expect(classify(seg(true, false))).toEqual({
      railSegments: [],
      answerSegment: 0,
      answerHasProcessPrefix: false,
    });
  });

  test("tool-only turn: no answer, everything rails", () => {
    expect(classify(seg(false, true))).toEqual({
      railSegments: [0],
      answerSegment: -1,
      answerHasProcessPrefix: false,
    });
  });

  test("text-tool-text: first text rails, final text answers", () => {
    expect(classify(seg(true, false), seg(false, true), seg(true, false))).toEqual({
      railSegments: [0, 1],
      answerSegment: 2,
      answerHasProcessPrefix: false,
    });
  });

  test("tool-text: text after a tool is the answer", () => {
    expect(classify(seg(false, true), seg(true, false))).toEqual({
      railSegments: [0],
      answerSegment: 1,
      answerHasProcessPrefix: false,
    });
  });

  test("text-tool (run ended after the tool): answer stays the last text", () => {
    // Mirrors renderSessionHistory: finalAssistantIdx is the LAST assistant
    // message with text even when a tool-only message follows it.
    expect(classify(seg(true, false), seg(false, true))).toEqual({
      railSegments: [1],
      answerSegment: 0,
      answerHasProcessPrefix: false,
    });
  });

  test("a segment carrying both text and tool call flags the prefix demotion", () => {
    expect(classify(seg(true, true))).toEqual({
      railSegments: [],
      answerSegment: 0,
      answerHasProcessPrefix: true,
    });
  });

  test("empty and null inputs", () => {
    expect(classify()).toEqual({
      railSegments: [],
      answerSegment: -1,
      answerHasProcessPrefix: false,
    });
    expect(classifyTurnSegments(null)).toEqual({
      railSegments: [],
      answerSegment: -1,
      answerHasProcessPrefix: false,
    });
  });
});

describe("equivalence with history rendering (splitFinalAssistantBlocks)", () => {
  // The same finalized blocks must classify identically through the history
  // algorithm (finalAssistantIdx + splitFinalAssistantBlocks) and the live
  // segment classifier. This is the test that keeps live and history honest.
  const blocksOf = (content) =>
    Array.isArray(content) ? content : [{ type: "text", text: content }];

  const historyClassify = (messages) => {
    // Verbatim reproduction of renderSessionHistory's turn loop decision.
    const assistantIdx = messages
      .map((m, i) => (m?.role === "assistant" ? i : -1))
      .filter((i) => i >= 0);
    let finalAssistantIdx = -1;
    for (let i = assistantIdx.length - 1; i >= 0; i -= 1) {
      if (assistantHasText(messages[assistantIdx[i]].content)) {
        finalAssistantIdx = assistantIdx[i];
        break;
      }
    }
    if (finalAssistantIdx === -1) {
      return { answer: null, rail: messages.map((_, i) => i) };
    }
    const { processBlocks } = splitFinalAssistantBlocks(messages[finalAssistantIdx].content);
    return {
      answer: { index: finalAssistantIdx, hasProcess: processBlocks.length > 0 },
      rail: messages.map((_, i) => i).filter((i) => i !== finalAssistantIdx),
    };
  };

  const liveClassify = (messages) => {
    const segments = messages
      .filter((m) => m?.role === "assistant")
      .map((m) => segmentOfMessage(m));
    const { railSegments, answerSegment, answerHasProcessPrefix } = classifyTurnSegments(segments);
    return {
      answer:
        answerSegment >= 0 ? { index: answerSegment, hasProcess: answerHasProcessPrefix } : null,
      rail: railSegments,
    };
  };

  const cases = [
    [{ role: "assistant", content: blocksOf("answer") }],
    [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] }],
    [
      { role: "assistant", content: blocksOf("thinking out loud") },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] },
      { role: "assistant", content: blocksOf("final answer") },
    ],
    [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] },
      { role: "assistant", content: blocksOf("final answer") },
    ],
    [
      { role: "assistant", content: blocksOf("answer before a tool") },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] },
    ],
    [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "intermediate" },
          { type: "toolCall", id: "t1", name: "bash" },
          { type: "text", text: "trailing answer" },
        ],
      },
    ],
  ];

  test.each(
    cases.map((messages, i) => [i, messages]),
  )("case %i: live classification equals history classification", (_i, messages) => {
    expect(liveClassify(messages)).toEqual(historyClassify(messages));
  });
});

describe("resolveTurnDurationMs / formatTurnDuration", () => {
  test("duration from client timestamps", () => {
    expect(resolveTurnDurationMs({ startedAt: 1000, completedAt: 13000 })).toBe(12000);
  });

  test("null for unresolvable inputs", () => {
    expect(resolveTurnDurationMs({})).toBeNull();
    expect(resolveTurnDurationMs({ startedAt: 5000, completedAt: 1000 })).toBeNull();
    expect(resolveTurnDurationMs(null)).toBeNull();
  });

  test("formats seconds and minutes", () => {
    expect(formatTurnDuration(0)).toBe("0s");
    expect(formatTurnDuration(11999)).toBe("12s");
    expect(formatTurnDuration(64000)).toBe("1m 04s");
    expect(formatTurnDuration(75400)).toBe("1m 15s");
  });
  test("normalizes durations past an hour", () => {
    expect(formatTurnDuration(3600000)).toBe("1h 00m 00s");
    expect(formatTurnDuration(3661000)).toBe("1h 01m 01s");
    // 59m 59.6s rounds up into the next hour instead of rendering "60m 00s".
    expect(formatTurnDuration(3599600)).toBe("1h 00m 00s");
  });

  test("empty string for invalid input", () => {
    expect(formatTurnDuration(null)).toBe("");
    expect(formatTurnDuration(-5)).toBe("");
    expect(formatTurnDuration(Number.NaN)).toBe("");
  });
});

describe("shared constants and labels", () => {
  test("history fold constants (P2 contract lives here)", () => {
    expect(HISTORY_FULL_MOUNT_TURNS).toBe(2);
    expect(HISTORY_REVEAL_BATCH_TURNS).toBe(2);
  });

  test("summarizeTurnRail delegates to the process-group summary", () => {
    expect(summarizeTurnRail(3, 2)).toContain("3");
    expect(summarizeTurnRail(3, 2)).toContain("2");
  });
});
