// ABOUTME: Covers the Info panel's task analysis section: the report blocks,
// ABOUTME: history rebuild, copy-report and AI delegation.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../i18n.js";
import englishMessages from "../locales/en.json";
import { buildMarkdownReport, createSessionTaskAnalysis } from "./session-task-analysis.js";
import { analyzeTurns } from "./turn-analysis.js";
import { createTurnTraceRecorder } from "./turn-trace.js";

function step(kind, label, startedAt, durationMs, extra = {}) {
  return {
    kind,
    label,
    detail: extra.detail ?? "",
    toolNames: extra.toolNames ?? [],
    signature: extra.signature ?? `${label}|{}`,
    toolCallId: null,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    status: extra.status ?? "ok",
    error: extra.error ?? null,
    stopReason: null,
  };
}

function turn(index, status, steps, { startedAt = 0, endedAt = 10_000, error = null } = {}) {
  return {
    id: `turn-${index}`,
    index,
    prompt: "build it",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    status,
    error,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    steps,
  };
}

function mount(overrides = {}) {
  // The dialog portals itself to <body> (see session-task-analysis.js), so
  // clear the body first and mount the trigger there too; `el` is the body,
  // which then holds both the trigger and the dialog.
  document.body.replaceChildren();
  const section = createSessionTaskAnalysis({
    getTurns: () => [],
    t,
    ...overrides,
  });
  document.body.appendChild(section.element);
  return { section, el: document.body };
}

describe("session task analysis", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
    );
    await initI18n();
  });

  it("explains itself even before anything is recorded", () => {
    const { el } = mount();
    expect(el.textContent).toContain("Nothing to analyse in this session yet");
  });

  it("renders the verdict, findings and slowest steps for the last turn", () => {
    const { el } = mount({
      getTurns: () => [
        turn(
          1,
          "failed",
          [
            step("tool", "bash", 0, 40_000, {
              detail: "bun test",
              status: "error",
              error: "exit 1",
            }),
          ],
          { error: "task failed" },
        ),
      ],
    });

    const text = el.textContent;
    expect(text).toContain("Failed");
    expect(text).toContain("bun test");
    expect(text).toContain("exit 1");
    expect(el.querySelector(".session-analysis-finding--critical")).toBeTruthy();
    expect(el.querySelectorAll(".session-analysis-step").length).toBeGreaterThan(0);
  });

  it("shows which tools a model step called when it closed with no reply text", () => {
    const { el } = mount({
      getTurns: () => [
        turn(1, "completed", [
          step("model", "assistant", 0, 6_100, { detail: "", toolNames: ["Bash", "Read"] }),
        ]),
      ],
    });

    expect(el.textContent).toContain("Called: Bash, Read");
  });

  it("says a model step had no visible reply when it made no tool calls either", () => {
    const { el } = mount({
      getTurns: () => [
        turn(1, "completed", [step("model", "assistant", 0, 6_100, { detail: "" })]),
      ],
    });

    expect(el.textContent).toContain(t("taskDebugger.stepNoOutput"));
  });

  it("shows the slowest-steps ranking even for a single step", () => {
    const { el } = mount({
      getTurns: () => [turn(1, "completed", [step("model", "assistant", 0, 6_100)])],
    });
    expect(el.textContent).toContain(t("taskDebugger.slowest"));
    expect(el.querySelectorAll(".session-analysis-step").length).toBe(1);
  });

  it("caps the slowest-steps ranking at 5, dropping the rest instead of listing every step", () => {
    const steps = Array.from({ length: 8 }, (_, i) => step("tool", `step-${i}`, i * 100, i + 1));
    const { el } = mount({ getTurns: () => [turn(1, "completed", steps)] });

    expect(el.textContent).toContain(t("taskDebugger.slowest"));
    expect(el.querySelectorAll(".session-analysis-step").length).toBe(5);
  });

  it("drops the findings section entirely when the only finding is informational (e.g. 'nothing stands out')", () => {
    const { el } = mount({
      getTurns: () => [
        turn(1, "completed", [step("tool", "grep", 0, 100)], { startedAt: 0, endedAt: 100 }),
      ],
    });
    expect(el.querySelector(".session-analysis-findings")).toBeNull();
    expect(el.querySelector(".session-analysis-finding--info")).toBeNull();
  });

  it("analyses every turn in the session, not just the most recent one", () => {
    const turns = [
      turn(1, "completed", [step("tool", "grep", 0, 100)], { startedAt: 0, endedAt: 1_000 }),
      turn(2, "completed", [step("tool", "bash", 5_000, 100)], {
        startedAt: 5_000,
        endedAt: 6_000,
      }),
    ];
    const analyze = vi.fn(analyzeTurns);
    mount({ getTurns: () => turns, analyze });

    expect(analyze.mock.calls[0][0]).toEqual(turns);
  });

  it("leaves the in-flight turn out while a turn streams", () => {
    const turns = [turn(1, "completed", []), turn(2, "running", [])];
    const { section } = mount({ getTurns: () => turns });

    section.setStreaming(true);
    expect(section.getReport().totals.turns).toBe(1);
  });

  it("opens and closes the report as a dialog", () => {
    const { el } = mount({ getTurns: () => [turn(1, "completed", [])] });
    const toggle = el.querySelector(".session-analysis-toggle");
    const content = el.querySelector(".session-analysis-content");
    const overlay = el.querySelector(".session-analysis-overlay");

    // The rail only ever shows the compact trigger; the report starts closed.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(content.classList.contains("hidden")).toBe(true);
    expect(overlay.classList.contains("hidden")).toBe(true);

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content.classList.contains("hidden")).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(false);

    toggle.click();
    expect(content.classList.contains("hidden")).toBe(true);

    // Clicking the overlay or the close button also dismiss it.
    toggle.click();
    overlay.click();
    expect(content.classList.contains("hidden")).toBe(true);

    toggle.click();
    el.querySelector(".session-analysis-close").click();
    expect(content.classList.contains("hidden")).toBe(true);
  });

  it("shows the total elapsed time on the compact trigger without opening the dialog", () => {
    const { el } = mount({
      getTurns: () => [turn(1, "completed", [step("tool", "bash", 0, 1_500)])],
    });
    expect(el.querySelector(".session-analysis-time").textContent).not.toBe("");
    expect(el.querySelector(".session-analysis-content").classList.contains("hidden")).toBe(true);
  });

  it("offers nothing to copy when there is no report", () => {
    const { el } = mount();
    expect(el.querySelector(".session-analysis-copy").disabled).toBe(true);
  });

  it("copies a Markdown report to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { el } = mount({
      getTurns: () => [turn(1, "completed", [step("tool", "bash", 0, 500, { detail: "ls" })])],
      writeText,
    });

    const copy = el.querySelector(".session-analysis-copy");
    expect(copy.disabled).toBe(false);
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("# Task analysis");
    expect(copy.getAttribute("aria-label")).toBe(t("taskDebugger.copied"));
  });

  it("hands the AI block the merged turns and renders the answer", async () => {
    const turns = [turn(1, "completed", [])];
    const resolveTurns = vi.fn(async () => turns);
    const analyzeWithAi = vi.fn(async () => "## 风险点\n\n- something");
    const { el } = mount({ getTurns: () => turns, resolveTurns, analyzeWithAi });

    expect(el.querySelector(".session-ai-btn")).not.toBeNull();
    el.querySelector(".session-ai-btn").click();
    await vi.waitFor(() => expect(el.querySelector(".session-ai-card")).not.toBeNull());
    expect(resolveTurns).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".session-ai-card").textContent).toContain("风险点");
  });

  describe("session history", () => {
    function historyTurn(index, startedAt, endedAt, steps) {
      return { ...turn(index, "completed", steps, { startedAt, endedAt }), source: "history" };
    }

    it("analyses a session this window never watched", async () => {
      const turns = [historyTurn(1, 0, 60_000, [step("tool", "bash", 0, 55_000)])];
      const { section, el } = mount({ loadHistoryTurns: async () => turns });

      const pending = section.refresh();
      // Nothing is claimed while the log is still being read.
      expect(el.textContent).toContain("Reading the saved session log");
      await pending;
      expect(el.textContent).toContain("bash");
      // Rebuilt spans are labelled as such, since the log records less than a
      // live trace does.
      expect(el.textContent).toContain("rebuilt from the saved session log");
    });

    it("prefers live spans over rebuilt ones for the turns both cover", async () => {
      const live = [
        turn(9, "completed", [step("tool", "live-tool", 100_000, 1_000)], {
          startedAt: 100_000,
          endedAt: 101_000,
        }),
      ];
      const history = [
        historyTurn(1, 0, 1_000, [step("tool", "old-tool", 0, 1_000)]),
        historyTurn(2, 100_000, 101_000, [step("tool", "stale-copy", 100_000, 1_000)]),
      ];
      const { section, el } = mount({
        getTurns: () => live,
        loadHistoryTurns: async () => history,
      });

      await section.refresh();

      expect(el.textContent).toContain("old-tool");
      expect(el.textContent).toContain("live-tool");
      expect(el.textContent).not.toContain("stale-copy");
    });

    it("says so when the saved log cannot be read", async () => {
      const { section, el } = mount({
        loadHistoryTurns: async () => {
          throw new Error("no such session");
        },
      });
      await section.refresh();
      expect(el.textContent).toContain("saved session log could not be read");
    });

    it("drops the previous session's rebuilt turns when the session changes", async () => {
      let loaded = [historyTurn(1, 0, 1_000, [step("tool", "first-session", 0, 1_000)])];
      const { section, el } = mount({ loadHistoryTurns: async () => loaded });

      await section.refresh();
      expect(el.textContent).toContain("first-session");

      section.resetHistory();
      loaded = [historyTurn(1, 0, 1_000, [step("tool", "second-session", 0, 1_000)])];
      expect(el.textContent).not.toContain("first-session");
      await section.refresh();
      expect(el.textContent).toContain("second-session");
    });
  });
});

describe("buildMarkdownReport", () => {
  it("lists the status, the time split and every failure", () => {
    const report = analyzeTurns([
      turn(1, "failed", [step("tool", "bash", 0, 1_000, { status: "error", error: "exit 1" })], {
        error: "task failed",
      }),
    ]);
    const markdown = buildMarkdownReport(report, t);
    expect(markdown).toContain("# Task analysis");
    expect(markdown).toContain("Failed");
    expect(markdown).toContain("exit 1");
    expect(markdown).toContain("## Findings");
  });
});

describe("recorder to panel", () => {
  it("renders a report from the runtime frames a real turn emits", () => {
    const clock = { value: 0 };
    const recorder = createTurnTraceRecorder({ now: () => clock.value });
    const target = { workspaceId: "ws", sessionId: "s1", instanceId: "i1" };
    const emit = (event, at) => {
      clock.value = at;
      recorder.handleRuntimeFrame({ type: "runtime_event", target, event });
    };

    emit({ type: "agent_start" }, 0);
    emit({ type: "message_start", message: { role: "user", content: "run the tests" } }, 0);
    emit({ type: "message_start", message: { role: "assistant" } }, 500);
    const args = { command: "bun test" };
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args }, 1_000);
    emit({ type: "tool_execution_end", toolCallId: "t1", isError: true, result: "exit 1" }, 41_000);
    emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args }, 42_000);
    emit({ type: "tool_execution_end", toolCallId: "t2", isError: true, result: "exit 1" }, 43_000);
    emit(
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [] } },
      44_000,
    );
    emit({ type: "agent_settled" }, 44_500);

    const { el } = mount({ getTurns: () => recorder.getTurns(target) });

    const text = el.textContent;
    // The failing command, the retry loop and the bottleneck all surface.
    expect(text).toContain("bun test");
    expect(text).toContain("exit 1");
    expect(text).toContain("failed 2 times in a row");
    expect(text).toContain("bottleneck");
  });
});
