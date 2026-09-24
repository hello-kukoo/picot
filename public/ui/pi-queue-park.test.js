// ABOUTME: Locks the pi queue park keyed by session file and its forget path.
// ABOUTME: pi emits queue_update only on mutation, so a switch-back has no other source.

import { describe, expect, test } from "vitest";
import { createPiQueuePark } from "./pi-queue-park.js";

describe("pi queue park", () => {
  test("hands back the last queue reported for a session", () => {
    const park = createPiQueuePark();
    park.set("/sessions/s1.jsonl", { steering: ["steer"], followUp: ["later"] });
    expect(park.get("/sessions/s1.jsonl")).toEqual({ steering: ["steer"], followUp: ["later"] });
  });

  test("a session with no reported queue parks nothing", () => {
    const park = createPiQueuePark();
    expect(park.get("/sessions/s2.jsonl")).toBeNull();
    expect(park.get(null)).toBeNull();
  });

  test("an unresolved session file is never a key", () => {
    // The park shares the composer identity's key space; a null key would be
    // read back by every session (or by none) and show another session's queue.
    const park = createPiQueuePark();
    expect(park.set(null, { steering: ["from nowhere"], followUp: [] })).toBe(false);
    expect(park.get(null)).toBeNull();
  });

  test("the newest report replaces the previous one for the same session", () => {
    const park = createPiQueuePark();
    park.set("/sessions/s1.jsonl", { steering: ["old"], followUp: [] });
    park.set("/sessions/s1.jsonl", { steering: [], followUp: ["new"] });
    expect(park.get("/sessions/s1.jsonl")).toEqual({ steering: [], followUp: ["new"] });
  });

  test("forget drops the entry so a dead runtime's queue cannot return", () => {
    const park = createPiQueuePark();
    park.set("/sessions/s1.jsonl", { steering: ["stale"], followUp: [] });
    park.forget("/sessions/s1.jsonl");
    expect(park.get("/sessions/s1.jsonl")).toBeNull();
    expect(() => park.forget(null)).not.toThrow();
  });
});
