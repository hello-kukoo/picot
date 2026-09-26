// @vitest-environment jsdom
// ABOUTME: Pins the header session-aggregate lifecycle: aggregate totals only hydrate
// ABOUTME: from authoritative stats and live completions; current context is independent.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMessages } from "../i18n.js";
import { createHeaderStatusBar } from "./header-status-bar.js";

beforeEach(() => {
  document.body.replaceChildren(
    Object.assign(document.createElement("span"), { id: "session-usage" }),
    Object.assign(document.createElement("span"), { id: "token-usage" }),
  );
  setMessages({
    usage: {
      contextTitle: "Context usage",
      contextTokens: "Context: {used}k / {limit}k",
    },
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

function makeBar({ getContextWindowSize = () => 1000 } = {}) {
  return createHeaderStatusBar({
    sessionUsageEl: document.getElementById("session-usage"),
    tokenUsageEl: document.getElementById("token-usage"),
    getContextWindowSize,
  });
}

describe("createHeaderStatusBar aggregate lifecycle", () => {
  it("starts empty and exposes the documented surface", () => {
    const bar = makeBar();
    expect(typeof bar.applyLiveUsage).toBe("function");
    expect(typeof bar.hydrateSessionStats).toBe("function");
    expect(typeof bar.reset).toBe("function");
    expect(typeof bar.sync).toBe("function");
    expect(document.getElementById("session-usage").textContent).toBe("");
  });

  it("hydrates aggregate totals once and never from history replay", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
    });
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
    });
    const usage = document.getElementById("session-usage");
    const segments = usage.querySelectorAll(".composer-usage-seg");
    expect(segments.length).toBe(3);
    // Icon + bare number per segment; no IN/OUT/CACHE words.
    expect(segments[0].textContent).toContain("100");
    expect(segments[0].querySelector("svg")).toBeTruthy();
    expect(segments[1].textContent).toContain("50");
    expect(segments[1].querySelector("svg")).toBeTruthy();
    expect(segments[2].textContent).toContain("30");
    expect(segments[2].querySelector("svg")).toBeTruthy();
  });

  it("accumulates only newly received live usage after hydration", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
    });
    expect(
      bar.applyLiveUsage(
        {
          input: 40,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
        },
        { sessionFile: "/s/a.jsonl" },
      ),
    ).toBe(true);
    const usage = document.getElementById("session-usage");
    const segments = usage.querySelectorAll(".composer-usage-seg");
    expect(segments.length).toBe(3);
    expect(segments[0].textContent).toContain("140");
    expect(segments[1].textContent).toContain("70");
    expect(segments[2].textContent).toContain("40");
  });

  it("formats large aggregates with K/M suffixes", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/big.jsonl",
      tokens: { input: 1_500_000, output: 250_000, cacheRead: 3_200_000 },
    });
    const usage = document.getElementById("session-usage");
    const segments = usage.querySelectorAll(".composer-usage-seg");
    expect(segments.length).toBe(3);
    expect(segments[0].textContent).toContain("1.5M");
    expect(segments[1].textContent).toContain("250K");
    expect(segments[2].textContent).toContain("3.2M");
  });

  it("hides the cache segment when no tokens were cache-read", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 0 },
    });
    const segments = document
      .getElementById("session-usage")
      .querySelectorAll(".composer-usage-seg");
    expect(segments.length).toBe(2);
  });

  it("clears both aggregate and current context on reset for a new session", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
    });
    bar.reset();
    expect(document.getElementById("session-usage").textContent).toBe("");
  });

  it("ignores live usage without a confirmed identity", () => {
    const bar = makeBar();
    expect(bar.applyLiveUsage({ input: 40, output: 20 })).toBe(false);
    expect(document.getElementById("session-usage").textContent).toBe("");

    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30 },
    });
    expect(bar.applyLiveUsage({ input: 40, output: 20 }, { sessionFile: undefined })).toBe(false);
    expect(document.getElementById("session-usage").textContent).toContain("100");
    expect(document.getElementById("session-usage").textContent).not.toContain("140");
  });

  it("resets the aggregate to authoritative zero when tokens are null", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30 },
    });
    bar.hydrateSessionStats({ sessionFile: "/s/a.jsonl", tokens: null });
    expect(document.getElementById("session-usage").textContent).toBe("");
  });

  it("ignores a live usage that belongs to a different session than the hydrated one", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
    });
    bar.applyLiveUsage(
      { input: 40, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.01 } },
      { sessionFile: "/s/other.jsonl" },
    );
    const usage = document.getElementById("session-usage").textContent;
    expect(usage).toContain("100");
    expect(usage).not.toContain("140");
  });

  it("renders current-context percentage with warning/critical thresholds and can clear it independently", () => {
    const bar = makeBar({ getContextWindowSize: () => 1000 });
    bar.sync({ currentUsage: { input: 650, cacheRead: 0 } });
    const usageEl = document.getElementById("token-usage");
    expect(usageEl.classList.contains("warning")).toBe(true);
    bar.sync({ currentUsage: { input: 850, cacheRead: 0 } });
    expect(usageEl.classList.contains("critical")).toBe(true);
    // Compact success clears current context without touching aggregate totals.
    bar.sync({ currentUsage: null });
    expect(usageEl.classList.contains("warning")).toBe(false);
    expect(usageEl.classList.contains("critical")).toBe(false);
  });

  it("does not add threshold classes when the context window is unknown", () => {
    const bar = makeBar({ getContextWindowSize: () => 0 });
    bar.sync({ currentUsage: { input: 99999, cacheRead: 0 } });
    const usageEl = document.getElementById("token-usage");
    expect(usageEl.classList.contains("warning")).toBe(false);
    expect(usageEl.classList.contains("critical")).toBe(false);
  });
});
