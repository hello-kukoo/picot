// ABOUTME: Tests the per-package settings mount contract: which packages render,
// ABOUTME: when a missing dependency renders nothing, and how failures surface.

import { describe, expect, it, vi } from "vitest";
import { renderExtensionSettings } from "./index.js";

const FFF_VALUES = {
  mode: "tools-and-ui",
  enableFsRootScanning: true,
  enableHomeDirScanning: false,
  warnOnHomeDirScan: true,
  followSymlinks: false,
  frecencyDbPath: null,
  historyDbPath: null,
};

/** Every host-plane op the renderers may call, all resolving a valid payload. */
const HOST_METHODS = [
  "getFffConfig",
  "setFffConfig",
  "getTodoConfig",
  "setTodoConfig",
  "getAskUserConfig",
  "setAskUserConfig",
  "getPonytailConfig",
  "setPonytailConfig",
  "getVccConfig",
  "setVccConfig",
  "getGoalConfig",
  "setGoalConfig",
  "getCavemanConfig",
  "setCavemanConfig",
  "getCacheOptimizerConfig",
  "setCacheOptimizerConfig",
  "getLensConfig",
  "setLensConfig",
];

function makeControl(overrides = {}) {
  const control = {};
  for (const method of HOST_METHODS) {
    control[method] = vi.fn().mockResolvedValue({ values: { ...FFF_VALUES } });
  }
  return Object.assign(control, overrides);
}

describe("renderExtensionSettings", () => {
  it("renders nothing for a package without a renderer", () => {
    const detail = document.createElement("div");

    renderExtensionSettings(
      detail,
      { source: "npm:some-other-package" },
      { control: makeControl() },
    );

    expect(detail.children.length).toBe(0);
  });

  it("renders nothing when the control gateway is unavailable", () => {
    const detail = document.createElement("div");

    renderExtensionSettings(detail, { source: "npm:@ff-labs/pi-fff" }, {});

    expect(detail.children.length).toBe(0);
  });

  it("mounts the pi-fff settings section for its package source", async () => {
    const detail = document.createElement("div");
    const control = makeControl();

    renderExtensionSettings(detail, { source: "npm:@ff-labs/pi-fff" }, { control });

    await vi.waitFor(() => expect(detail.querySelector(".pkg-ext-settings")).not.toBeNull());
    expect(control.getFffConfig).toHaveBeenCalled();
  });

  it("surfaces a load failure inline instead of leaving an empty section", async () => {
    const detail = document.createElement("div");
    const control = makeControl({
      getFffConfig: vi.fn().mockRejectedValue(new Error("config_access_failed: unreadable")),
    });

    renderExtensionSettings(detail, { source: "npm:@ff-labs/pi-fff" }, { control });

    await vi.waitFor(() =>
      expect(detail.querySelector(".pkg-ext-status")?.textContent).toContain("unreadable"),
    );
  });

  // Every host-plane page must mount and render without the failure row: a
  // missing gateway method or a payload-shape assumption shows up here.
  const HOST_PAGES = [
    ["npm:@ff-labs/pi-fff", "getFffConfig"],
    ["npm:@juicesharp/rpiv-todo", "getTodoConfig"],
    ["npm:@juicesharp/rpiv-ask-user-question", "getAskUserConfig"],
    ["npm:@dietrichgebert/ponytail", "getPonytailConfig"],
    ["npm:@sting8k/pi-vcc", "getVccConfig"],
    ["npm:@narumitw/pi-goal", "getGoalConfig"],
    ["git:github.com/jonjonrankin/pi-caveman", "getCavemanConfig"],
    ["npm:pi-cache-optimizer", "getCacheOptimizerConfig"],
    ["npm:pi-lens", "getLensConfig"],
  ];

  it.each(HOST_PAGES)("mounts the %s settings section cleanly", async (source, getter) => {
    const detail = document.createElement("div");
    const control = makeControl();

    renderExtensionSettings(detail, { source }, { control });

    await vi.waitFor(() => expect(detail.querySelector(".pkg-ext-settings")).not.toBeNull());
    await vi.waitFor(() => expect(control[getter]).toHaveBeenCalled());
    expect(detail.querySelector(".pkg-ext-error")).toBeNull();
  });

  // Bridge-plane pages pick a model, so their dependency is the config
  // gateway. A wrong op name or a missing export shows up as a failure row.
  const BRIDGE_PAGES = [
    ["npm:@juicesharp/rpiv-advisor", "advisor.config.get"],
    ["npm:@narumitw/pi-plan-mode", "planMode.config.get"],
    ["npm:pi-web-access", "webaccess.config.get"],
    ["git:git@example.com:team/datarx-safety-guard-pi.git", "safetyGuard.config.get"],
  ];

  function makeConfigGateway(seen) {
    return {
      call: vi.fn(async (op) => {
        seen.push(op);
        if (op === "list_model_catalog") {
          return {
            ok: true,
            data: {
              providers: [
                {
                  provider: "anthropic",
                  models: [{ provider: "anthropic", id: "claude", available: true, visible: true }],
                },
              ],
            },
          };
        }
        if (op === "list_scoped_models") return { ok: true, data: { modelIds: [] } };
        return { ok: true, data: {} };
      }),
    };
  }

  it.each(BRIDGE_PAGES)("mounts the %s bridge settings section cleanly", async (source, getOp) => {
    const detail = document.createElement("div");
    const seen = [];
    const configGateway = makeConfigGateway(seen);

    renderExtensionSettings(detail, { source }, { configGateway });

    await vi.waitFor(() => expect(detail.querySelector(".pkg-ext-settings")).not.toBeNull());
    await vi.waitFor(() => expect(seen).toContain(getOp));
    expect(detail.querySelector(".pkg-ext-error")).toBeNull();
  });

  it("renders nothing for a bridge page when the config gateway is absent", () => {
    const detail = document.createElement("div");

    renderExtensionSettings(
      detail,
      { source: "npm:@juicesharp/rpiv-advisor" },
      { control: makeControl() },
    );

    expect(detail.children.length).toBe(0);
  });
});
