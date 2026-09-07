import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderThinkingEffort, setupSettingsToggles } from "./toggles.js";

describe("thinking effort cycle controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  test("labels the composer thinking control clearly while keeping button cycling", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const thinkingBtn = document.querySelector("#thinking-btn");

    expect(thinkingBtn.tagName).toBe("BUTTON");
    expect(thinkingBtn.textContent.trim()).toBe("Think off");
    expect(thinkingBtn.getAttribute("title")).toContain("Click to cycle");
  });

  test("renders thinking effort in Settings as a Faster↔Smarter segmented slider", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const dots = Array.from(
      document.querySelectorAll("#thinking-effort-steps .thinking-effort-dot"),
    );

    expect(document.querySelector("#setting-thinking .settings-label-main")?.textContent).toBe(
      "Thinking effort",
    );
    expect(document.querySelector("#setting-thinking .settings-label-sub")?.textContent).toBe(
      "Reasoning depth",
    );
    expect(dots.map((s) => s.dataset.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
    const ends = Array.from(
      document.querySelectorAll(
        "#thinking-effort .thinking-effort-ends > span:not(.thinking-effort-name)",
      ),
    );
    expect(ends.map((e) => e.textContent.trim())).toEqual(["Faster", "Smarter"]);
    expect(document.querySelector("#thinking-effort-name")?.textContent.trim()).toBe("off");
    expect(document.querySelector("#thinking-effort-marker")).not.toBeNull();
  });

  test("sets the thinking level when a dot is clicked and moves the thumb", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const thumb = document.querySelector("#thinking-effort-marker");
    const rpcCommand = vi.fn().mockResolvedValue({
      success: true,
      data: { level: "medium" },
    });
    const setDefaultThinkingLevel = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: thumb,
      toggleShowThinking: null,
      rpcCommand,
      getDefaultThinkingLevel: () => "medium",
      setDefaultThinkingLevel,
    });

    const mediumDot = track.querySelector('[data-level="medium"]');
    mediumDot.click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledWith({
      type: "set_default_thinking_level",
      level: "medium",
    });
    expect(setDefaultThinkingLevel).toHaveBeenCalledWith("medium");

    expect(mediumDot.classList.contains("active")).toBe(true);
    expect(mediumDot.getAttribute("aria-checked")).toBe("true");
    // Thumb over segment index 3 of 5 → left = calc(60% + 3px), width = calc(20% - 6px).
    expect(thumb.style.left).toBe("calc(60% + 3px)");
    expect(thumb.style.width).toBe("calc(20% - 6px)");
  });

  test("keeps Settings levels fixed when the active model reports different levels", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const rpcCommand = vi.fn().mockResolvedValue({
      success: true,
      data: { level: "high" },
    });

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: document.querySelector("#thinking-effort-marker"),
      thinkingName: document.querySelector("#thinking-effort-name"),
      toggleShowThinking: null,
      rpcCommand,
      getDefaultThinkingLevel: () => "medium",
    });

    track.querySelector('[data-level="medium"]').click();
    await Promise.resolve();

    expect(
      Array.from(track.querySelectorAll(".thinking-effort-dot")).map((dot) => dot.dataset.level),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  test("applies a saved default thinking level to the live session when the model supports it", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: { level: "high" } })
      .mockResolvedValueOnce({ success: true, data: { levels: ["off", "low", "high"] } })
      .mockResolvedValueOnce({ success: true, data: { level: "high" } });
    const onRuntimeLevelChanged = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: document.querySelector("#thinking-effort-marker"),
      thinkingName: document.querySelector("#thinking-effort-name"),
      toggleShowThinking: null,
      rpcCommand,
      getDefaultThinkingLevel: () => "medium",
      onRuntimeLevelChanged,
    });

    track.querySelector('[data-level="high"]').click();
    // The handler chains three awaited RPCs (save default → probe levels →
    // apply); a single microtask tick can't observe all of them.
    await vi.waitFor(() => expect(onRuntimeLevelChanged).toHaveBeenCalledWith("high"));

    expect(rpcCommand).nthCalledWith(1, { type: "set_default_thinking_level", level: "high" });
    expect(rpcCommand).nthCalledWith(2, { type: "get_available_thinking_levels" });
    expect(rpcCommand).nthCalledWith(3, { type: "set_thinking_level", level: "high" });
  });

  test("skips applying the saved level when the active model does not support it", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: { level: "high" } })
      .mockResolvedValueOnce({ success: true, data: { levels: ["off", "medium"] } });
    const onRuntimeLevelChanged = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: document.querySelector("#thinking-effort-marker"),
      thinkingName: document.querySelector("#thinking-effort-name"),
      toggleShowThinking: null,
      rpcCommand,
      getDefaultThinkingLevel: () => "medium",
      onRuntimeLevelChanged,
    });

    track.querySelector('[data-level="high"]').click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledTimes(2);
    expect(rpcCommand).not.toHaveBeenCalledWith({ type: "set_thinking_level", level: "high" });
    expect(onRuntimeLevelChanged).not.toHaveBeenCalled();
  });

  test("marks a user level pick so one stale settings snapshot can be skipped", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: { level: "medium" } });

    const toggles = setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: document.querySelector("#thinking-effort-marker"),
      thinkingName: document.querySelector("#thinking-effort-name"),
      toggleShowThinking: null,
      rpcCommand,
      getDefaultThinkingLevel: () => "medium",
    });

    // No user pick yet — a settings-open snapshot is safe to apply.
    expect(toggles.takeUserChangedLevel()).toBe(false);

    track.querySelector('[data-level="medium"]').click();
    await Promise.resolve();

    // The pick is visible once (skip the stale in-flight snapshot) …
    expect(toggles.takeUserChangedLevel()).toBe(true);
    // … and the marker resets, so later snapshots sync normally again.
    expect(toggles.takeUserChangedLevel()).toBe(false);
  });

  test("renderThinkingEffort highlights the active level and positions the thumb", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const track = document.querySelector("#thinking-effort-steps");
    const thumb = document.querySelector("#thinking-effort-marker");
    const name = document.querySelector("#thinking-effort-name");

    renderThinkingEffort("high", {
      thinkingSteps: track,
      thinkingMarker: thumb,
      thinkingName: name,
    });

    expect(track.querySelector('[data-level="high"]').classList.contains("active")).toBe(true);
    // segment index 4 of 5 → left = calc(80% + 3px).
    expect(thumb.style.left).toBe("calc(80% + 3px)");
    expect(name.textContent).toBe("high");
  });

  test("uses neutral styling for every thinking level chip state", () => {
    const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");
    const thinkingTagRule = css.match(/\.thinking-tag\s*\{[^}]+\}/)?.[0] || "";
    const composerThinkingTagRule =
      css.match(/\.composer-toolbar \.thinking-tag\s*\{[^}]+\}/)?.[0] || "";

    expect(thinkingTagRule).toContain("border: 1px solid var(--border)");
    expect(thinkingTagRule).toContain("color: var(--text-dim)");
    expect(thinkingTagRule).not.toContain("--thinking-accent");
    expect(composerThinkingTagRule).toContain("border-color: transparent");
  });
});

describe("agent settings dual-track persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeDom() {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    vi.stubGlobal("localStorage", dom.window.localStorage);
    return dom.window.document;
  }

  test("persists auto-compaction to the session and Pi's global settings", async () => {
    const document = makeDom();
    const toggleAutoCompact = document.querySelector("#toggle-auto-compact");
    toggleAutoCompact.className = "settings-toggle on";
    const rpcCommand = vi.fn().mockResolvedValue({ success: true });

    setupSettingsToggles({
      toggleAutoCompact,
      thinkingSteps: null,
      thinkingMarker: null,
      thinkingName: null,
      toggleShowThinking: null,
      rpcCommand,
    });
    toggleAutoCompact.click();
    await vi.waitFor(() => expect(rpcCommand).toHaveBeenCalledTimes(2));

    // Session takes effect immediately; the global default lands in Pi's
    // settings.json so new sessions inherit it.
    expect(rpcCommand).toHaveBeenCalledWith({ type: "set_auto_compaction", enabled: false });
    expect(rpcCommand).toHaveBeenCalledWith({
      type: "set_default_auto_compaction",
      enabled: false,
    });
  });

  test("skips the global settings write when the session RPC fails", async () => {
    const document = makeDom();
    const toggleAutoCompact = document.querySelector("#toggle-auto-compact");
    toggleAutoCompact.className = "settings-toggle on";
    const rpcCommand = vi.fn().mockRejectedValue(new Error("down"));

    setupSettingsToggles({
      toggleAutoCompact,
      thinkingSteps: null,
      thinkingMarker: null,
      thinkingName: null,
      toggleShowThinking: null,
      rpcCommand,
    });
    toggleAutoCompact.click();
    await vi.waitFor(() => expect(toggleAutoCompact.classList.contains("on")).toBe(true));

    // Session RPC fired once; the global write never ran.
    expect(rpcCommand).toHaveBeenCalledTimes(1);
  });

  test("persists the picked thinking level to the DB after a successful save", async () => {
    const document = makeDom();
    const track = document.querySelector("#thinking-effort-steps");
    const rpcCommand = vi.fn().mockResolvedValue({
      success: true,
      data: { level: "high" },
    });
    const persistThinkingLevel = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: document.querySelector("#thinking-effort-marker"),
      thinkingName: document.querySelector("#thinking-effort-name"),
      toggleShowThinking: null,
      rpcCommand,
      persistThinkingLevel,
    });
    track.querySelector('[data-level="high"]').click();
    await vi.waitFor(() => expect(persistThinkingLevel).toHaveBeenCalledWith("high"));
  });

  test("persists show-thinking to the DB on toggle", () => {
    const document = makeDom();
    const toggleShowThinking = document.querySelector("#toggle-show-thinking");
    toggleShowThinking.className = "settings-toggle on";
    const rpcCommand = vi.fn();
    const persistShowThinking = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: null,
      thinkingMarker: null,
      thinkingName: null,
      toggleShowThinking,
      rpcCommand,
      persistShowThinking,
    });
    toggleShowThinking.click();

    expect(persistShowThinking).toHaveBeenCalledWith(false);
  });
});
