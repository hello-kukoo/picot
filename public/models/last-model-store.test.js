// ABOUTME: Guards the last-model store's storage contract and its degrade paths.
// ABOUTME: A broken or absent localStorage must never break session startup.

import { describe, expect, it } from "vitest";
import { getLastModel, setLastModel } from "./last-model-store.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

describe("last-model store", () => {
  it("round-trips a provider-scoped model pair", () => {
    const storage = memoryStorage();
    setLastModel({ provider: "anthropic", id: "claude-sonnet-4" }, storage);
    expect(getLastModel(storage)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  it("accepts the profile-shaped pair as well as an available-model object", () => {
    const storage = memoryStorage();
    setLastModel({ provider: "openai", modelId: "gpt-5" }, storage);
    expect(getLastModel(storage)).toEqual({ provider: "openai", modelId: "gpt-5" });
  });

  it("ignores incomplete input instead of storing a half pair", () => {
    const storage = memoryStorage();
    setLastModel({ provider: "anthropic" }, storage);
    setLastModel({ id: "claude-sonnet-4" }, storage);
    expect(getLastModel(storage)).toBeNull();
  });

  it("returns null for corrupt or shape-shifted stored data", () => {
    expect(getLastModel(memoryStorage({ "picot.composer.lastModel": "not json" }))).toBeNull();
    expect(
      getLastModel(memoryStorage({ "picot.composer.lastModel": '{"provider":""}' })),
    ).toBeNull();
  });

  it("degrades quietly when storage is unavailable or full", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => setLastModel({ provider: "anthropic", id: "m" }, throwing)).not.toThrow();
    expect(getLastModel(throwing)).toBeNull();
  });
});
