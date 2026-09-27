// ABOUTME: unit tests for the Picot-owned follow-up queue (localStorage per session).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFollowUpQueue } from "./follow-up-queue.js";

function stubStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

let storage;
beforeEach(() => {
  storage = stubStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFollowUpQueue", () => {
  test("append persists items under the per-session key in FIFO order", () => {
    const queue = createFollowUpQueue({ storage });
    queue.append("/pi/sessions/s1.jsonl", { text: "first" });
    queue.append("/pi/sessions/s1.jsonl", {
      text: "second",
      images: [{ data: "B64", mimeType: "image/png" }],
    });

    expect(queue.items("/pi/sessions/s1.jsonl").map((item) => item.text)).toEqual([
      "first",
      "second",
    ]);
    const persisted = JSON.parse(storage.getItem("pi-studio:followup-queue:/pi/sessions/s1.jsonl"));
    expect(persisted).toHaveLength(2);
    expect(persisted[1].images).toEqual([{ data: "B64", mimeType: "image/png" }]);
    expect(typeof persisted[0].id).toBe("string");
    expect(typeof persisted[0].createdAt).toBe("number");
  });

  test("a fresh instance loads persisted items from storage", () => {
    createFollowUpQueue({ storage }).append("/pi/sessions/s1.jsonl", { text: "survives reload" });
    const reloaded = createFollowUpQueue({ storage });
    expect(reloaded.items("/pi/sessions/s1.jsonl").map((item) => item.text)).toEqual([
      "survives reload",
    ]);
  });

  test("remove deletes exactly one item and persists the rest", () => {
    const queue = createFollowUpQueue({ storage });
    const a = queue.append("k", { text: "a" });
    queue.append("k", { text: "b" });
    const removed = queue.remove("k", a.id);

    expect(removed?.text).toBe("a");
    expect(queue.items("k").map((item) => item.text)).toEqual(["b"]);
    expect(JSON.parse(storage.getItem("pi-studio:followup-queue:k"))).toHaveLength(1);
    expect(queue.remove("k", "missing")).toBeNull();
  });

  test("shift takes the head and leaves the tail", () => {
    const queue = createFollowUpQueue({ storage });
    queue.append("k", { text: "head" });
    queue.append("k", { text: "tail" });

    expect(queue.shift("k")?.text).toBe("head");
    expect(queue.items("k").map((item) => item.text)).toEqual(["tail"]);
    expect(queue.shift("empty-key")).toBeNull();
  });

  test("keys are isolated per session file", () => {
    const queue = createFollowUpQueue({ storage });
    queue.append("s1", { text: "one" });
    queue.append("s2", { text: "two" });

    expect(queue.items("s1").map((item) => item.text)).toEqual(["one"]);
    expect(queue.items("s2").map((item) => item.text)).toEqual(["two"]);
    queue.shift("s1");
    expect(queue.items("s2")).toHaveLength(1);
  });

  test("oversized text stays in memory but is not persisted", () => {
    const queue = createFollowUpQueue({ storage, maxPersistedTextChars: 10 });
    queue.append("k", { text: "small" });
    const big = queue.append("k", { text: "x".repeat(50) });

    expect(queue.items("k")).toHaveLength(2);
    const persisted = JSON.parse(storage.getItem("pi-studio:followup-queue:k"));
    expect(persisted.map((item) => item.text)).toEqual(["small"]);
    // The in-memory oversized item still shifts out intact.
    expect(queue.shift("k")?.text).toBe("small");
    expect(queue.shift("k")?.id).toBe(big.id);
  });

  test("a failing storage write degrades to memory-only and warns once", () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = createFollowUpQueue({ storage: failing });

    queue.append("k", { text: "a" });
    queue.append("k", { text: "b" });

    expect(queue.items("k").map((item) => item.text)).toEqual(["a", "b"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("a null session key falls back to an empty-string bucket", () => {
    const queue = createFollowUpQueue({ storage });
    queue.append(null, { text: "anonymous" });
    expect(queue.items("")).toHaveLength(1);
    expect(queue.items(null)).toHaveLength(1);
  });
  test("a null session key falls back to an empty-string bucket", () => {
    const queue = createFollowUpQueue({ storage });
    queue.append(null, { text: "anonymous" });
    expect(queue.items("")).toHaveLength(1);
    expect(queue.items(null)).toHaveLength(1);
  });

  test("migrate adopts anonymous items in front of the session's own", () => {
    const queue = createFollowUpQueue({ storage });
    const early = queue.append("", { text: "queued before the snapshot" });
    queue.append("s1", { text: "queued after" });

    queue.migrate("", "s1");

    const texts = queue.items("s1").map((item) => item.text);
    expect(texts).toEqual(["queued before the snapshot", "queued after"]);
    expect(queue.items("")).toHaveLength(0);
    expect(queue.items("s1")[0].id).toBe(early.id);
    // Both buckets persist their post-migration state.
    expect(JSON.parse(storage.getItem("pi-studio:followup-queue:"))).toEqual([]);
    expect(JSON.parse(storage.getItem("pi-studio:followup-queue:s1"))).toHaveLength(2);
    // Migrating an empty bucket is a no-op.
    queue.migrate("", "s1");
    expect(queue.items("s1")).toHaveLength(2);
  });
});
