// ABOUTME: Covers the Info panel's AI analysis block state machine: run,
// ABOUTME: loading, rendered answer, failure, and reset on session switch.

import { describe, expect, test, vi } from "vitest";
import { createSessionAiAnalysis } from "./session-ai-analysis.js";

const t = (key, params = {}) => {
  const dict = {
    "sessionInfo.aiTitle": "AI analysis",
    "sessionInfo.aiRun": "Analyze with AI",
    "sessionInfo.aiRerun": "Re-analyze",
    "sessionInfo.aiAnalyzing": "Analyzing…",
    "sessionInfo.aiHint": "Ask the model to read the run log",
    "sessionInfo.aiFailed": "Analysis failed.",
    "sessionInfo.aiNoTurns": "Nothing to analyse yet",
    "sessionInfo.aiBusy": "Available when the task finishes",
  };
  let out = dict[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.replace(`{${name}}`, String(value));
  }
  return out;
};

const turns = [{ id: "t1", index: 1, steps: [] }];

function mount(overrides = {}) {
  const node = createSessionAiAnalysis({
    t,
    resolveTurns: async () => turns,
    analyzeWithAi: async () => "## 风险点\n\n- something",
    ...overrides,
  });
  document.body.replaceChildren(node.element);
  return node;
}

describe("createSessionAiAnalysis", () => {
  test("starts idle with the run action", () => {
    const node = mount();
    const button = node.element.querySelector(".session-ai-btn");
    expect(button.textContent).toBe("Analyze with AI");
    expect(button.disabled).toBe(false);
    expect(node.isBusy()).toBe(false);
    expect(node.element.querySelector(".session-ai-card")).toBeNull();
  });

  test("runs the model call against the resolved turns and renders the markdown", async () => {
    const resolveTurns = vi.fn(async () => turns);
    const analyzeWithAi = vi.fn(async () => "## 风险点\n\n- something");
    const node = mount({ resolveTurns, analyzeWithAi });

    node.element.querySelector(".session-ai-btn").click();
    await vi.waitFor(() => expect(node.element.querySelector(".session-ai-card")).not.toBeNull());

    expect(resolveTurns).toHaveBeenCalledTimes(1);
    expect(analyzeWithAi).toHaveBeenCalledWith(turns);
    expect(node.element.querySelector(".session-ai-card").textContent).toContain("风险点");
    expect(node.element.querySelector(".session-ai-btn").textContent).toBe("Re-analyze");
    expect(node.isBusy()).toBe(false);
  });

  test("reports a failed run without discarding the control", async () => {
    const node = mount({
      analyzeWithAi: async () => {
        throw new Error("no model");
      },
    });
    node.element.querySelector(".session-ai-btn").click();
    await vi.waitFor(() =>
      expect(node.element.querySelector(".session-ai-error")?.textContent).toBe("no model"),
    );
    expect(node.element.querySelector(".session-ai-btn").disabled).toBe(false);
  });

  test("refuses to run with nothing recorded yet", async () => {
    const analyzeWithAi = vi.fn();
    const node = mount({ resolveTurns: async () => [], analyzeWithAi });
    node.element.querySelector(".session-ai-btn").click();
    await vi.waitFor(() =>
      expect(node.element.querySelector(".session-ai-error")?.textContent).toBe(
        "Nothing to analyse yet",
      ),
    );
    expect(analyzeWithAi).not.toHaveBeenCalled();
  });

  test("reset drops the previous answer and returns to idle", async () => {
    const node = mount();
    node.element.querySelector(".session-ai-btn").click();
    await vi.waitFor(() => expect(node.element.querySelector(".session-ai-card")).not.toBeNull());

    node.reset();
    expect(node.element.querySelector(".session-ai-card")).toBeNull();
    expect(node.element.querySelector(".session-ai-btn").textContent).toBe("Analyze with AI");
  });

  test("the hint icon exposes the explanation to hover and assistive tech", () => {
    const hint = mount().element.querySelector(".session-ai-hint");
    expect(hint.title).toBe("Ask the model to read the run log");
    expect(hint.getAttribute("aria-label")).toBe("Ask the model to read the run log");
    expect(hint.tabIndex).toBe(0);
  });

  test("waits for the streaming task to finish before allowing a run", async () => {
    let streaming = true;
    const analyzeWithAi = vi.fn(async () => "text");
    const node = mount({ isStreaming: () => streaming, analyzeWithAi });
    const button = node.element.querySelector(".session-ai-btn");

    // A streaming turn's open spans are not "stuck" yet.
    expect(button.disabled).toBe(true);
    expect(node.element.querySelector(".session-ai-btn").title).toBe(
      "Available when the task finishes",
    );
    button.click();
    await Promise.resolve();
    expect(analyzeWithAi).not.toHaveBeenCalled();

    streaming = false;
    node.refresh();
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
  });
});
