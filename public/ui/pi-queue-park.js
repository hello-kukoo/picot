// ABOUTME: Parks pi's reported steer/followUp queue per session file while that session is backgrounded.
// ABOUTME: pi only emits queue_update on mutation, so a switch-back has no other way to repaint the pills.

/**
 * Per-session parking lot for the queue pi reports through `queue_update`.
 *
 * Runtimes outlive session switches (see ARCHITECTURE: "runtimes survive
 * session switches"), so a queued steer/followUp is still live in pi when the
 * user returns — but pi re-emits `queue_update` only when the queue mutates
 * (push, dequeue on message_start, clear), and `get_state` exposes just
 * `pendingMessageCount`. Nothing on the wire can rebuild the pill text after a
 * switch, so the last report is parked here and repainted on return.
 *
 * The park is keyed by the session file, i.e. the same key space as the
 * composer identity, and is deliberately in-memory only: it mirrors pi's live
 * queue, it is not a second queue of record.
 */
export function createPiQueuePark() {
  const entries = new Map();

  return {
    /** Record the queue pi last reported for a session. Returns false when unresolved. */
    set(sessionFile, queue) {
      if (!sessionFile) return false;
      entries.set(sessionFile, queue);
      return true;
    },
    /** The session's last reported queue, or null when nothing was reported. */
    get(sessionFile) {
      if (!sessionFile) return null;
      return entries.get(sessionFile) ?? null;
    },
    /** Drop a session's entry: its runtime is gone, so its queue is gone too. */
    forget(sessionFile) {
      if (sessionFile) entries.delete(sessionFile);
    },
  };
}
