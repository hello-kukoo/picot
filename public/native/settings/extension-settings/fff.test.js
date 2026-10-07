// ABOUTME: Tests the pi-fff settings renderer: mode control, scan toggles,
// ABOUTME: save-on-change through the host op, and the invalid-config reset path.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderFffSettings } from "./fff.js";

const FFF_VALUES = {
  mode: "tools-and-ui",
  enableFsRootScanning: true,
  enableHomeDirScanning: false,
  warnOnHomeDirScan: true,
  followSymlinks: false,
  frecencyDbPath: null,
  historyDbPath: null,
};

function makeTransport({ values = FFF_VALUES, invalid = null, envShadowed = [] } = {}) {
  return {
    getFffConfig: vi.fn().mockResolvedValue({
      values,
      envShadowed,
      flagShadowed: [],
      shadowNames: {},
      ...(invalid ? { invalid } : {}),
    }),
    setFffConfig: vi.fn().mockResolvedValue({}),
  };
}

async function mount(transport) {
  const detail = document.createElement("div");
  document.body.appendChild(detail);
  await renderFffSettings(detail, { source: "npm:@ff-labs/pi-fff" }, transport);
  return detail;
}

describe("renderFffSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the active mode and the four scan toggles from the host payload", async () => {
    const detail = await mount(makeTransport());

    const segment = detail.querySelectorAll(".pkg-ext-segment-btn");
    expect(segment).toHaveLength(3);
    const active = [...segment].filter((btn) => btn.classList.contains("is-on"));
    expect(active.map((btn) => btn.textContent)).toHaveLength(1);

    const toggles = detail.querySelectorAll(".pkg-manager-toggle");
    expect(toggles).toHaveLength(4);
    expect(toggles[0].getAttribute("aria-checked")).toBe("true");
    expect(toggles[1].getAttribute("aria-checked")).toBe("false");
  });

  it("saves a toggled key through the host op and flips the control", async () => {
    const transport = makeTransport();
    const detail = await mount(transport);
    const toggles = detail.querySelectorAll(".pkg-manager-toggle");

    toggles[1].click();

    await vi.waitFor(() =>
      expect(transport.setFffConfig).toHaveBeenCalledWith({
        key: "enableHomeDirScanning",
        value: true,
      }),
    );
    await vi.waitFor(() => expect(toggles[1].getAttribute("aria-checked")).toBe("true"));
  });

  it("disables a shadowed field and badges the decisive source", async () => {
    const transport = makeTransport({ envShadowed: ["followSymlinks"] });
    const detail = await mount(transport);

    const shadowedToggle = [...detail.querySelectorAll(".pkg-manager-toggle")].find((btn) =>
      btn.getAttribute("aria-label")?.includes("followSymlinks"),
    );
    expect(shadowedToggle.disabled).toBe(true);
    expect(detail.querySelector(".pkg-ext-badge")).not.toBeNull();
  });

  it("reports a save failure instead of silently keeping the new state", async () => {
    const transport = makeTransport();
    transport.setFffConfig.mockRejectedValue(new Error("config_access_failed: locked"));
    const detail = await mount(transport);
    const toggle = detail.querySelectorAll(".pkg-manager-toggle")[1];

    toggle.click();

    // The locale catalog is not loaded under test, so assert the contract the
    // renderer owns: a failure writes a message and leaves the state unchanged.
    await vi.waitFor(() =>
      expect(detail.querySelector(".pkg-ext-status")?.textContent).not.toBe(""),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("requires a second click before resetting an invalid config", async () => {
    const transport = makeTransport({ invalid: { reason: "Unexpected token" } });
    const detail = await mount(transport);

    const reset = detail.querySelector(".pkg-ext-btn-danger");
    expect(detail.querySelector(".pkg-ext-error")?.textContent).toContain("Unexpected token");

    reset.click();
    expect(transport.setFffConfig).not.toHaveBeenCalled();

    reset.click();
    await vi.waitFor(() => expect(transport.setFffConfig).toHaveBeenCalledWith({ reset: true }));
  });
});
