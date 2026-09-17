// @vitest-environment jsdom

// ABOUTME: Verifies the package extension-settings renderer: advisor model/effort
// ABOUTME: coupling, off state, save-on-change payloads, and no-op behavior.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { renderExtensionSettings } from "./package-extension-settings.js";

setMessages({
  settings: {
    extensionAdvisor: {
      title: "Advisor",
      modelLabel: "Reviewer model",
      effortLabel: "Reasoning effort",
      off: "Disable Advisor",
      effortOff: "off (no reasoning sent)",
      hint: "Changes take effect in new sessions",
      effortReset: "Stored effort is not supported by this model — reset to off",
      saved: "Saved.",
      saveFailed: "Save failed: {message}",
    },
    extensionFff: {
      title: "pi-fff",
      hint: "Changes take effect after restarting Picot",
      modeLabel: "Mode",
      mode: {
        "tools-and-ui": "Tools & UI",
        "tools-only": "Tools only",
        override: "Override",
      },
      modeDesc: {
        "tools-and-ui": "Adds fffind / ffgrep / fff-multi-grep tools and FFF-backed @ autocomplete",
        "tools-only": "Adds the tools; keeps pi's default @ autocomplete",
        override: "Replaces pi's built-in find / grep and adds multi-grep + FFF autocomplete",
      },
      enableFsRootScanning: "Filesystem root scanning",
      enableHomeDirScanning: "Home directory scanning",
      warnOnHomeDirScan: "Warn when scanning home",
      followSymlinks: "Follow symlinks",
      advanced: "Advanced",
      frecencyDbPath: "Frecency database path",
      historyDbPath: "History database path",
      dbManaged: "(fff-managed)",
      shadowBadge: "overridden by {name}",
      invalidConfig: "pi-fff.json is invalid — the extension cannot load:",
      reset: "Reset to defaults",
      resetConfirm: "Click again to confirm",
      saved: "Saved.",
      saveFailed: "Save failed: {message}",
    },
  },
});

const GET_OK = {
  ok: true,
  data: {
    modelKey: "anthropic/claude-sonnet",
    effort: "high",
    models: [
      {
        key: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        levels: ["minimal", "low", "medium", "high", "max"],
        available: true,
      },
      {
        key: "minimax-cn/MiniMax-M3",
        name: "MiniMax M3",
        levels: ["low", "high"],
        available: true,
      },
      { key: "locked/no-creds", name: "Locked", levels: ["low"], available: false },
    ],
  },
};

function mount(gatewayResult) {
  const calls = [];
  const configGateway = {
    call: (op, params) => {
      calls.push({ op, params });
      if (typeof gatewayResult === "function") return gatewayResult(op, params);
      return Promise.resolve(gatewayResult);
    },
  };
  return { calls, configGateway };
}

function detailWith() {
  const el = document.createElement("div");
  return el;
}

async function renderAdvisor(gatewayResult) {
  const { calls, configGateway } = mount(gatewayResult);
  const detailEl = detailWith();
  renderExtensionSettings(detailEl, { source: "npm:@juicesharp/rpiv-advisor" }, { configGateway });
  await vi.waitFor(() => {
    if (!detailEl.querySelector("select")) throw new Error("section not mounted yet");
  });
  const [modelSelect, effortSelect] = detailEl.querySelectorAll("select");
  return {
    detailEl,
    modelSelect,
    effortSelect,
    calls,
    status: () => detailEl.querySelector(".pkg-ext-status").textContent,
    notice: () => detailEl.querySelector(".pkg-ext-notice").textContent,
  };
}

describe("renderExtensionSettings dispatch", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders nothing for packages without a renderer", () => {
    const detailEl = detailWith();
    renderExtensionSettings(detailEl, { source: "npm:other-package" }, mount(GET_OK).configGateway);
    expect(detailEl.children.length).toBe(0);
  });

  it("renders nothing without the dep its surface needs", () => {
    const detailEl = detailWith();
    // Advisor needs the bridge gateway (in-process model registry).
    renderExtensionSettings(detailEl, { source: "npm:@juicesharp/rpiv-advisor" }, {});
    expect(detailEl.children.length).toBe(0);
    // pi-fff needs the host-op transport.
    renderExtensionSettings(detailEl, { source: "npm:@ff-labs/pi-fff" }, {});
    expect(detailEl.children.length).toBe(0);
  });
});

describe("advisor renderer", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders title, hint, off row, and the saved model/effort", async () => {
    const { detailEl, modelSelect, effortSelect } = await renderAdvisor(GET_OK);
    expect(detailEl.textContent).toContain("Advisor");
    expect(detailEl.textContent).toContain("Changes take effect in new sessions");
    expect(modelSelect.value).toBe("anthropic/claude-sonnet");
    expect(effortSelect.value).toBe("high");
    // Available models only; the locked provider never appears.
    const optionValues = [...modelSelect.options].map((o) => o.value);
    expect(optionValues).toContain("");
    expect(optionValues).toContain("minimax-cn/MiniMax-M3");
    expect(optionValues).not.toContain("locked/no-creds");
    expect(modelSelect.options[0].textContent).toBe("Disable Advisor");
  });

  it("off state: no modelKey → effort select disabled and off option selected", async () => {
    const data = { ...GET_OK.data, modelKey: undefined, effort: undefined };
    const { modelSelect, effortSelect } = await renderAdvisor({ ok: true, data });
    expect(modelSelect.value).toBe("");
    expect(effortSelect.disabled).toBe(true);
    expect(effortSelect.value).toBe("");
    expect(effortSelect.options[0].textContent).toBe("off (no reasoning sent)");
  });

  it("a stored model outside the available list stays visible as its raw key", async () => {
    const data = { ...GET_OK.data, modelKey: "gone/model-x" };
    const { modelSelect } = await renderAdvisor({ ok: true, data });
    expect(modelSelect.value).toBe("gone/model-x");
    expect([...modelSelect.options].map((o) => o.value)).toContain("gone/model-x");
  });

  it("model change to incompatible model resets effort, notices, and saves the pair", async () => {
    const { modelSelect, effortSelect, calls, notice } = await renderAdvisor(GET_OK);
    modelSelect.value = "minimax-cn/MiniMax-M3";
    modelSelect.dispatchEvent(new Event("change"));
    // "high" survives: MiniMax supports it.
    expect(effortSelect.value).toBe("high");
    expect(notice()).toBe("");

    // Now from a model whose only overlap is gone: stored "high" on a model with
    // only [low] — switch to a synthesized minimal-only entry via fresh render.
    const limited = {
      ok: true,
      data: {
        ...GET_OK.data,
        modelKey: "anthropic/claude-sonnet",
        effort: "max",
        models: GET_OK.data.models.map((m) =>
          m.key === "minimax-cn/MiniMax-M3" ? { ...m, levels: ["low"] } : m,
        ),
      },
    };
    const again = await renderAdvisor(limited);
    again.modelSelect.value = "minimax-cn/MiniMax-M3";
    again.modelSelect.dispatchEvent(new Event("change"));
    expect(again.effortSelect.value).toBe("");
    expect(again.notice()).toContain("reset to off");
    await vi.waitFor(() => expect(again.status()).toBe("Saved."));
    const payload = again.calls.find((c) => c.op === "advisor.config.set").params;
    expect(payload).toEqual({ modelKey: "minimax-cn/MiniMax-M3", effort: null });
    expect(calls.length).toBeGreaterThan(0); // first render scenario also active
  });

  it("effort change saves immediately; gateway rejection surfaces the error", async () => {
    let failNext = false;
    const { effortSelect, status } = await renderAdvisor((op) =>
      op === "advisor.config.set" && failNext
        ? Promise.resolve({ ok: false, error: "disk full" })
        : Promise.resolve(GET_OK),
    );
    effortSelect.value = "max";
    effortSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status()).toBe("Saved."));

    failNext = true;
    effortSelect.value = "low";
    effortSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status()).toBe("Save failed: disk full"));
  });

  it("a failed model change rolls both selects back to the last confirmed save", async () => {
    const { modelSelect, effortSelect, status, notice } = await renderAdvisor((op) =>
      op === "advisor.config.set"
        ? Promise.resolve({ ok: false, error: "EACCES" })
        : Promise.resolve(GET_OK),
    );
    modelSelect.value = "minimax-cn/MiniMax-M3";
    modelSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status()).toContain("EACCES"));
    // Model rolled back; effort options rebuilt for the restored model with its value restored.
    expect(modelSelect.value).toBe("anthropic/claude-sonnet");
    expect([...effortSelect.options].map((o) => o.value)).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(effortSelect.value).toBe("high");
    expect(notice()).toBe("");
  });

  it("a rejected set (not just {ok:false}) also rolls back", async () => {
    const { effortSelect, status } = await renderAdvisor((op) =>
      op === "advisor.config.set"
        ? Promise.reject(new Error("bridge gone"))
        : Promise.resolve(GET_OK),
    );
    effortSelect.value = "low";
    effortSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status()).toContain("bridge gone"));
    expect(effortSelect.value).toBe("high");
  });

  it("get rejection renders the error into the status line", async () => {
    const gateway = { call: () => Promise.reject(new Error("no active session")) };
    const detailEl = detailWith();
    renderExtensionSettings(
      detailEl,
      { source: "npm:@juicesharp/rpiv-advisor" },
      { configGateway: gateway },
    );
    await vi.waitFor(() =>
      expect(detailEl.querySelector(".pkg-ext-status").textContent).toContain("no active session"),
    );
  });
});

describe("fff renderer", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const FFF_OK = {
    values: {
      mode: "override",
      frecencyDbPath: null,
      historyDbPath: null,
      enableFsRootScanning: false,
      enableHomeDirScanning: false, // shadowed by env below
      warnOnHomeDirScan: true,
      followSymlinks: true,
    },
    envShadowed: ["enableHomeDirScanning"],
    flagShadowed: [],
    shadowNames: { enableHomeDirScanning: "FFF_ENABLE_HOME_SCAN" },
  };

  function fffTransport(overrides = {}) {
    const calls = [];
    return {
      calls,
      getFffConfig() {
        calls.push({ method: "getFffConfig", payload: null });
        return Promise.resolve(overrides.get ?? FFF_OK);
      },
      setFffConfig(payload) {
        calls.push({ method: "setFffConfig", payload });
        if (overrides.setError) return Promise.reject(new Error(overrides.setError));
        return Promise.resolve({ config: {} });
      },
    };
  }

  async function renderFff(transport) {
    const detailEl = document.createElement("div");
    // Transport only, no config gateway — the landing-page scenario.
    renderExtensionSettings(detailEl, { source: "npm:@ff-labs/pi-fff" }, { transport });
    await vi.waitFor(() => {
      // Healthy state mounts the segmented control; the invalid state mounts
      // the error block instead — either means the section is up.
      if (!detailEl.querySelector(".pkg-ext-segment") && !detailEl.querySelector(".pkg-ext-error"))
        throw new Error("section not mounted");
    });
    return detailEl;
  }

  function setCalls(gateway) {
    return gateway.calls.filter((c) => c.method === "setFffConfig");
  }

  it("renders with transport only (landing) — mode segmented control, toggles, advanced paths", async () => {
    const detailEl = await renderFff(fffTransport());
    expect(detailEl.textContent).toContain("pi-fff");
    expect(detailEl.textContent).toContain("restarting Picot");
    const segs = [...detailEl.querySelectorAll(".pkg-ext-segment-btn")];
    expect(segs.map((b) => b.classList.contains("is-on"))).toEqual([false, false, true]);
    expect(detailEl.querySelector(".pkg-ext-desc").textContent).toContain("Replaces");
    const switches = [...detailEl.querySelectorAll('[role="switch"]')];
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
      "true",
    ]);
    const inputs = detailEl.querySelectorAll(".pkg-ext-advanced input");
    expect(inputs.length).toBe(2);
    expect(inputs[0].placeholder).toContain("fff-managed");
  });

  it("shadowed field is disabled with a badge naming the exact env var", async () => {
    const detailEl = await renderFff(fffTransport());
    const switches = [...detailEl.querySelectorAll('[role="switch"]')];
    expect(switches[1].disabled).toBe(true); // enableHomeDirScanning
    expect(detailEl.textContent).toContain("overridden by FFF_ENABLE_HOME_SCAN");
    expect(switches[0].disabled).toBe(false); // others unaffected
  });

  it("toggle click saves that single key and flips on success", async () => {
    const transport = fffTransport();
    const detailEl = await renderFff(transport);
    const switchBtn = detailEl.querySelector('[role="switch"]'); // root scanning
    switchBtn.click();
    await vi.waitFor(() => expect(setCalls(transport).length).toBe(1));
    expect(setCalls(transport)[0].payload).toEqual({
      key: "enableFsRootScanning",
      value: true,
    });
    await vi.waitFor(() => expect(switchBtn.classList.contains("is-on")).toBe(true));
  });

  it("mode click saves the new mode and updates the description", async () => {
    const transport = fffTransport();
    const detailEl = await renderFff(transport);
    const toolsOnly = [...detailEl.querySelectorAll(".pkg-ext-segment-btn")][1];
    toolsOnly.click();
    await vi.waitFor(() => expect(setCalls(transport).length).toBe(1));
    expect(setCalls(transport)[0].payload).toEqual({ key: "mode", value: "tools-only" });
    await vi.waitFor(() => expect(toolsOnly.classList.contains("is-on")).toBe(true));
    expect(detailEl.querySelector(".pkg-ext-desc").textContent).toContain("keeps pi's default");
  });

  it("path input change saves the path; empty change clears to null", async () => {
    const transport = fffTransport();
    const detailEl = await renderFff(transport);
    const input = detailEl.querySelector(".pkg-ext-advanced input");
    input.value = "/data/frec";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setCalls(transport).length).toBe(1));
    expect(setCalls(transport)[0].payload).toEqual({
      key: "frecencyDbPath",
      value: "/data/frec",
    });

    input.value = "   ";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(setCalls(transport).length).toBe(2));
    expect(setCalls(transport)[1].payload).toEqual({ key: "frecencyDbPath", value: null });
  });

  it("invalid config renders the error state; two-click reset rewrites and rebuilds", async () => {
    let reset = false;
    const calls = [];
    const transport = {
      calls,
      getFffConfig() {
        calls.push({ method: "getFffConfig", payload: null });
        return Promise.resolve(
          reset
            ? FFF_OK
            : {
                values: FFF_OK.values,
                envShadowed: [],
                flagShadowed: [],
                shadowNames: {},
                invalid: { reason: 'unknown option "stray"' },
              },
        );
      },
      setFffConfig(payload) {
        calls.push({ method: "setFffConfig", payload });
        if (payload?.reset === true) reset = true;
        return Promise.resolve({ config: {} });
      },
    };
    const detailEl = await renderFff(transport);
    expect(detailEl.textContent).toContain('unknown option "stray"');
    expect(detailEl.querySelector(".pkg-ext-segment")).toBeNull(); // read-only error state

    const resetBtn = detailEl.querySelector(".pkg-ext-btn-danger");
    resetBtn.click(); // arms the inline confirm
    expect(resetBtn.textContent).toContain("confirm");
    expect(setCalls(transport).length).toBe(0);
    resetBtn.click(); // executes
    await vi.waitFor(() => expect(setCalls(transport).length).toBe(1));
    expect(setCalls(transport)[0].payload).toEqual({ reset: true });
    await vi.waitFor(
      () => expect(detailEl.querySelector(".pkg-ext-segment")).not.toBeNull(), // rebuilt healthy
    );
  });

  it("a failed save surfaces the error and does not flip the toggle", async () => {
    const transport = fffTransport({ setError: "EACCES" });
    const detailEl = await renderFff(transport);
    const switchBtn = detailEl.querySelector('[role="switch"]');
    switchBtn.click();
    await vi.waitFor(() =>
      expect(detailEl.querySelector(".pkg-ext-status").textContent).toContain("EACCES"),
    );
    expect(switchBtn.classList.contains("is-on")).toBe(false);
  });

  it("a failed load renders the transport error into the status line", async () => {
    const transport = {
      getFffConfig: () => Promise.reject(new Error("host not ready")),
      setFffConfig: () => Promise.reject(new Error("unused")),
    };
    const detailEl = document.createElement("div");
    renderExtensionSettings(detailEl, { source: "npm:@ff-labs/pi-fff" }, { transport });
    await vi.waitFor(() =>
      expect(detailEl.querySelector(".pkg-ext-status").textContent).toContain("host not ready"),
    );
  });
});
