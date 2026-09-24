// ABOUTME: Finds a session log's unanswered ask_user_question call.
// ABOUTME: Rebuilds the questionnaire card on return when no in-memory park survives.

import { parseArgs } from "./questionnaire-card.js";

const TOOL_NAME = "ask_user_question";

/**
 * The questionnaire a session is still waiting on, derived from the log alone:
 * the newest `ask_user_question` tool call that has no tool result yet.
 *
 * This is the durable counterpart to the in-memory park — it survives a page
 * reload, a cross-workspace return, and any ordering in which the blocking
 * `extension_ui_request` never reached this page. It deliberately reads only
 * facts the session file already holds: a call whose result exists answered
 * already (or errored), and a call with no questions to show is ignored.
 *
 * Returns `{ toolCallId, questions }`, or null when nothing is unanswered
 * within `fromIndex..` (the caller passes the newest turn's start).
 */
export function findPendingQuestionnaire(messages, toolResults, fromIndex = 0) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= Math.max(0, fromIndex); i -= 1) {
    const content = messages[i]?.content;
    if (messages[i]?.role !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall" || block.name !== TOOL_NAME) continue;
      if (toolResults?.has?.(block.id)) continue;
      const questions = parseArgs(block.arguments).questions;
      if (!Array.isArray(questions) || questions.length === 0) continue;
      return { toolCallId: typeof block.id === "string" ? block.id : null, questions };
    }
  }
  return null;
}
