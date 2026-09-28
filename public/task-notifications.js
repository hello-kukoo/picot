// ABOUTME: OS task-completion notifications driven by runtime frames.
// ABOUTME: Delivery goes through the host data plane; the enabled flag lives in the DB.

import { t as translate } from "./i18n.js";
import { messageText } from "./session-tree.js";
import { extractRuntimeEventError } from "./task-debugger/assistant-error.js";

const DEFAULT_ENABLED = true;
// Same preview budget as paseo's agent-attention notifications: long enough
// for a meaningful reply excerpt, short enough for every OS notification UI.
const PREVIEW_LIMIT = 220;

function describeTarget(target = {}) {
  return {
    instanceId: target.instanceId ?? null,
    workspaceId: target.workspaceId ?? null,
    sessionId: target.sessionId ?? null,
  };
}

function targetKey(target = {}) {
  return target.instanceId || target.sessionId || null;
}

/**
 * Markdown-to-plain-text for notification previews (ported from paseo's
 * agent-attention-notification): fences keep their content, links collapse to
 * labels, structural and inline markers drop out, whitespace normalizes to
 * single spaces, then the result truncates with an ellipsis.
 */
function stripMarkdownToText(markdown) {
  let text = String(markdown ?? "").replace(/\r\n/g, "\n");
  text = text.replace(/^\s*(```|~~~)[^\n]*$/gm, "");
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[*+-]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}([-*_]\s*){3,}$/gm, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/<([^>\n]+)>/g, "$1");
  return text;
}

function buildPreview(markdown) {
  const normalized = stripMarkdownToText(markdown).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= PREVIEW_LIMIT) return normalized;
  const trimmed = normalized.slice(0, PREVIEW_LIMIT - 3).trimEnd();
  return trimmed ? `${trimmed}...` : normalized.slice(0, PREVIEW_LIMIT);
}

/**
 * @param {{ sendData: (operation: string, params: object) => Promise<unknown> }} transport
 * host data-plane transport (wsClient). Kept as an object — destructuring the
 * method would detach it from its `this` (sendData reads this._sendRequest).
 * @param {() => boolean} isEnabled reads the DB-backed setting (cached by the
 *   caller; the toggle updates the cache on change)
 * @param {(key: string, params?: object) => string} t locale lookup
 */
export function createTaskNotifications(
  transport = {},
  isEnabled = () => DEFAULT_ENABLED,
  { logger = console, t = translate } = {},
) {
  const runningTargets = new Set();
  const lastAssistantText = new Map();

  function rememberAssistantMessage(key, event) {
    const message = event.message;
    if (message?.role !== "assistant") return;
    const text = messageText(message.content);
    if (text) lastAssistantText.set(key, text);
  }

  async function showCompletion(target, error = null) {
    // Method call on the transport object — a detached (destructured) sendData
    // loses its `this` (it reads this._sendRequest) and throws a TypeError.
    if (typeof transport.sendData !== "function") return;
    const described = describeTarget(target);
    if (!described.workspaceId || !described.sessionId) {
      logger.warn("[Notifications] completion skipped: incomplete target", described);
      return;
    }
    const key = targetKey(target);
    // The last assistant reply is the best one-line summary of what finished
    // (paseo's contract); failures keep the error as the body instead.
    const preview = !error && key ? buildPreview(lastAssistantText.get(key)) : null;
    // Consume the reply: the turn is over, and a runtime that never runs again
    // must not keep its last (possibly long) reply pinned in this Map forever.
    if (key) lastAssistantText.delete(key);
    try {
      await transport.sendData("show_task_notification", {
        title: t(error ? "settings.taskFailedTitle" : "settings.taskCompleteTitle"),
        body: error || preview || t("settings.taskCompleteMessage"),
        workspaceId: described.workspaceId,
        sessionId: described.sessionId,
      });
    } catch (sendError) {
      // A denied OS permission or missing notification center surfaces here;
      // the in-app experience must not change because a toast failed.
      logger.warn("[Notifications] failed to show:", sendError);
    }
  }

  function handleRuntimeFrame(frame) {
    if (!frame?.event) return;
    const key = targetKey(frame.target);
    if (!key) return;
    if (frame.event.type === "agent_start") {
      runningTargets.add(key);
      // A fresh turn's completion must never preview the previous turn's
      // reply; message_end repopulates it as the turn streams.
      lastAssistantText.delete(key);
      return;
    }
    if (frame.event.type === "message_end") {
      rememberAssistantMessage(key, frame.event);
      return;
    }
    if (frame.event.type !== "agent_settled" && frame.event.type !== "agent_end") return;
    // Without a matching agent_start the pairing is unreliable (e.g. frames
    // from before this window loaded); skip instead of double-notifying.
    if (!runningTargets.delete(key)) return;
    if (!isEnabled()) return;
    const error = extractRuntimeEventError(frame.event);
    void showCompletion(frame.target, error);
  }

  return { handleRuntimeFrame };
}
