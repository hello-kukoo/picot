// ABOUTME: Pure turn classification and labelling shared by the live stream and
// ABOUTME: history rendering (spec P1). No DOM, fully unit-testable.
import { summarizeProcessGroup } from "./process-group.js";

/** P2 history-fold constants live here: the mount gate and reveal batch size. */
export const HISTORY_FULL_MOUNT_TURNS = 2;
export const HISTORY_REVEAL_BATCH_TURNS = 2;

/**
 * True when an assistant message carries any non-empty text block.
 * Shared by history turn-splitting and the live segment classifier so the
 * two paths cannot drift (this was app.js's private helper).
 */
export function assistantHasText(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "text" && String(b.text ?? "").trim().length > 0);
}

/**
 * Split the final assistant message of a turn into the steps that should be
 * folded away (everything up to and including the last non-text block —
 * thinking/tool-calls) and the final answer (trailing text blocks).
 * Moved verbatim from app.js; the turn-model equivalence test pins it.
 */
export function splitFinalAssistantBlocks(content) {
  if (!Array.isArray(content)) return { processBlocks: [], answerBlocks: [] };
  let lastNonTextIdx = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "text") lastNonTextIdx = i;
  }
  return {
    processBlocks: content.slice(0, lastNonTextIdx + 1),
    answerBlocks: content.slice(lastNonTextIdx + 1),
  };
}

/** Segment summary for one assistant message, in arrival order. */
export function segmentOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return {
    hasText: assistantHasText(message?.content),
    hasToolCall: content.some((b) => b?.type === "toolCall"),
  };
}

/**
 * Classify a turn's assistant segments into rail content and the final answer
 * (spec P1.1). `assistantSegments` is `[{ hasText, hasToolCall }]` in arrival
 * order. The answer is the LAST segment carrying text — the same rule
 * `renderSessionHistory` uses to pick `finalAssistantIdx` — and when that
 * segment also carries a tool call, only its trailing text is the answer
 * (`splitFinalAssistantBlocks` semantics inside the message); the flag
 * `answerHasProcessPrefix` expresses that prefix demotion. Every other
 * segment is a rail segment.
 */
export function classifyTurnSegments(assistantSegments) {
  const segments = Array.isArray(assistantSegments) ? assistantSegments : [];
  let answerSegment = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i]?.hasText) {
      answerSegment = i;
      break;
    }
  }
  const railSegments = segments.map((_, i) => i).filter((i) => i !== answerSegment);
  return {
    railSegments,
    answerSegment,
    answerHasProcessPrefix: answerSegment >= 0 && Boolean(segments[answerSegment]?.hasToolCall),
  };
}

/** Turn duration in ms from client-clock timestamps; null when unresolvable. */
export function resolveTurnDurationMs(input = null) {
  const { startedAt, completedAt } = input ?? {};
  const start = Number(startedAt);
  const end = Number(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** "12s" under a minute, "1m 04s" under an hour, else "1h 02m 03s". Invalid input renders "". */
export function formatTurnDuration(ms) {
  if (ms == null) return "";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  // Round to whole seconds before splitting into units. Splitting first and
  // rounding the remainder carries 59.6s to "60s", which leaves durations like
  // "1m 60s" one second short of the next minute.
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${String(restMinutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

/** Rail label: delegates to the shared process-group summary (spec P1.1). */
export function summarizeTurnRail(stepCount, toolCallCount) {
  return summarizeProcessGroup(stepCount, toolCallCount);
}
