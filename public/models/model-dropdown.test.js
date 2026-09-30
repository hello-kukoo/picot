import { beforeEach, describe, expect, it, vi } from "vitest";
import { openModelDropdownMenu } from "./model-dropdown.js";

function t(key) {
  const dict = {
    "models.searchPlaceholder": "Search models…",
    "models.emptyTitle": "No models available",
    "models.unavailableTitle": "Model list unavailable",
    "models.emptyHelp": "Configure an API key in Settings.",
    "models.unavailableHelp": "Bridge unavailable.",
    "settings.openSettings": "Open settings",
    "models.scoped": "Pinned",
    "models.allEnabled": "All enabled",
    "models.addScoped": "Pin",
    "models.removeScoped": "Unpin",
  };
  return dict[key] ?? key;
}

function setup({ models = [], gateway = null, unavailable = false } = {}) {
  const doc = globalThis.document;
  const dropdown = doc.createElement("div");
  const menu = doc.createElement("div");
  menu.className = "hidden";
  doc.body.append(dropdown, menu);
  const onPick = vi.fn();
  const close = vi.fn();
  const onOpenSettingsClick = vi.fn();
  const ctrl = openModelDropdownMenu({
    doc,
    dropdown,
    menu,
    loadModels: () => models,
    isSelected: (m) => m.id === "claude-3",
    onPick,
    configGateway: gateway,
    onOpenSettingsClick,
    modelsUnavailable: unavailable,
    close,
    t,
  });
  return { doc, dropdown, menu, onPick, close, onOpenSettingsClick, ctrl };
}

describe("openModelDropdownMenu", () => {
  beforeEach(() => {
    globalThis.document.body.replaceChildren();
  });

  it("renders search and matching items, marks the selected one active", () => {
    const { menu, onPick } = setup({
      models: [
        { id: "claude-3", provider: "anthropic" },
        { id: "gpt-4o", provider: "openai", contextWindow: 128000 },
      ],
    });
    expect(menu.querySelector(".model-dropdown-search")).not.toBeNull();
    const items = menu.querySelectorAll(".model-dropdown-item");
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains("active")).toBe(true);
    expect(items[1].textContent).toContain("gpt-4o");
    expect(items[1].textContent).toContain("128k");
    items[1].click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-4o" }));
  });

  it("filters by search query and Enter picks the first match", () => {
    const { menu, onPick } = setup({
      models: [
        { id: "claude-3", provider: "anthropic" },
        { id: "gpt-4o", provider: "openai" },
      ],
    });
    const search = menu.querySelector(".model-dropdown-search");
    search.value = "gpt";
    search.dispatchEvent(new Event("input"));
    expect(menu.querySelectorAll(".model-dropdown-item")).toHaveLength(1);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-4o" }));
  });

  it("Escape in the search box closes via the caller's close hook", () => {
    const { menu, close } = setup({ models: [{ id: "m", provider: "p" }] });
    menu
      .querySelector(".model-dropdown-search")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state with a settings button when no models exist", () => {
    const { menu, onOpenSettingsClick } = setup({ models: [] });
    expect(menu.querySelector(".model-dropdown-item")).toBeNull();
    const button = menu.querySelector(".model-dropdown-empty .btn-primary");
    expect(button).not.toBeNull();
    button.click();
    expect(onOpenSettingsClick).toHaveBeenCalledTimes(1);
  });

  it("splits scoped models into a pinned section and toggles via the gateway", async () => {
    const gateway = {
      call: vi.fn(async (op) =>
        op === "list_scoped_models"
          ? { ok: true, data: { modelIds: ["anthropic/claude-3"] } }
          : { ok: true, data: { modelIds: ["claude-3", "gpt-4o"] } },
      ),
    };
    const { menu } = setup({
      models: [
        { id: "claude-3", provider: "anthropic" },
        { id: "gpt-4o", provider: "openai" },
      ],
      gateway,
    });
    await vi.waitFor(() => {
      expect(menu.querySelectorAll(".model-dropdown-section")).toHaveLength(2);
    });
    const sections = menu.querySelectorAll(".model-dropdown-section");
    expect(sections[0].textContent).toBe("Pinned");
    const openaiItem = [...menu.querySelectorAll(".model-dropdown-item")].find((el) =>
      el.textContent.includes("gpt-4o"),
    );
    const star = openaiItem.querySelector(".model-dropdown-star");
    star.click();
    await vi.waitFor(() => {
      expect(gateway.call).toHaveBeenCalledWith("set_scoped_model", {
        provider: "openai",
        modelId: "gpt-4o",
        enabled: true,
      });
      expect(menu.querySelectorAll(".model-dropdown-section")[0].textContent).toBe("Pinned");
    });
    // After the toggle both models are pinned: two items live in the pinned section.
    const pinnedSectionItems = menu.querySelectorAll(".model-dropdown-section")[0].parentElement;
    expect(pinnedSectionItems.querySelectorAll(".model-dropdown-item")).toHaveLength(2);
  });
});
