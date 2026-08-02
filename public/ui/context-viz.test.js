// ABOUTME: Verifies the context popover reflects the asynchronous compaction lifecycle.
// ABOUTME: Keeps stale context details visible until a successful lifecycle completion invalidates usage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { setupContextViz } from "./context-viz.js";

beforeEach(() => {
  document.body.innerHTML = `
    <button id="usage"></button>
    <div id="viz" class="hidden"><div id="bar"></div><div id="legend"></div><span id="used"></span><span id="total"></span><button id="context-viz-compact">Compact</button></div>`;
  setMessages({
    context: {
      cached: "Cached",
      input: "Input",
      available: "Available",
      tooltip: "{label}: {tokens}",
      used: "{pct}% used",
    },
    status: { compacting: "Compacting..." },
    misc: { compact: "Compact" },
  });
});

function makeViz({
  requestCompact = vi.fn(),
  state = "idle",
  usage = { input: 80, cacheRead: 20 },
} = {}) {
  let currentState = state;
  const api = setupContextViz({
    tokenUsageEl: document.getElementById("usage"),
    contextViz: document.getElementById("viz"),
    contextBar: document.getElementById("bar"),
    contextLegend: document.getElementById("legend"),
    contextVizUsed: document.getElementById("used"),
    contextVizTotal: document.getElementById("total"),
    getUsage: () => usage,
    getContextWindowSize: () => 100,
    requestCompact,
    getCompactState: () => currentState,
  });
  return {
    api,
    requestCompact,
    setState: (next) => {
      currentState = next;
      api.sync();
    },
  };
}

describe("context compact action", () => {
  it("keeps the popover open and disables Compact while the request is busy", () => {
    const { requestCompact, setState } = makeViz();
    document.getElementById("usage").click();
    document.getElementById("context-viz-compact").click();

    expect(requestCompact).toHaveBeenCalledTimes(1);
    setState("requested");
    const button = document.getElementById("context-viz-compact");
    expect(document.getElementById("viz").classList.contains("hidden")).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Compacting...");
  });

  it("closes and clears stale details only after successful usage invalidation", () => {
    const { api } = makeViz({ usage: null });
    document.getElementById("usage").click();
    expect(document.getElementById("viz").classList.contains("hidden")).toBe(false);

    api.invalidateUsage();

    expect(document.getElementById("viz").classList.contains("hidden")).toBe(true);
    expect(document.getElementById("bar").children).toHaveLength(0);
    expect(document.getElementById("legend").children).toHaveLength(0);
  });
});
