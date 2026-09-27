// ABOUTME: Picot-owned follow-up queue, persisted per session file in localStorage.
// ABOUTME: Pi's queue protocol is all-or-nothing (clear_queue), so per-item edit/delete
// needs a client-side truth; see docs/superpowers/specs/2026-09-26-local-follow-up-queue-design.md.

const KEY_PREFIX = "pi-studio:followup-queue:";
// localStorage is shared by every session of one origin; one huge paste must not
// evict the rest of the app's storage. Oversized items stay in memory only.
const DEFAULT_MAX_PERSISTED_TEXT_CHARS = 256 * 1024;

/**
 * Per-session follow-up queue. The wire contract this replaces: Pi's `follow_up`
 * queue has no per-item operations (rpc.md offers only `clear_queue`), so the
 * queue Picot renders and edits lives here, keyed by session file. One instance
 * serves every session; pass the key per call (same shape as `pi-queue-park`).
 */
export function createFollowUpQueue({
  storage = globalThis.localStorage,
  maxPersistedTextChars = DEFAULT_MAX_PERSISTED_TEXT_CHARS,
} = {}) {
  const sessions = new Map();
  let warnedPersistence = false;

  // One bucket for null/undefined/"": callers mix `sessionKeyForDialogs()`'s
  // null (pre-snapshot) with its `?? ""` fallback, and two cache entries for
  // the same storage key would drift.
  const normalized = (sessionFile) => sessionFile ?? "";
  const keyOf = (sessionFile) => `${KEY_PREFIX}${normalized(sessionFile)}`;

  function load(rawSessionFile) {
    const sessionFile = normalized(rawSessionFile);
    const cached = sessions.get(sessionFile);
    if (cached) return cached;
    let items = [];
    try {
      const raw = storage?.getItem(keyOf(sessionFile));
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        items = parsed.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.text === "string" &&
            typeof item.createdAt === "number",
        );
      }
    } catch {
      // Corrupt storage is an empty queue, not a crash: the queue is advisory
      // state, and a parse error must not take the composer down with it.
    }
    sessions.set(sessionFile, items);
    return items;
  }

  function persist(sessionFile, items) {
    const persistable = items.filter((item) => item.text.length <= maxPersistedTextChars);
    try {
      storage?.setItem(keyOf(sessionFile), JSON.stringify(persistable));
    } catch {
      if (!warnedPersistence) {
        warnedPersistence = true;
        console.error("[FollowUpQueue] storage unavailable; queue is memory-only for this page");
      }
    }
  }

  return {
    /** A copy of the session's queued items, oldest first. */
    items(sessionFile) {
      return [...load(sessionFile)];
    },
    /** Add one item and persist; returns the stored item (with id/createdAt). */
    append(sessionFile, { text, images = [] }) {
      const items = load(sessionFile);
      const item = {
        id: crypto.randomUUID(),
        text,
        images,
        createdAt: Date.now(),
      };
      items.push(item);
      persist(sessionFile, items);
      return item;
    },
    /** Remove one item by id; returns it or null. Used by edit and delete. */
    remove(sessionFile, id) {
      const items = load(sessionFile);
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const [removed] = items.splice(index, 1);
      persist(sessionFile, items);
      return removed;
    },
    /** Remove and return the oldest item (drain sends one at a time). */
    shift(sessionFile) {
      const items = load(sessionFile);
      const [head] = items.splice(0, 1);
      if (!head) return null;
      persist(sessionFile, items);
      return head;
    },
    /**
     * Put a dispatched item back at the head: a rejected drain/send-now must
     * retry in order, not jump behind items that never left.
     */
    unshift(sessionFile, item) {
      const items = load(sessionFile);
      items.unshift({ ...item });
      persist(sessionFile, items);
    },
    /**
     * Move every item of one bucket in front of another's. Used when the
     * session file materializes: items queued before any snapshot land in
     * the anonymous bucket and would otherwise never render or drain.
     */
    migrate(fromSessionFile, toSessionFile) {
      const moving = load(fromSessionFile);
      if (moving.length === 0) return;
      const target = load(toSessionFile);
      sessions.set(normalized(toSessionFile), [...moving, ...target]);
      sessions.set(normalized(fromSessionFile), []);
      persist(toSessionFile, [...moving, ...target]);
      persist(fromSessionFile, []);
    },
  };
}
