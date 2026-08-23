import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n.js";
import { setupUpdateIndicator } from "./update-indicator.js";

function renderIndicatorDom() {
  document.body.innerHTML = `
    <button type="button" class="update-indicator hidden" id="package-update-indicator">
      <span class="update-indicator-count" aria-hidden="true"></span>
    </button>
  `;
}

function indicatorButton() {
  return document.getElementById("package-update-indicator");
}

describe("setupUpdateIndicator", () => {
  beforeEach(() => {
    renderIndicatorDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stays hidden while the update count is zero", () => {
    setupUpdateIndicator({ buttonEl: indicatorButton(), onOpen: vi.fn() });
    expect(indicatorButton().classList.contains("hidden")).toBe(true);
  });

  it("shows the count and tip once updates are reported", () => {
    const indicator = setupUpdateIndicator({ buttonEl: indicatorButton(), onOpen: vi.fn() });
    indicator.setCount(3);
    expect(indicatorButton().classList.contains("hidden")).toBe(false);
    expect(indicatorButton().querySelector(".update-indicator-count").textContent).toBe("3");
    expect(indicatorButton().title).toContain(t("header.extensionUpdatesAvailable"));
    expect(indicatorButton().getAttribute("aria-label")).toBe(
      `${t("header.extensionUpdatesAvailable")} (3)`,
    );
  });

  it("hides again when the count drops back to zero", () => {
    const indicator = setupUpdateIndicator({ buttonEl: indicatorButton(), onOpen: vi.fn() });
    indicator.setCount(2);
    indicator.setCount(0);
    expect(indicatorButton().classList.contains("hidden")).toBe(true);
  });

  it("ignores non-finite counts", () => {
    const indicator = setupUpdateIndicator({ buttonEl: indicatorButton(), onOpen: vi.fn() });
    indicator.setCount(Number.NaN);
    indicator.setCount(undefined);
    expect(indicatorButton().classList.contains("hidden")).toBe(true);
  });

  it("opens the extensions settings via onOpen when clicked", () => {
    const onOpen = vi.fn();
    const indicator = setupUpdateIndicator({ buttonEl: indicatorButton(), onOpen });
    indicator.setCount(1);
    indicatorButton().click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("returns a no-op handle when the button is missing", () => {
    document.body.innerHTML = "";
    const indicator = setupUpdateIndicator({ buttonEl: null, onOpen: vi.fn() });
    expect(() => indicator.setCount(2)).not.toThrow();
  });
});
