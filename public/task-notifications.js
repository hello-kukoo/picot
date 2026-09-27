// ABOUTME: OS task-completion notifications driven by runtime frames.
// ABOUTME: Delivery goes through the host data plane; the enabled flag lives in the DB.

import { t as translate } from "./i18n.js";
import { extractRuntimeEventError } from "./task-debugger/assistant-error.js";

const DEFAULT_ENABLED = true;

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
 * @param {{
 *   sendData: (operation: string, params: object) => Promise<unknown>,
 * }} transport host data-plane transport (wsClient)
 * @param {() => boolean} isEnabled reads the DB-backed setting (cached by the
 *   caller; the toggle updates the cache on change)
 * @param {(key: string, params?: object) => string} t locale lookup
 */
export function createTaskNotifications(
  { sendData } = {},
  isEnabled = () => DEFAULT_ENABLED,
  { logger = console, t = translate } = {},
) {
  const runningTargets = new Set();

  async function showCompletion(target, error = null) {
    if (!sendData) return;
    const described = describeTarget(target);
    if (!described.workspaceId || !described.sessionId) {
      logger.warn("[Notifications] completion skipped: incomplete target", described);
      return;
    }
    try {
      await sendData("show_task_notification", {
        title: t(error ? "settings.taskFailedTitle" : "settings.taskCompleteTitle"),
        body: error || t("settings.taskCompleteMessage"),
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
    if (frame.event?.type === "agent_start") {
      runningTargets.add(key);
      return;
    }
    if (frame.event?.type !== "agent_settled" && frame.event?.type !== "agent_end") return;
    // Without a matching agent_start the pairing is unreliable (e.g. frames
    // from before this window loaded); skip instead of double-notifying.
    if (!runningTargets.delete(key)) return;
    if (!isEnabled()) return;
    const error = extractRuntimeEventError(frame.event);
    void showCompletion(frame.target, error);
  }

  return { handleRuntimeFrame };
}
