import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupThinkingEffortControl } from "./thinking-effort-control.js";

describe("setupThinkingEffortControl", () => {
  let runtime;
  let getTarget;
  let onError;
  let container;

  beforeEach(() => {
    runtime = {
      request: vi.fn().mockResolvedValue({
        response: { data: { levels: ["off", "minimal", "low", "medium", "high"] } },
      }),
    };
    getTarget = vi.fn().mockReturnValue({ sessionId: "test-session", instanceId: "test-instance" });
    onError = vi.fn();

    // Clear any existing elements
    document.body.innerHTML = "";

    // Setup DOM
    container = document.createElement("div");
    container.innerHTML = `
      <div class="thinking-effort" id="thinking-effort" role="radiogroup">
        <div class="thinking-effort-ends">
          <span>Faster</span>
          <span class="thinking-effort-name" id="thinking-effort-name">off</span>
          <span>Smarter</span>
        </div>
        <div class="thinking-effort-track">
          <span class="thinking-effort-thumb" id="thinking-effort-marker"></span>
          <input type="radio" class="thinking-effort-dot" data-level="off" name="thinking-effort-level" value="off" checked />
          <input type="radio" class="thinking-effort-dot" data-level="minimal" name="thinking-effort-level" value="minimal" />
          <input type="radio" class="thinking-effort-dot" data-level="low" name="thinking-effort-level" value="low" />
          <input type="radio" class="thinking-effort-dot" data-level="medium" name="thinking-effort-level" value="medium" />
          <input type="radio" class="thinking-effort-dot" data-level="high" name="thinking-effort-level" value="high" />
        </div>
      </div>
    `;
    document.body.appendChild(container);
  });

  it("persists the default level and applies it to the current session", async () => {
    const configGateway = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const control = setupThinkingEffortControl({ runtime, getTarget, configGateway, onError });
    expect(control).toBeTruthy();

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const lowButton = Array.from(buttons).find((btn) => btn.dataset.level === "low");

    lowButton.click();
    await vi.waitFor(() => {
      expect(configGateway.call).toHaveBeenCalledWith("set_default_thinking_level", {
        level: "low",
        scope: "global",
      });
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_thinking_level", level: "low" },
        { sessionId: "test-session", instanceId: "test-instance" },
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it("loads the saved default level from config", async () => {
    const configGateway = {
      call: vi.fn().mockResolvedValue({ ok: true, data: { level: "medium" } }),
    };

    setupThinkingEffortControl({ runtime, getTarget, configGateway, onError });

    await vi.waitFor(() => {
      expect(configGateway.call).toHaveBeenCalledWith("get_default_thinking_level", {
        scope: "global",
      });
      expect(document.getElementById("thinking-effort-name").textContent).toBe("medium");
    });

    // This control represents the persisted default, not the current
    // session's effective value. Session hydration must not feed its value
    // back through updateUI (for example, a non-reasoning provider reports
    // `off` while the saved default remains `medium`).
    expect(document.getElementById("thinking-effort-name").dataset.thinkingLevel).toBe("medium");
  });

  it("keeps the saved default without changing a session whose provider does not support it", async () => {
    runtime.request.mockResolvedValue({ response: { data: { levels: ["off"] } } });
    const configGateway = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const onRuntimeLevelChanged = vi.fn();
    setupThinkingEffortControl({
      runtime,
      getTarget,
      configGateway,
      onError,
      onRuntimeLevelChanged,
    });

    document.querySelector('[data-level="medium"]').click();

    await vi.waitFor(() => {
      expect(configGateway.call).toHaveBeenCalledWith("set_default_thinking_level", {
        level: "medium",
        scope: "global",
      });
      expect(document.getElementById("thinking-effort-name").textContent).toBe("medium");
    });
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "get_available_thinking_levels" },
      getTarget(),
    );
    expect(runtime.request).not.toHaveBeenCalledWith(
      { type: "set_thinking_level", level: "medium" },
      expect.anything(),
      expect.anything(),
    );
    expect(onRuntimeLevelChanged).not.toHaveBeenCalled();
  });

  it("updates UI when updateUI is called", () => {
    const control = setupThinkingEffortControl({ runtime, getTarget, onError });

    control.updateUI("medium");

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const mediumButton = Array.from(buttons).find((btn) => btn.dataset.level === "medium");
    const levelName = document.getElementById("thinking-effort-name");

    expect(mediumButton.checked).toBe(true);
    expect(levelName.textContent).toBe("medium");
  });

  it("handles keyboard navigation", async () => {
    setupThinkingEffortControl({ runtime, getTarget, onError });

    const radioGroup = document.getElementById("thinking-effort");
    const event = new KeyboardEvent("keydown", { key: "ArrowRight" });
    radioGroup.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_thinking_level", level: "minimal" },
        { sessionId: "test-session", instanceId: "test-instance" },
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it("keeps the saved default without reporting a global error when runtime sync fails", async () => {
    const error = new Error("Request failed");
    runtime.request.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    setupThinkingEffortControl({ runtime, getTarget, onError });

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const highButton = Array.from(buttons).find((btn) => btn.dataset.level === "high");

    highButton.click();

    try {
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          "[Native] Saved default thinking level but could not apply it to session:",
          error,
        );
      });
      expect(onError).not.toHaveBeenCalled();
      expect(document.getElementById("thinking-effort-name").textContent).toBe("high");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let a stale initial read overwrite a user change", async () => {
    let resolveInitialRead;
    const configGateway = {
      call: vi.fn((operation) => {
        if (operation === "get_default_thinking_level") {
          return new Promise((resolve) => {
            resolveInitialRead = resolve;
          });
        }
        return Promise.resolve({ ok: true });
      }),
    };
    setupThinkingEffortControl({ runtime, getTarget, configGateway, onError });

    document.querySelector('[data-level="high"]').click();
    await vi.waitFor(() => {
      expect(document.getElementById("thinking-effort-name").textContent).toBe("high");
    });

    resolveInitialRead({ ok: true, data: { level: "off" } });
    await Promise.resolve();
    expect(document.getElementById("thinking-effort-name").textContent).toBe("high");
  });
});

describe("thinking effort static shell contract", () => {
  it("labels the composer thinking control clearly while keeping button cycling", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document: shellDocument } = dom.window;
    const thinkingBtn = shellDocument.querySelector("#thinking-btn");

    expect(thinkingBtn.tagName).toBe("BUTTON");
    expect(thinkingBtn.textContent.trim()).toBe("Think off");
    expect(thinkingBtn.getAttribute("title")).toContain("Click to cycle");

    dom.window.close();
  });

  it("renders thinking effort in Settings as a Faster↔Smarter segmented slider", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document: shellDocument } = dom.window;
    const dots = Array.from(
      shellDocument.querySelectorAll("#thinking-effort-steps .thinking-effort-dot"),
    );

    expect(shellDocument.querySelector("#setting-thinking .settings-label-main")?.textContent).toBe(
      "Thinking effort",
    );
    expect(shellDocument.querySelector("#setting-thinking .settings-label-sub")?.textContent).toBe(
      "Reasoning depth",
    );
    expect(dots.map((s) => s.dataset.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
    const ends = Array.from(
      shellDocument.querySelectorAll(
        "#thinking-effort .thinking-effort-ends > span:not(.thinking-effort-name)",
      ),
    );
    expect(ends.map((e) => e.textContent.trim())).toEqual(["Faster", "Smarter"]);
    expect(shellDocument.querySelector("#thinking-effort-name")?.textContent.trim()).toBe("off");
    expect(shellDocument.querySelector("#thinking-effort-marker")).not.toBeNull();

    dom.window.close();
  });

  it("uses neutral styling for every thinking level chip state", () => {
    const headerCss = readFileSync(join(process.cwd(), "public/native/header.css"), "utf8");
    const composerCss = readFileSync(join(process.cwd(), "public/native/composer.css"), "utf8");
    const thinkingTagRule = headerCss.match(/\.thinking-tag\s*\{[^}]+\}/)?.[0] || "";
    const composerThinkingTagRule =
      composerCss.match(/\.composer-toolbar \.thinking-tag\s*\{[^}]+\}/)?.[0] || "";

    expect(thinkingTagRule).toContain("border: 1px solid var(--border)");
    expect(thinkingTagRule).not.toContain("--thinking-accent");
    expect(composerThinkingTagRule).toContain("border-color: transparent");
  });
});
