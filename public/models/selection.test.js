import { describe, expect, test, vi } from "vitest";
import {
  filterModelsByCatalogVisibility,
  isSelectedModel,
  selectModel,
  splitModelsByScope,
} from "./selection.js";

describe("model selection", () => {
  test("matches provider and model ID together", () => {
    const selection = { provider: "openai", modelId: "gpt-5" };

    expect(isSelectedModel({ provider: "openai", id: "gpt-5" }, selection)).toBe(true);
    expect(isSelectedModel({ provider: "anthropic", id: "gpt-5" }, selection)).toBe(false);
  });

  test("filters runtime models by the configured catalog visibility", () => {
    const models = [
      { provider: "anthropic", id: "visible" },
      { provider: "anthropic", id: "hidden" },
    ];
    const catalog = {
      ok: true,
      data: {
        providers: [
          {
            provider: "anthropic",
            models: [
              { provider: "anthropic", id: "visible", available: true, visible: true },
              { provider: "anthropic", id: "hidden", available: true, visible: false },
            ],
          },
        ],
      },
    };

    expect(filterModelsByCatalogVisibility(models, catalog)).toEqual([models[0]]);
  });

  test("keeps runtime models when the catalog cannot be read", () => {
    const models = [{ provider: "anthropic", id: "visible" }];

    expect(filterModelsByCatalogVisibility(models, null)).toBe(models);
  });

  test("splits scoped models first without repeating them in the remaining list", () => {
    const one = { provider: "anthropic", id: "one" };
    const two = { provider: "openai", id: "two" };
    const three = { provider: "google", id: "three" };

    expect(splitModelsByScope([one, two, three], ["google/three", "anthropic/one"])).toEqual({
      scoped: [three, one],
      remaining: [two],
    });
  });

  test("updates the local model after a successful runtime switch", async () => {
    const rpcCommand = vi.fn(async () => ({ success: true }));
    const refreshModelInfo = vi.fn();
    const applySelectedModel = vi.fn();
    const model = { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 };

    const result = await selectModel({
      model,
      rpcCommand,
      refreshModelInfo,
      applySelectedModel,
    });

    expect(result).toEqual({ success: true });
    expect(rpcCommand).toHaveBeenCalledWith(
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" },
      "Switching to sonnet-5…",
    );
    expect(applySelectedModel).toHaveBeenCalledWith(model);
    expect(refreshModelInfo).not.toHaveBeenCalled();
  });

  test("does not update the local model after a failed runtime switch", async () => {
    const rpcCommand = vi.fn(async () => ({ success: false, error: "model unavailable" }));
    const refreshModelInfo = vi.fn();
    const applySelectedModel = vi.fn();

    const result = await selectModel({
      model: { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 },
      rpcCommand,
      refreshModelInfo,
      applySelectedModel,
    });

    expect(result).toEqual({ success: false, error: "model unavailable" });
    expect(applySelectedModel).not.toHaveBeenCalled();
    expect(refreshModelInfo).toHaveBeenCalledTimes(1);
  });
});
