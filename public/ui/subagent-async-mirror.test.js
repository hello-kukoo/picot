// ABOUTME: Covers the subagent-async snapshot parser and mirror panel rendering rules.
// ABOUTME: Real RPC captures plus constructed variants; bad frames clear and hide, never leak JSON.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, setMessages } from "../i18n.js";
import { SubagentAsyncMirrorPanel } from "./subagent-async-mirror.js";
import { MAX_ROWS, parseSubagentAsyncLines, SNAPSHOT_STATES } from "./subagent-async-snapshot.js";
import { createWidgetMirrorRegistry, runtimeIdForTarget } from "./widget-mirror-registry.js";

const PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const KIND = "pi-subagents.async-status-snapshot";
const NOW = 1_790_778_500_000;
const LOCALES = ["en", "es", "ja", "zh"];
const localeMessages = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(process.cwd(), `public/locales/${locale}.json`), "utf8")),
  ]),
);
const en = localeMessages.en;
const realUpdate = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/subagent-async/set-widget-update.json"), "utf8"),
);
const realDelete = JSON.parse(
  readFileSync(join(process.cwd(), "tests/fixtures/subagent-async/set-widget-delete.json"), "utf8"),
);

function snapshot({ runs = [], omittedRuns = 0, omittedChildren = 0 } = {}) {
  return {
    kind: KIND,
    version: 1,
    generatedAt: NOW,
    caps: {
      maxRuns: 20,
      maxChildrenPerNode: 8,
      maxDepth: 3,
      maxStringLength: 160,
      maxSerializedBytes: 32768,
    },
    omitted: { runs: omittedRuns, children: omittedChildren, byteLimitExceeded: false },
    runs,
  };
}

function linesFor(value) {
  return [`${PREFIX}${JSON.stringify(value)}`];
}

function run(overrides = {}) {
  return {
    id: "r1",
    kind: "subagent",
    label: "worker",
    state: "running",
    startedAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

let host;

function mount() {
  return new SubagentAsyncMirrorPanel({ container: host });
}

/** Drives a real locale switch: i18n loads the locale, then notifies every listener. */
async function switchLocale(locale) {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => localeMessages[locale] }));
  try {
    await setLocale(locale);
  } finally {
    vi.unstubAllGlobals();
  }
}

function jobs() {
  return [...document.querySelectorAll(".subagent-async-panel__job")];
}

function detailText() {
  return jobs()[0]?.querySelector(".subagent-async-panel__detail")?.textContent ?? "";
}

describe("subagent-async mirror panel", () => {
  beforeEach(() => {
    setMessages(en);
    document.body.innerHTML = '<div class="input-area"><form></form></div>';
    host = document.querySelector(".input-area");
  });

  it("renders the real captured update frame above the composer", () => {
    const panel = mount();
    expect(panel.applyWidgetLines(realUpdate.widgetLines, NOW)).toBe(true);
    expect(panel.element.classList.contains("hidden")).toBe(false);
    expect(panel.element.previousElementSibling).toBeNull();
    expect(host.querySelector("form").previousElementSibling).toBe(panel.element);
    expect(panel.element.querySelector(".subagent-async-panel__title").textContent).toBe(
      "Background Tasks",
    );
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].dataset.state).toBe("running");
    expect(jobs()[0].querySelector(".subagent-async-panel__name").textContent).toBe("worker");
    expect(jobs()[0].querySelector(".subagent-async-panel__state").textContent).toBe("Running");
    expect(panel.element.querySelector(".subagent-async-panel__summary").textContent).toBe(
      "1 Running",
    );
    expect(parseSubagentAsyncLines(realUpdate.widgetLines)).not.toBeNull();
  });

  it("treats the real captured delete frame as hide-only and recovers on the next frame", () => {
    const panel = mount();
    panel.applyWidgetLines(realUpdate.widgetLines, NOW);
    expect(panel.applyWidgetLines(realDelete.widgetLines, NOW)).toBe(true);
    expect(panel.element.classList.contains("hidden")).toBe(true);
    expect(jobs()).toHaveLength(0);
    expect(panel.element.textContent).not.toContain(PREFIX);
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ label: "back" })] })), NOW);
    expect(jobs()).toHaveLength(1);
    expect(panel.element.textContent).toContain("back");
  });

  it("truncates to four rows, ignores children, and refreshes on new frames", () => {
    const runs = Array.from({ length: 6 }, (_, index) =>
      run({
        id: `r${index}`,
        label: `agent-${index}`,
        state: "queued",
        children: [{ id: "c", label: "child-secret", state: "complete" }],
      }),
    );
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs, omittedChildren: 9 })), NOW);
    expect(jobs()).toHaveLength(MAX_ROWS);
    expect([...panel.element.querySelector(".subagent-async-panel__list").children]).toEqual(
      jobs(),
    );
    expect(panel.element.querySelector(".subagent-async-panel__summary").textContent).toBe(
      "6 Queued",
    );
    expect(panel.element.querySelector(".subagent-async-panel__more").textContent).toBe(
      "+2 background tasks",
    );
    expect(panel.element.textContent).not.toContain("child-secret");
    panel.applyWidgetLines(linesFor(snapshot({ runs: runs.slice(0, 1) })), NOW);
    expect(jobs()).toHaveLength(1);
    expect(
      panel.element.querySelector(".subagent-async-panel__more").classList.contains("hidden"),
    ).toBe(true);
  });

  it("counts unshown valid roots plus sender-reported omitted runs only", () => {
    const runs = Array.from({ length: 5 }, (_, index) =>
      run({ id: `r${index}`, label: `a${index}` }),
    );
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs, omittedRuns: 2, omittedChildren: 9 })), NOW);
    expect(jobs()).toHaveLength(4);
    expect(panel.element.querySelector(".subagent-async-panel__more").textContent).toBe(
      "+3 background tasks",
    );
  });

  it("saturates the omitted count instead of overflowing the safe integer range", () => {
    const runs = Array.from({ length: MAX_ROWS + 3 }, (_, index) =>
      run({ id: `r${index}`, label: `a${index}` }),
    );
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs, omittedRuns: Number.MAX_SAFE_INTEGER })), NOW);
    expect(panel.element.querySelector(".subagent-async-panel__more").textContent).toBe(
      "+9007199254740991 background tasks",
    );
    expect(panel.element.textContent).not.toContain("9007199254740992");
  });

  it("keeps the panel with an unavailable-details summary when only omitted runs remain", () => {
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs: [], omittedRuns: 2 })), NOW);
    expect(panel.element.classList.contains("hidden")).toBe(false);
    expect(jobs()).toHaveLength(0);
    expect(panel.element.querySelector(".subagent-async-panel__summary").textContent).toBe(
      "2 background tasks · details unavailable",
    );
    expect(
      panel.element.querySelector(".subagent-async-panel__more").classList.contains("hidden"),
    ).toBe(true);
  });

  it("hides on empty snapshots and on snapshots without valid roots", () => {
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs: [] })), NOW);
    expect(panel.element.classList.contains("hidden")).toBe(true);
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run()] })), NOW);
    expect(panel.element.classList.contains("hidden")).toBe(false);
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [
            { label: 7, state: "running" },
            { label: "x", state: "exploded" },
          ],
        }),
      ),
      NOW,
    );
    expect(panel.element.classList.contains("hidden")).toBe(true);
    expect(jobs()).toHaveLength(0);
    // Negated optional counts are not valid either.
    panel.applyWidgetLines(linesFor(snapshot({ runs: [], omittedRuns: -1 })), NOW);
    expect(panel.element.classList.contains("hidden")).toBe(true);
  });

  it("overlays the attention badge without replacing the main status", () => {
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(snapshot({ runs: [run({ activity: { state: "needs_attention" } })] })),
      NOW,
    );
    const job = jobs()[0];
    expect(job.querySelector(".subagent-async-panel__state").textContent).toBe("Running");
    expect(job.querySelector(".subagent-async-panel__attention").textContent).toContain(
      "Needs attention",
    );
    for (const state of ["active_long_running", "active", "wat"]) {
      panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ activity: { state } })] })), NOW);
      expect(jobs()[0].querySelector(".subagent-async-panel__attention")).toBeNull();
      expect(jobs()[0].querySelector(".subagent-async-panel__state").textContent).toBe("Running");
    }
  });

  it("computes elapsed from the snapshot only and omits invalid values", () => {
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [
            run({
              state: "complete",
              startedAt: NOW - 60_000,
              updatedAt: NOW - 5_000,
              endedAt: NOW - 30_000,
            }),
          ],
        }),
      ),
      NOW,
    );
    expect(detailText()).toContain("30s elapsed");
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [run({ state: "complete", startedAt: NOW - 60_000, updatedAt: NOW - 45_000 })],
        }),
      ),
      NOW,
    );
    expect(detailText()).toContain("15s elapsed");
    panel.applyWidgetLines(
      linesFor(snapshot({ runs: [run({ state: "running", startedAt: NOW - 20_000 })] })),
      NOW,
    );
    expect(detailText()).toContain("20s elapsed");
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [run({ state: "complete", startedAt: NOW - 10_000, endedAt: NOW - 10_000 })],
        }),
      ),
      NOW,
    );
    expect(detailText()).toContain("0s elapsed");
    panel.applyWidgetLines(
      linesFor(
        snapshot({ runs: [run({ state: "complete", startedAt: NOW, endedAt: NOW - 10_000 })] }),
      ),
      NOW,
    );
    expect(detailText()).not.toContain("elapsed");
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ startedAt: "soon" })] })), NOW);
    expect(detailText()).not.toContain("elapsed");
  });

  it("shows current tool, tool runtime, turns and tool calls when present", () => {
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [
            run({
              activity: {
                currentTool: "grep",
                currentToolStartedAt: NOW - 12_500,
                turnCount: 6,
                toolCount: 14,
              },
            }),
          ],
        }),
      ),
      NOW,
    );
    const detail = detailText();
    expect(detail).toContain("Tool grep");
    expect(detail).toContain("running 12s");
    expect(detail).toContain("6 turns");
    expect(detail).toContain("14 tool calls");
    panel.applyWidgetLines(
      linesFor(snapshot({ runs: [run({ activity: { turnCount: 0, toolCount: 0 } })] })),
      NOW,
    );
    expect(detailText()).toContain("0 turns");
    expect(detailText()).toContain("0 tool calls");
  });

  it("keeps the rendered text stable without a timer between frames", () => {
    vi.useFakeTimers();
    try {
      const panel = mount();
      panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ startedAt: NOW - 20_000 })] })), NOW);
      const before = detailText();
      vi.advanceTimersByTime(60_000);
      expect(detailText()).toBe(before);
      expect(before).toContain("20s elapsed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits only the optional fields whose types are wrong", () => {
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [
            run({
              state: "complete",
              endedAt: NOW,
              activity: { turnCount: "3", toolCount: 4, currentTool: 9, currentToolStartedAt: "x" },
            }),
          ],
        }),
      ),
      NOW,
    );
    const detail = detailText();
    expect(detail).toContain("4 tool calls");
    expect(detail).toContain("10s elapsed");
    expect(detail).not.toContain("turns");
    expect(detail).not.toContain("Tool");
  });

  it("clears and hides on malformed frames without leaking raw JSON", () => {
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run()] })), NOW);
    expect(jobs()).toHaveLength(1);
    const tooLong = linesFor(snapshot({ runs: [run({ label: "x".repeat(40_000) })] }))[0];
    const badFrames = [
      undefined,
      null,
      "raw",
      [1],
      {},
      [],
      [`not-prefixed:${JSON.stringify(snapshot({ runs: [run()] }))}`],
      [linesFor(snapshot({ runs: [run()] }))[0], "extra"],
      [`${PREFIX}{oops`],
      [`${PREFIX}[1,2]`],
      linesFor({ ...snapshot({ runs: [run()] }), kind: "other.kind" }),
      linesFor({ ...snapshot({ runs: [run()] }), version: 2 }),
      linesFor({ ...snapshot({ runs: [run()] }), runs: "none" }),
      [tooLong],
      linesFor(snapshot({ runs: [run({ label: "中".repeat(11_000) })] })),
    ];
    for (const value of badFrames) {
      expect(panel.applyWidgetLines(value, NOW)).toBe(true);
      expect(panel.element.classList.contains("hidden")).toBe(true);
      expect(jobs()).toHaveLength(0);
      expect(panel.element.textContent).not.toContain(PREFIX);
      expect(panel.element.textContent).not.toContain("oops");
    }
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ label: "back" })] })), NOW);
    expect(jobs()).toHaveLength(1);
    expect(panel.element.textContent).toContain("back");
  });

  it("maps every known state to its label and drops unknown states", () => {
    const panel = mount();
    for (const state of SNAPSHOT_STATES) {
      panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ state })] })), NOW);
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0].dataset.state).toBe(state);
      expect(jobs()[0].querySelector(".subagent-async-panel__state").textContent).toBe(
        en.subagentAsync.state[state],
      );
    }
    panel.applyWidgetLines(linesFor(snapshot({ runs: [run({ state: "exploded" })] })), NOW);
    expect(jobs()).toHaveLength(0);
    expect(panel.element.classList.contains("hidden")).toBe(true);
  });

  it("renders labels and current tools as text, never as markup", () => {
    const panel = mount();
    const label = "<img src=x onerror=alert(1)>";
    panel.applyWidgetLines(
      linesFor(
        snapshot({ runs: [run({ label, activity: { currentTool: "<img src=x onerror=1>" } })] }),
      ),
      NOW,
    );
    const name = jobs()[0].querySelector(".subagent-async-panel__name");
    expect(name.textContent).toBe(label);
    expect(name.title).toBe(label);
    expect(detailText()).toContain("Tool <img src=x onerror=1>");
    expect(panel.element.querySelector("img")).toBeNull();
  });

  it("ships every visible string in all four locales", () => {
    for (const locale of LOCALES) {
      const messages = localeMessages[locale].subagentAsync;
      for (const key of [
        "title",
        "attention",
        "summary",
        "more",
        "currentTool",
        "turns",
        "toolCalls",
        "elapsed",
        "toolElapsed",
        "seconds",
      ]) {
        expect(messages?.[key], `${locale}.subagentAsync.${key}`).toBeTruthy();
      }
      for (const state of SNAPSHOT_STATES) {
        expect(messages?.state?.[state], `${locale}.subagentAsync.state.${state}`).toBeTruthy();
      }
    }
  });

  it("renders localized copy for the active locale", () => {
    setMessages(localeMessages.zh);
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(
        snapshot({
          runs: [
            run({
              activity: { state: "needs_attention", currentTool: "grep", turnCount: 3 },
            }),
          ],
        }),
      ),
      NOW,
    );
    expect(panel.element.querySelector(".subagent-async-panel__title").textContent).toBe(
      "后台任务",
    );
    expect(jobs()[0].querySelector(".subagent-async-panel__state").textContent).toBe("运行中");
    expect(jobs()[0].querySelector(".subagent-async-panel__attention").textContent).toContain(
      "需关注",
    );
    expect(panel.element.querySelector(".subagent-async-panel__summary").textContent).toBe(
      "1 运行中",
    );
    expect(detailText()).toContain("工具 grep");
    expect(detailText()).toContain("3 轮");
  });

  it("re-renders every translated string after a locale switch without a new frame", async () => {
    const panel = mount();
    const runs = Array.from({ length: 7 }, (_, index) =>
      run({
        id: `r${index}`,
        label: `agent-${index}`,
        activity:
          index === 0 ? { state: "needs_attention", currentTool: "grep", turnCount: 3 } : undefined,
      }),
    );
    panel.applyWidgetLines(linesFor(snapshot({ runs })), NOW);
    expect(panel.element.querySelector(".subagent-async-panel__title").textContent).toBe(
      "Background Tasks",
    );
    expect(panel.element.getAttribute("aria-label")).toBe("Background Tasks");

    await switchLocale("zh");

    expect(panel.element.querySelector(".subagent-async-panel__title").textContent).toBe(
      "后台任务",
    );
    expect(panel.element.getAttribute("aria-label")).toBe("后台任务");
    expect(panel.element.querySelector(".subagent-async-panel__summary").textContent).toBe(
      "7 运行中",
    );
    expect(jobs()[0].querySelector(".subagent-async-panel__state").textContent).toBe("运行中");
    expect(jobs()[0].querySelector(".subagent-async-panel__attention").textContent).toContain(
      "需关注",
    );
    expect(panel.element.querySelector(".subagent-async-panel__more").textContent).toBe(
      "+3 个后台任务",
    );
    expect(detailText()).toContain("工具 grep");
    expect(detailText()).toContain("3 轮");
  });

  it("relocalizes the details-unavailable summary without a new frame", async () => {
    const panel = mount();
    panel.applyWidgetLines(linesFor(snapshot({ runs: [], omittedRuns: 2 })), NOW);
    const summary = panel.element.querySelector(".subagent-async-panel__summary");
    expect(summary.textContent).toBe("2 background tasks · details unavailable");
    await switchLocale("zh");
    expect(summary.textContent).toBe("2 个后台任务 · 详情不可用");
    panel.destroy();
  });

  it("stops reacting to locale changes after destroy", async () => {
    const panel = mount();
    panel.applyWidgetLines(
      linesFor(snapshot({ runs: [run({ activity: { currentTool: "grep" } })] })),
      NOW,
    );
    const summary = panel.element.querySelector(".subagent-async-panel__summary");
    expect(summary.textContent).toBe("1 Running");

    panel.destroy();
    panel.destroy();
    await switchLocale("es");

    expect(summary.textContent).toBe("1 Running");
    expect(panel.element.querySelector(".subagent-async-panel__title").textContent).toBe(
      "Background Tasks",
    );
  });
});

describe("subagent-async app.js wiring", () => {
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");

  beforeEach(() => {
    setMessages(en);
    document.body.innerHTML = '<div class="input-area"><form></form></div>';
  });

  it("registers a state-owning renderer with no replay and no notify routing", () => {
    const block = appJs.match(
      /widgetMirrorRegistry\.registerRenderer\(\{(?:(?!registerRenderer)[\s\S])*?widgetKey: "subagent-async"[\s\S]*?\n\}\);/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toContain("toolNames: []");
    expect(block).toContain("new SubagentAsyncMirrorPanel(");
    expect(block).not.toContain("replay:");
    expect(block).not.toContain("matchesNotify:");
    expect(readFileSync(join(process.cwd(), "public/index.html"), "utf8")).toContain(
      'href="ui/subagent-async-mirror.css"',
    );
  });

  it("isolates real panels by runtime, clears bad frames, and restores valid snapshots", () => {
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    registry.registerRenderer({
      widgetKey: "subagent-async",
      toolNames: [],
      createPanel: ({ container, widgetPlacement }) =>
        new SubagentAsyncMirrorPanel({ container, widgetPlacement }),
    });
    const a = runtimeIdForTarget({ workspaceId: "w", sessionId: "a" });
    const b = runtimeIdForTarget({ workspaceId: "w", sessionId: "b" });
    registry.handleRuntimeChange(a);
    registry.handleWidgetRequest(realUpdate, a);
    registry.handleWidgetRequest(
      {
        method: "setWidget",
        widgetKey: "subagent-async",
        widgetLines: linesFor(snapshot({ runs: [run({ label: "runtime-b" })] })),
      },
      b,
    );
    const aPanel = registry.getPanel("subagent-async", a);
    const bPanel = registry.getPanel("subagent-async", b);
    expect(aPanel.element.textContent).toContain("worker");
    expect(bPanel.element.classList.contains("widget-mirror-runtime-hidden")).toBe(true);
    registry.handleRuntimeChange(b);
    expect(aPanel.element.classList.contains("widget-mirror-runtime-hidden")).toBe(true);
    expect(bPanel.element.textContent).toContain("runtime-b");
    expect(
      registry.handleWidgetRequest(
        { method: "setWidget", widgetKey: "subagent-async", widgetLines: [1] },
        b,
      ),
    ).toBe(true);
    expect(bPanel.element.classList.contains("hidden")).toBe(true);
    expect(bPanel.element.textContent).not.toContain(PREFIX);
    registry.handleRuntimeChange(a);
    expect(aPanel.element.classList.contains("widget-mirror-runtime-hidden")).toBe(false);
    expect(aPanel.element.textContent).toContain("worker");
    registry.handleWidgetRequest(realUpdate, b);
    expect(bPanel.element.classList.contains("hidden")).toBe(false);
  });

  it("delivers real frames to that panel shape through the registry", () => {
    const registry = createWidgetMirrorRegistry({
      container: document.querySelector(".input-area"),
    });
    registry.registerRenderer({
      widgetKey: "subagent-async",
      toolNames: [],
      createPanel: ({ container, widgetPlacement }) =>
        new SubagentAsyncMirrorPanel({ container, widgetPlacement }),
    });
    const runtime = runtimeIdForTarget({ workspaceId: "w", sessionId: "s" });
    expect(registry.handleWidgetRequest(realUpdate, runtime)).toBe(true);
    expect(jobs()).toHaveLength(1);
    expect(registry.handleWidgetRequest(realDelete, runtime)).toBe(true);
    expect(document.querySelector(".subagent-async-panel")).toBeNull();
  });
});
