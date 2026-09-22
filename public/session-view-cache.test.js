// ABOUTME: Unit tests for the per-session view cache (LRU, background
// ABOUTME: increments, stamp validation) — session-resident-views Phase A.
import { describe, expect, test } from "vitest";
import {
  createSessionViewCache,
  SESSION_VIEW_CACHE_LIMIT,
  viewMatchesStamp,
} from "./app/session-view-cache.js";

const message = (id, text) => ({ id, role: "assistant", content: [{ type: "text", text }] });

describe("viewMatchesStamp", () => {
  test("trusted views match regardless of the file stamp", () => {
    expect(viewMatchesStamp({ trusted: true, stamp: null }, null)).toBe(true);
  });

  test("untrusted views match only an identical mtime (and size when both known)", () => {
    const view = { stamp: { mtimeMs: 100, sizeBytes: 7 } };
    expect(viewMatchesStamp(view, { mtimeMs: 100, sizeBytes: 7 })).toBe(true);
    expect(viewMatchesStamp(view, { mtimeMs: 100 })).toBe(true);
    expect(viewMatchesStamp(view, { mtimeMs: 101, sizeBytes: 7 })).toBe(false);
    expect(viewMatchesStamp(view, { mtimeMs: 100, sizeBytes: 8 })).toBe(false);
  });

  test("missing stamps never validate", () => {
    expect(viewMatchesStamp({ stamp: null }, { mtimeMs: 1 })).toBe(false);
    expect(viewMatchesStamp({ stamp: { mtimeMs: 1 } }, null)).toBe(false);
    expect(viewMatchesStamp(null, { mtimeMs: 1 })).toBe(false);
  });
});

describe("createSessionViewCache", () => {
  test("put/get round-trips and get() refreshes LRU order", () => {
    const cache = createSessionViewCache(2);
    cache.put("a", { entries: [] });
    cache.put("b", { entries: [] });
    cache.get("a"); // a is now most recent
    cache.put("c", { entries: [] }); // evicts b, not a
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  test("the LRU cap defaults to SESSION_VIEW_CACHE_LIMIT", () => {
    const cache = createSessionViewCache();
    for (let i = 0; i < SESSION_VIEW_CACHE_LIMIT + 3; i += 1) {
      cache.put(`s${i}`, { entries: [] });
    }
    expect(cache.size).toBe(SESSION_VIEW_CACHE_LIMIT);
    expect(cache.get("s0")).toBeNull();
    expect(cache.get(`s${SESSION_VIEW_CACHE_LIMIT + 2}`)).not.toBeNull();
  });

  test("captureLeave updates view state in place", () => {
    const cache = createSessionViewCache();
    cache.put("a", { entries: [], revealedCount: 2, scrollTop: null, stamp: null });
    cache.captureLeave("a", { scrollTop: 4242, revealedCount: 6, stamp: { mtimeMs: 9 } });
    const view = cache.get("a");
    expect(view.scrollTop).toBe(4242);
    expect(view.revealedCount).toBe(6);
    expect(view.stamp).toEqual({ mtimeMs: 9 });
  });

  test("appendMessage replaces by entry id and marks the view trusted", () => {
    const cache = createSessionViewCache();
    cache.put("a", {
      entries: [{ id: "e1", parentId: null, type: "message", message: message("e1", "draft") }],
      trusted: false,
    });
    cache.appendMessage("a", message("e1", "final"), "e1");
    const view = cache.get("a");
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].message.content[0].text).toBe("final");
    expect(view.trusted).toBe(true);
  });

  test("appendMessage appends unknown ids and ignores un-cached sessions", () => {
    const cache = createSessionViewCache();
    cache.put("a", { entries: [], trusted: false });
    cache.appendMessage("a", message("e2", "new"), "e2");
    expect(cache.get("a").entries).toHaveLength(1);
    expect(cache.appendMessage("nope", message("x", "y"), "x")).toBe(false);
  });

  test("invalidate drops a single session", () => {
    const cache = createSessionViewCache();
    cache.put("a", { entries: [] });
    cache.put("b", { entries: [] });
    cache.invalidate("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
  });
});
