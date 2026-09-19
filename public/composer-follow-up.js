/**
 * Resolve what an Option/Alt+Enter (or split-menu) send should do.
 * - streaming + queueable → "follow_up" (pi queues it for the next run stop)
 * - idle → "direct" (user intent is delivery; a bare keypress has no
 *   disabled state to show, so it degrades instead of blocking)
 * - extension command → "direct" (rpc.md: extension commands execute
 *   immediately, even mid-run; follow_up cannot queue them)
 */
export function planFollowUpSend({ streaming, extensionCommand }) {
  if (!streaming || extensionCommand) return "direct";
  return "follow_up";
}

/**
 * Streaming-Enter intent (2026-09-19 steering spec): Enter while a run is
 * active sends real steering via `prompt + streamingBehavior:"steer"`;
 * extension commands execute immediately (bare prompt, protocol-sanctioned);
 * idle falls through to the plain prompt path.
 */
export function planSteeringSend({ streaming, extensionCommand }) {
  if (!streaming) return "direct";
  if (extensionCommand) return "prompt-now";
  return "steer";
}

/**
 * C5 decision (2026-09-19 manual review): the caret is a DIRECT delayed-send
 * button beside the primary send button — no dropdown menu, no floating
 * widget. planFollowUpSend stays the single intent resolver the keyboard
 * path (Option/Alt+Enter) and the caret click share.
 */
