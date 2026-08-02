// ABOUTME: Verifies get_session_stats aggregation aggregates per-assistant-message
// ABOUTME: usage/cost and returns null tokens for sessions with no assistant usage.
import { describe, expect, it } from "vitest";
import { aggregateSessionStats } from "./embedded-server.ts";

function msg(role: string, usage?: Record<string, unknown>) {
  return { type: "message", message: { role, ...(usage ? { usage } : {}) } };
}

describe("aggregateSessionStats", () => {
  it("returns null aggregate (hasAggregate false) for a session with no assistant usage", () => {
    const stats = aggregateSessionStats([msg("user"), msg("user")]);
    expect(stats.hasAggregate).toBe(false);
    expect(stats.input).toBe(0);
    expect(stats.cost).toBe(0);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(0);
  });

  it("sums input/output/cacheRead/cacheWrite and cost across assistant messages", () => {
    const stats = aggregateSessionStats([
      msg("assistant", {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 5,
        cost: { total: 0.02 },
      }),
      msg("assistant", {
        input: 40,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
        cost: { total: 0.01 },
      }),
    ]);
    expect(stats.hasAggregate).toBe(true);
    expect(stats.input).toBe(140);
    expect(stats.output).toBe(70);
    expect(stats.cacheRead).toBe(40);
    expect(stats.cacheWrite).toBe(5);
    expect(stats.cost).toBeCloseTo(0.03, 5);
    expect(stats.assistantMessages).toBe(2);
  });

  it("counts user, assistant, and toolResult roles separately", () => {
    const stats = aggregateSessionStats([
      msg("user"),
      msg("assistant", { input: 10, output: 5 }),
      { type: "message", message: { role: "toolResult" } },
    ]);
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.toolCalls).toBe(1);
  });

  it("includes nested tool and summary-generation usage", () => {
    const stats = aggregateSessionStats([
      msg("assistant", { input: 10, output: 5, cost: { total: 0.01 } }),
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: { input: 20, output: 4, cacheRead: 2, cost: { total: 0.02 } },
        },
      },
      { type: "compaction", usage: { input: 30, output: 6, cost: { total: 0.03 } } },
      { type: "branch_summary", usage: { input: 40, output: 7, cost: { total: 0.04 } } },
    ]);
    expect(stats.input).toBe(100);
    expect(stats.output).toBe(22);
    expect(stats.cacheRead).toBe(2);
    expect(stats.cost).toBeCloseTo(0.1, 5);
  });

  it("ignores non-message entries and messages without usage", () => {
    const stats = aggregateSessionStats([
      { type: "summary", message: { role: "assistant" } },
      msg("assistant"),
    ]);
    expect(stats.hasAggregate).toBe(false);
    expect(stats.assistantMessages).toBe(1);
  });
});
