import { describe, expect, test, vi } from "vitest";
import {
  createComposerDraftStore,
  DEFAULT_MAX_DRAFT_CHARS,
  DEFAULT_MAX_DRAFT_ENTRIES,
  draftKeyFor,
} from "./composer-draft-store.js";

function makePreferences({ fail = false } = {}) {
  const db = new Map();
  const client = {
    available: () => !fail,
    async get(key) {
      return db.has(key) ? db.get(key) : null;
    },
    async set(key, value) {
      db.set(key, value);
    },
    async remove(key) {
      db.delete(key);
    },
    async list(prefix = "") {
      const out = {};
      for (const [key, value] of db) {
        if (key.startsWith(prefix)) out[key] = value;
      }
      return out;
    },
  };
  return { client, db };
}

describe("createComposerDraftStore", () => {
  test("saves, reads synchronously, and writes through to the DB namespace", async () => {
    const { client, db } = makePreferences();
    const store = createComposerDraftStore({ preferences: client });
    await store.save("file:/tmp/a.jsonl", "draft a");
    expect(store.get("file:/tmp/a.jsonl")).toBe("draft a");
    expect(store.get("file:/tmp/other.jsonl")).toBe("");
    expect(db.get(draftKeyFor("file:/tmp/a.jsonl"))).toMatchObject({ text: "draft a" });
  });

  test("saving empty text deletes the draft", async () => {
    const { client, db } = makePreferences();
    const store = createComposerDraftStore({ preferences: client });
    await store.save("file:/tmp/a.jsonl", "draft a");
    await store.save("file:/tmp/a.jsonl", "");
    expect(store.get("file:/tmp/a.jsonl")).toBe("");
    expect(db.has(draftKeyFor("file:/tmp/a.jsonl"))).toBe(false);
  });

  test("loadAll seeds the cache from the persisted namespace", async () => {
    const { client } = makePreferences();
    const key = draftKeyFor("file:/tmp/a.jsonl");
    await client.set(key, { text: "restored", updatedAt: 5 });
    const store = createComposerDraftStore({ preferences: client });
    await store.loadAll();
    expect(store.get("file:/tmp/a.jsonl")).toBe("restored");
  });

  test("a loadAll retry keeps drafts typed during the capability gap", async () => {
    // The first loadAll runs before hello_ack, when the native capability is
    // false: saves are memory-only. When the capability arrives and loadAll
    // retries, a stale DB row must not clobber the newer in-memory draft.
    let capability = false;
    const { client } = makePreferences();
    const key = draftKeyFor("file:/tmp/a.jsonl");
    await client.set(key, { text: "stale db text", updatedAt: 5 });
    client.available = () => capability;
    const store = createComposerDraftStore({ preferences: client });
    await store.loadAll(); // capability gap: no-op
    await store.save("file:/tmp/a.jsonl", "typed during boot"); // memory-only
    capability = true;
    await store.loadAll(); // retry must not overwrite the newer draft
    expect(store.get("file:/tmp/a.jsonl")).toBe("typed during boot");
  });

  test("per-draft length is clamped to the documented cap", async () => {
    const { client } = makePreferences();
    const store = createComposerDraftStore({ preferences: client });
    const long = "x".repeat(DEFAULT_MAX_DRAFT_CHARS + 500);
    await store.save("file:/tmp/a.jsonl", long);
    expect(store.get("file:/tmp/a.jsonl")).toHaveLength(DEFAULT_MAX_DRAFT_CHARS);
  });

  test("entry count is bounded with least-recently-updated eviction", async () => {
    const { client } = makePreferences();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 1000;
    expect(DEFAULT_MAX_DRAFT_ENTRIES).toBeGreaterThan(3); // doc constant
    const store = createComposerDraftStore({
      preferences: client,
      maxEntries: 3,
      now: () => clock,
    });
    await store.save("id-1", "a");
    clock += 1;
    await store.save("id-2", "b");
    clock += 1;
    await store.save("id-3", "c");
    clock += 1;
    // Bump id-2 so id-1 becomes the least-recently-updated entry.
    await store.save("id-2", "b2");
    clock += 1;
    await store.save("id-4", "d");

    expect(store.get("id-1")).toBe(""); // evicted
    expect(store.get("id-2")).toBe("b2");
    expect(store.get("id-3")).toBe("c");
    expect(store.get("id-4")).toBe("d");
    warn.mockRestore();
  });

  test("clearForSessionFile removes exactly that session's drafts", async () => {
    const { client } = makePreferences();
    const store = createComposerDraftStore({ preferences: client });
    await store.save("file:/tmp/a.jsonl", "a");
    await store.save("file:/tmp/b.jsonl", "b");
    await store.clearForSessionFile("/tmp/a.jsonl");
    expect(store.get("file:/tmp/a.jsonl")).toBe("");
    expect(store.get("file:/tmp/b.jsonl")).toBe("b");
  });

  test("memory-only mode (preferences unavailable) keeps drafts for the session lifetime", async () => {
    const { client } = makePreferences({ fail: true });
    const store = createComposerDraftStore({ preferences: client });
    await store.save("file:/tmp/a.jsonl", "draft a");
    expect(store.get("file:/tmp/a.jsonl")).toBe("draft a");
  });
});
