// ABOUTME: Per-session transcript view cache enabling no-op session switch-back.
// ABOUTME: Phase A of the session-resident-views spec: entries + view state only.

/** Retained sessions (LRU); Paseo keeps 3, Picot keeps a small margin. */
export const SESSION_VIEW_CACHE_LIMIT = 5;

/**
 * A cached view is valid when its entries are known current: either the
 * event stream has been appending into it (`trusted`), or the sidebar row's
 * file stamp (mtime + size) still matches the stamp captured at render.
 */
export function viewMatchesStamp(view, stamp) {
  if (!view) return false;
  if (view.trusted) return true;
  const cached = view.stamp;
  if (!cached || !stamp) return false;
  if (typeof cached.mtimeMs !== "number" || typeof stamp.mtimeMs !== "number") return false;
  if (cached.mtimeMs !== stamp.mtimeMs) return false;
  if (
    typeof cached.sizeBytes === "number" &&
    typeof stamp.sizeBytes === "number" &&
    cached.sizeBytes !== stamp.sizeBytes
  ) {
    return false;
  }
  return true;
}

export function createSessionViewCache(limit = SESSION_VIEW_CACHE_LIMIT) {
  const views = new Map();

  function touch(sessionFile) {
    const view = views.get(sessionFile);
    if (!view) return null;
    views.delete(sessionFile);
    views.set(sessionFile, view);
    return view;
  }

  return {
    get(sessionFile) {
      if (typeof sessionFile !== "string" || !sessionFile) return null;
      return touch(sessionFile);
    },

    /** Store a freshly rendered view; replaces any previous entry. */
    put(sessionFile, view) {
      if (typeof sessionFile !== "string" || !sessionFile || !view) return;
      views.delete(sessionFile);
      views.set(sessionFile, view);
      while (views.size > limit) {
        const oldest = views.keys().next().value;
        views.delete(oldest);
      }
    },

    /** Update the user's live view state on switch-away (no re-render). */
    captureLeave(sessionFile, { scrollTop, revealedCount, stamp } = {}) {
      const view = touch(sessionFile);
      if (!view) return;
      if (typeof scrollTop === "number") view.scrollTop = scrollTop;
      if (typeof revealedCount === "number") view.revealedCount = revealedCount;
      if (stamp) view.stamp = stamp;
    },

    /**
     * Append (or replace by entry id) a background session's settled
     * message. The view's entries are then current through the event
     * stream, so validation no longer depends on the file stamp.
     */
    appendMessage(sessionFile, message, entryId = null) {
      const view = touch(sessionFile);
      if (!view || !message) return false;
      const id =
        (typeof entryId === "string" && entryId) ||
        (typeof message?.id === "string" && message.id) ||
        null;
      const entry = { id, parentId: null, type: "message", message };
      if (id) {
        const index = view.entries.findIndex((existing) => existing?.id === id);
        if (index >= 0) {
          view.entries[index] = entry;
          view.trusted = true;
          return true;
        }
      }
      view.entries.push(entry);
      view.trusted = true;
      return true;
    },

    /** Drop one session's cache (leaf changed, compaction rewrote the file). */
    invalidate(sessionFile) {
      views.delete(sessionFile);
    },

    clear() {
      views.clear();
    },

    get size() {
      return views.size;
    },
  };
}
