// ABOUTME: Rebuilds turn traces from a saved session log (JSONL entries), so the
// ABOUTME: debugger can analyse tasks this window never watched stream live.

import { clampText, describeToolArgs, toolSignature } from "./turn-trace.js";

/**
 * History rebuild.
 *
 * `turn-trace.js` can only time what this window watched: reopen a session, or
 * restart the app, and every earlier task is invisible. The saved session log
 * carries enough to reconstruct those spans after the fact:
 *
 *   entry.timestamp   ISO stamp written when the entry was appended -> span END
 *   message.timestamp epoch ms stamped when the message began       -> span START
 *
 * So an assistant message gives the model span directly, and a tool span runs
 * from the assistant entry that requested it to the `toolResult` entry that
 * answered it. Nothing here is estimated or averaged: every stamp is one the
 * log actually recorded. What the log cannot show, it does not claim -- a tool
 * call whose result never landed stays `unfinished`, exactly as a live trace
 * would report it, and compaction (which leaves no entry of its own) is absent
 * rather than guessed at.
 *
 * Output is the same turn/step shape `turn-trace.js` produces, so
 * `turn-analysis.js` reads both without knowing which is which. `source` marks
 * the origin for the UI.
 */

const DEFAULT_MAX_TURNS = 20;
const MAX_STEPS_PER_TURN = 500;
const DETAIL_MAX_CHARS = 140;
const PROMPT_MAX_CHARS = 400;

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function trimmedString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.message === "string") {
    return value.message.trim();
  }
  return "";
}

function toolCallBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block?.type === "toolCall" || block?.type === "tool_use");
}

function toolCallName(block) {
  return String(block?.name || block?.toolName || "tool");
}

function toolCallArgs(block) {
  return block?.arguments ?? block?.args ?? block?.input ?? null;
}

/** Epoch ms from either an ISO string or a numeric stamp; null when unusable. */
function toEpochMs(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Order the entries along the active branch (leaf -> root, reversed). Forked
 * sessions keep abandoned branches in the same file, and analysing a branch the
 * user walked away from would report work that is not in their transcript.
 * Without a resolvable leaf the file order is the best available answer.
 */
export function activeChain(entries, leafId) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.id) : [];
  if (!leafId) return list;
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  if (!current) return list;
  const chain = [];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  chain.reverse();
  return chain;
}

/**
 * One log entry -> {role, startedAt, endedAt, message}, or null when unusable.
 *
 * `custom_message` entries are prompts too: an extension or a mode transition
 * feeding the model text. They start a turn exactly as a typed message does,
 * and treating them as anything else would glue two unrelated tasks -- days
 * apart, in a resumed session -- into one span.
 */
function normalizeEntry(entry) {
  if (entry?.type === "custom_message") {
    const at = toEpochMs(entry.timestamp);
    if (at == null) return null;
    return {
      role: "prompt",
      message: { content: entry.content, customType: entry.customType ?? null },
      startedAt: at,
      endedAt: at,
    };
  }
  if (entry?.type !== "message") return null;
  const message = entry.message;
  const role = message?.role;
  if (!role) return null;
  const endedAt = toEpochMs(entry.timestamp) ?? toEpochMs(message.timestamp);
  const startedAt = toEpochMs(message.timestamp) ?? endedAt;
  if (startedAt == null || endedAt == null) return null;
  return { role, message, startedAt, endedAt: Math.max(startedAt, endedAt) };
}

function newTurn(index, startedAt, prompt, target) {
  return {
    id: `history-${index}`,
    index,
    source: "history",
    sessionId: target?.sessionId ?? null,
    workspaceId: target?.workspaceId ?? null,
    instanceId: target?.instanceId ?? null,
    prompt,
    startedAt,
    endedAt: null,
    durationMs: null,
    status: "running",
    error: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    steps: [],
  };
}

function pushStep(turn, step) {
  if (!turn || turn.steps.length >= MAX_STEPS_PER_TURN) return null;
  turn.steps.push(step);
  return step;
}

function closeTurn(turn) {
  if (turn?.status !== "running") return;
  const endedAt = turn.steps.reduce(
    (latest, step) => Math.max(latest, step.endedAt ?? step.startedAt),
    turn.startedAt,
  );
  for (const step of turn.steps) {
    // A tool call whose result never reached the log is the same signal a live
    // trace reports: the step did not finish, and the turn stops there.
    if (step.endedAt != null) continue;
    step.endedAt = endedAt;
    step.durationMs = Math.max(0, endedAt - step.startedAt);
    step.status = "unfinished";
  }
  // Only a failed model response fails the turn, matching what the live
  // recorder takes from the runtime: a failed tool call is reported as such,
  // but the agent usually reads the error and carries on.
  const failed = turn.steps.find((step) => step.kind === "model" && step.status === "error");
  const aborted = turn.steps.some((step) => step.stopReason === "aborted");
  const unfinished = turn.steps.some((step) => step.status === "unfinished");
  turn.endedAt = endedAt;
  turn.durationMs = Math.max(0, endedAt - turn.startedAt);
  turn.status = failed ? "failed" : aborted ? "aborted" : unfinished ? "unknown" : "completed";
  turn.error = failed?.error ?? null;
}

function addUsage(totals, usage) {
  totals.input += Number(usage?.input) || 0;
  totals.output += Number(usage?.output) || 0;
  totals.cacheRead += Number(usage?.cacheRead) || 0;
  totals.cacheWrite += Number(usage?.cacheWrite) || 0;
  totals.cost += Number(usage?.cost?.total) || 0;
}

/**
 * Rebuild turn traces from saved session log entries.
 *
 * @param {Array<object>} entries verbatim JSONL entries (`get_entries` / `read_session_tree`)
 * @param {{ leafId?: string|null, target?: object, maxTurns?: number }} [options]
 * @returns {Array<object>} turns in `turn-trace.js` shape, oldest first
 */
export function buildTurnsFromEntries(
  entries,
  { leafId = null, target = null, maxTurns = DEFAULT_MAX_TURNS } = {},
) {
  const messages = activeChain(entries, leafId)
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => a.startedAt - b.startedAt);

  const turns = [];
  /** @type {Map<string, object>} tool calls awaiting their result entry */
  let pending = new Map();
  let turn = null;
  let index = 0;

  const finish = () => {
    if (!turn) return;
    closeTurn(turn);
    turn = null;
    pending = new Map();
  };

  for (const entry of messages) {
    const { role, message, startedAt, endedAt } = entry;
    if (role === "user" || role === "prompt") {
      // Back-to-back prompts (an extension's context line, then the message it
      // precedes) describe one task, not two: an open turn that did no work
      // yet is that same task still waiting to start.
      if (turn && turn.steps.length === 0) {
        turns.pop();
        index -= 1;
        turn = null;
      }
      finish();
      index += 1;
      turn = newTurn(
        index,
        startedAt,
        clampText(textFromContent(message.content), PROMPT_MAX_CHARS),
        target,
      );
      turns.push(turn);
      continue;
    }
    if (role === "assistant") {
      if (!turn) {
        // A branch that opens on assistant output (a fork, a resumed session):
        // keep the work rather than dropping it for want of a prompt entry.
        index += 1;
        turn = newTurn(index, startedAt, "", target);
        turns.push(turn);
      }
      addUsage(turn.usage, message.usage);
      const stopReason = message.stopReason ?? null;
      const error =
        stopReason === "error"
          ? trimmedString(message.errorMessage) ||
            trimmedString(message.error) ||
            "model request failed"
          : null;
      pushStep(turn, {
        kind: "model",
        label: "assistant",
        detail: clampText(textFromContent(message.content), DETAIL_MAX_CHARS),
        toolNames: toolCallBlocks(message).map(toolCallName),
        signature: null,
        toolCallId: null,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        status: error ? "error" : stopReason === "aborted" ? "aborted" : "ok",
        error,
        stopReason,
      });
      for (const block of toolCallBlocks(message)) {
        const toolName = toolCallName(block);
        const args = toolCallArgs(block);
        // The tool cannot have started before the message that requested it
        // finished, which is exactly the assistant entry's write stamp.
        const step = pushStep(turn, {
          kind: "tool",
          label: toolName,
          detail: describeToolArgs(args),
          signature: toolSignature(toolName, args),
          toolCallId: block?.id ?? null,
          startedAt: endedAt,
          endedAt: null,
          durationMs: null,
          status: "running",
          error: null,
          stopReason: null,
        });
        if (step?.toolCallId) pending.set(step.toolCallId, step);
      }
      continue;
    }
    if (role === "toolResult" || role === "tool_result") {
      if (!turn) continue;
      const id = message.toolCallId ?? message.tool_call_id ?? null;
      const step =
        (id != null && pending.get(id)) ||
        [...turn.steps]
          .reverse()
          .find((candidate) => candidate.kind === "tool" && candidate.endedAt == null);
      if (!step) continue;
      if (id != null) pending.delete(id);
      const at = Math.max(step.startedAt, endedAt);
      step.endedAt = at;
      step.durationMs = at - step.startedAt;
      step.status = message.isError ? "error" : "ok";
      step.error = message.isError
        ? clampText(textFromContent(message.content), DETAIL_MAX_CHARS) || "tool call failed"
        : null;
    }
  }
  finish();

  // Same window as the live recorder: the most recent turns, oldest first.
  return turns.slice(-maxTurns);
}

/**
 * Live spans plus history spans, with live winning wherever the two overlap.
 *
 * The live recorder only ever covers a suffix of the session -- everything
 * since this window attached -- and it saw those turns first-hand, including
 * compaction and spans the log never records. So history is kept only up to
 * the point live coverage begins; past that the two would double-count the
 * same work.
 *
 * @param {Array<object>} historyTurns - turns rebuilt from the saved log.
 * @param {Array<object>} liveTurns - turns the recorder watched live.
 * @returns {Array<object>} chronological turns.
 */
export function mergeTurnSources(historyTurns, liveTurns) {
  const live = (liveTurns ?? []).filter(Boolean);
  const history = (historyTurns ?? []).filter(Boolean);
  if (!live.length) return history;
  if (!history.length) return live;
  const liveFrom = live.reduce(
    (earliest, turn) => Math.min(earliest, Number(turn.startedAt) || Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  const older = history.filter((turn) => (turn.endedAt ?? turn.startedAt) < liveFrom);
  return [...older, ...live];
}
