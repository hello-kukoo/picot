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

describe("context popover anchoring", () => {
  it("centres the popover on the donut and clamps it into the viewport", () => {
    const { api } = makeViz();
    const viz = document.getElementById("viz");
    const donut = document.getElementById("usage");
    Object.defineProperty(viz, "offsetWidth", { configurable: true, get: () => 320 });
    Object.defineProperty(viz, "offsetHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });

    // Donut centred at x=500 (26px wide).
    let rect = { left: 487, right: 513, width: 26, top: 700, bottom: 726 };
    donut.getBoundingClientRect = () => rect;
    donut.click();
    expect(viz.classList.contains("hidden")).toBe(false);
    expect(viz.style.left).toBe("340px"); // 500 - 320/2
    expect(viz.style.right).toBe("auto");

    // Near the right edge the popover slides left instead of overflowing.
    donut.click(); // close
    rect = { left: 950, right: 976, width: 26, top: 700, bottom: 726 };
    donut.click();
    expect(viz.style.left).toBe("672px"); // 1000 - 320 - 8
    api.invalidateUsage();
  });
});

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
