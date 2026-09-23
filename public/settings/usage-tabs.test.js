// ABOUTME: Usage page sub-tab tests: selection state and the rebuild case that
// ABOUTME: broke the original captured-listener wiring.
import { afterEach, expect, test, vi } from "vitest";
import { setupUsageTabs } from "./usage-tabs.js";

const PANELS = `
  <div class="settings-tab" data-settings-panel="usage">
    <div class="usage-page-tabs" role="tablist">
      <button type="button" role="tab" data-usage-tab="cost" aria-selected="true">Usage</button>
      <button type="button" role="tab" data-usage-tab="quota" aria-selected="false">Quota</button>
    </div>
    <div class="usage-page-panel" data-usage-panel="cost"></div>
    <div class="usage-page-panel hidden" data-usage-panel="quota"></div>
  </div>`;

afterEach(() => {
  document.body.replaceChildren();
});

function clickTab(view) {
  document.querySelector(`[data-usage-tab="${view}"]`).click();
}

test("switches the visible panel when the markup arrives after setup", () => {
  const onSelect = vi.fn();
  const teardown = setupUsageTabs({ onSelect });
  // The Settings overlay builds (or re-parents) this markup when it opens, so
  // wiring must not depend on the nodes existing at setup time.
  document.body.innerHTML = PANELS;

  clickTab("quota");
  expect(onSelect).toHaveBeenLastCalledWith("quota");
  expect(document.querySelector('[data-usage-tab="quota"]').getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(document.querySelector('[data-usage-tab="cost"]').getAttribute("aria-selected")).toBe(
    "false",
  );
  expect(document.querySelector('[data-usage-panel="quota"]').classList.contains("hidden")).toBe(
    false,
  );
  expect(document.querySelector('[data-usage-panel="cost"]').classList.contains("hidden")).toBe(
    true,
  );

  clickTab("cost");
  expect(document.querySelector('[data-usage-panel="cost"]').classList.contains("hidden")).toBe(
    false,
  );
  expect(document.querySelector('[data-usage-panel="quota"]').classList.contains("hidden")).toBe(
    true,
  );
  teardown();
});

test("ignores clicks that are not on a usage tab", () => {
  const onSelect = vi.fn();
  const teardown = setupUsageTabs({ onSelect });
  document.body.innerHTML = `${PANELS}<button id="other">x</button>`;
  document.getElementById("other").click();
  expect(onSelect).not.toHaveBeenCalled();
  teardown();
});
