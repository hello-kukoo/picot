import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openCustomProviderEditor } from "./settings-custom-provider.js";

describe("custom provider editor", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM("<body></body>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  test("detects protocol, lists models, tests connectivity, and saves via picot-config", async () => {
    const call = vi.fn(async (op) => {
      if (op === "detect_custom_provider") {
        return {
          ok: true,
          data: {
            protocol: "openai-completions",
            models: [{ id: "gpt-4o-mini", contextWindow: 32768 }, { id: "deepseek-v3" }],
          },
        };
      }
      if (op === "test_custom_provider") {
        return { ok: true, data: { ok: true, latencyMs: 42 } };
      }
      if (op === "save_custom_provider") {
        return {
          ok: true,
          data: { providerId: "example-com", modelCount: 2, keyStored: true },
        };
      }
      throw new Error(`Unexpected op: ${op}`);
    });
    const onSaved = vi.fn();
    const setupDialog = (title, subtitle) => {
      const backdrop = document.createElement("div");
      const dialog = document.createElement("div");
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      const heading = document.createElement("h2");
      heading.textContent = title;
      const caption = document.createElement("p");
      caption.textContent = subtitle;
      dialog.append(heading, caption);
      return { backdrop, dialog };
    };

    openCustomProviderEditor({ call, setupDialog, onSaved });

    const inputs = document.querySelectorAll(".provider-setup-form input");
    inputs[1].value = "https://api.example.com/v1";
    inputs[2].value = "sk-test";
    document.querySelector(".provider-setup-actions .ui-button--secondary:nth-of-type(2)").click();

    await vi.waitFor(() =>
      expect(document.querySelectorAll(".custom-provider-model-toggle")).toHaveLength(2),
    );
    expect(document.querySelector("select").value).toBe("openai-completions");

    document.querySelectorAll(".provider-setup-actions .ui-button--secondary")[2].click();
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "test_custom_provider",
        expect.objectContaining({ protocol: "openai-completions", modelId: "gpt-4o-mini" }),
        expect.any(Object),
      ),
    );

    document.querySelector(".provider-setup-actions .ui-button--primary").click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith("example-com"));
    const saveCall = call.mock.calls.find(([op]) => op === "save_custom_provider");
    expect(saveCall[1]).toMatchObject({
      protocol: "openai-completions",
      storeKey: true,
      includeApiKeyInFile: false,
    });
    expect(saveCall[1].models.map((model) => model.id)).toEqual(["gpt-4o-mini", "deepseek-v3"]);
  });
});
