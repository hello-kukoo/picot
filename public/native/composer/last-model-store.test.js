import { beforeEach, describe, expect, test } from "vitest";
import { getLastModel, setLastModel } from "./last-model-store.js";

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

describe("last-model-store", () => {
  let storage;
  beforeEach(() => {
    storage = createStorage();
  });

  test("returns null when nothing is stored", () => {
    expect(getLastModel(storage)).toBeNull();
  });

  test("round-trips an available-model object ({ provider, id })", () => {
    setLastModel({ provider: "anthropic", id: "claude-opus-4-8" }, storage);
    expect(getLastModel(storage)).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
  });

  test("accepts a profile-shaped pair ({ provider, modelId })", () => {
    setLastModel({ provider: "openai", modelId: "gpt-5" }, storage);
    expect(getLastModel(storage)).toEqual({ provider: "openai", modelId: "gpt-5" });
  });

  test("ignores writes missing a provider or model id", () => {
    setLastModel({ provider: "anthropic" }, storage);
    setLastModel({ id: "claude-opus-4-8" }, storage);
    setLastModel({ provider: "  ", id: "  " }, storage);
    expect(getLastModel(storage)).toBeNull();
  });

  test("returns null for corrupted json", () => {
    storage.setItem("picot.composer.lastModel", "{not json");
    expect(getLastModel(storage)).toBeNull();
  });

  test("returns null when the stored record is incomplete", () => {
    storage.setItem("picot.composer.lastModel", JSON.stringify({ provider: "anthropic" }));
    expect(getLastModel(storage)).toBeNull();
  });
});
