import { describe, expect, it } from "vitest";
import { analyzeTurns } from "./turn-analysis.js";
import { activeChain, buildTurnsFromEntries, mergeTurnSources } from "./turn-history.js";

const T0 = Date.parse("2026-09-16T10:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

let nextId = 0;
function entry(type, offsetMs, extra = {}) {
  nextId += 1;
  return { id: `e${nextId}`, parentId: `e${nextId - 1}`, type, timestamp: iso(offsetMs), ...extra };
}

function userEntry(offsetMs, text) {
  return entry("message", offsetMs, {
    message: { role: "user", content: [{ type: "text", text }], timestamp: T0 + offsetMs },
  });
}

/** `startedAt` is when the request began; the entry stamp is when it ended. */
function assistantEntry(startOffset, endOffset, { text = "", toolCalls = [], ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "toolCall", ...call });
  return entry("message", endOffset, {
    message: { role: "assistant", content, timestamp: T0 + startOffset, ...rest },
  });
}

function toolResultEntry(offsetMs, toolCallId, { text = "ok", isError = false } = {}) {
  return entry("message", offsetMs, {
    message: {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text }],
      isError,
      timestamp: T0 + offsetMs,
    },
  });
}

describe("turn history rebuild", () => {
  it("times the model from the message stamp and the tool from the entry stamps", () => {
    const entries = [
      userEntry(0, "read the config"),
      assistantEntry(10, 2_000, {
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "config.json" } }],
      }),
      toolResultEntry(9_000, "call-1"),
      assistantEntry(9_010, 11_000, { text: "it sets the port to 8080" }),
    ];

    const [turn] = buildTurnsFromEntries(entries);

    expect(turn.source).toBe("history");
    expect(turn.status).toBe("completed");
    expect(turn.prompt).toBe("read the config");
    // Model: 10ms -> 2s. Tool: from the assistant entry that asked for it (2s)
    // to the result entry (9s) -- the 7s a live trace would have recorded.
    expect(turn.steps.map((step) => [step.kind, step.durationMs])).toEqual([
      ["model", 1_990],
      ["tool", 7_000],
      ["model", 1_990],
    ]);
    expect(turn.durationMs).toBe(11_000);
  });

  it("feeds the same analysis the live recorder does", () => {
    const entries = [
      userEntry(0, "build it"),
      assistantEntry(10, 1_000, {
        toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "make" } }],
      }),
      toolResultEntry(61_000, "call-1", { text: "compile error", isError: true }),
      assistantEntry(61_010, 62_000, { text: "the build failed" }),
    ];

    const report = analyzeTurns(buildTurnsFromEntries(entries), { now: () => T0 + 62_000 });

    expect(report.totals.toolCalls).toBe(1);
    expect(report.totals.failureCount).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toContain("toolFailures");
    expect(report.slowest[0]).toMatchObject({ kind: "tool", label: "bash", durationMs: 60_000 });
  });

  it("marks a tool call whose result never landed as unfinished", () => {
    const entries = [
      userEntry(0, "deploy"),
      assistantEntry(10, 1_000, {
        toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "deploy" } }],
      }),
      userEntry(30_000, "are you stuck?"),
    ];

    const [first] = buildTurnsFromEntries(entries);

    expect(first.status).toBe("unknown");
    expect(first.steps.at(-1)).toMatchObject({ kind: "tool", status: "unfinished" });
  });

  it("starts a turn at an injected prompt so a resumed session is not one span", () => {
    const entries = [
      userEntry(0, "hello"),
      assistantEntry(10, 1_000, { text: "hi" }),
      entry("custom_message", 900_000, {
        customType: "google-account",
        content: [{ type: "text", text: "cookie access is disabled" }],
      }),
      assistantEntry(900_010, 902_000, { text: "I will use the API instead" }),
    ];

    const turns = buildTurnsFromEntries(entries);

    expect(turns).toHaveLength(2);
    expect(turns[0].durationMs).toBe(1_000);
    expect(turns[1].prompt).toBe("cookie access is disabled");
    expect(turns[1].durationMs).toBe(2_000);
  });

  it("folds a context prompt into the message that follows it", () => {
    const entries = [
      entry("custom_message", 0, { customType: "chat-context", content: "Connected to telegram" }),
      userEntry(500, "what is up"),
      assistantEntry(510, 3_000, { text: "not much" }),
    ];

    const turns = buildTurnsFromEntries(entries);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("what is up");
  });

  it("ignores state entries that are not prompts", () => {
    const entries = [
      userEntry(0, "go"),
      entry("custom", 100, { customType: "plan-mode-state", data: { enabled: false } }),
      entry("thinking_level_change", 200, { thinkingLevel: "max" }),
      assistantEntry(210, 4_000, { text: "done" }),
    ];

    expect(buildTurnsFromEntries(entries)).toHaveLength(1);
  });

  it("records usage and a failed model response", () => {
    const entries = [
      userEntry(0, "go"),
      assistantEntry(10, 5_000, {
        text: "",
        stopReason: "error",
        errorMessage: "overloaded",
        usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.25 } },
      }),
    ];

    const [turn] = buildTurnsFromEntries(entries);

    expect(turn.status).toBe("failed");
    expect(turn.error).toBe("overloaded");
    expect(turn.usage).toMatchObject({ input: 100, output: 20, cacheRead: 5, cost: 0.25 });
  });

  it("follows the active branch of a forked session", () => {
    const root = {
      id: "root",
      type: "message",
      timestamp: iso(0),
      message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: T0 },
    };
    const abandoned = {
      id: "branch-a",
      parentId: "root",
      type: "message",
      timestamp: iso(1_000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "wrong turn" }],
        timestamp: T0 + 10,
      },
    };
    const kept = {
      id: "branch-b",
      parentId: "root",
      type: "message",
      timestamp: iso(2_000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "right turn" }],
        timestamp: T0 + 20,
      },
    };

    expect(activeChain([root, abandoned, kept], "branch-b").map((node) => node.id)).toEqual([
      "root",
      "branch-b",
    ]);

    const [turn] = buildTurnsFromEntries([root, abandoned, kept], { leafId: "branch-b" });
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].detail).toBe("right turn");
  });

  it("keeps only the most recent turns", () => {
    const entries = [];
    for (let i = 0; i < 25; i += 1) {
      entries.push(
        userEntry(i * 1_000, `turn ${i}`),
        assistantEntry(i * 1_000 + 10, i * 1_000 + 500),
      );
    }

    const turns = buildTurnsFromEntries(entries, { maxTurns: 5 });

    expect(turns).toHaveLength(5);
    expect(turns.at(-1).prompt).toBe("turn 24");
  });

  it("returns nothing for a log with no messages", () => {
    expect(buildTurnsFromEntries([])).toEqual([]);
    expect(buildTurnsFromEntries(null)).toEqual([]);
  });
});

describe("mergeTurnSources", () => {
  const live = (startedAt, id = "live") => ({ id, startedAt, endedAt: startedAt + 100 });
  const history = (startedAt, endedAt, id = `h-${startedAt}`) => ({
    id,
    startedAt,
    endedAt,
  });

  it("returns history when the recorder watched nothing", () => {
    const older = [history(0, 100)];
    expect(mergeTurnSources(older, [])).toEqual(older);
    expect(mergeTurnSources([], [])).toEqual([]);
  });

  it("returns live turns when there is no rebuilt history", () => {
    const watched = [live(100)];
    expect(mergeTurnSources([], watched)).toEqual(watched);
  });

  it("keeps only the history older than live coverage begins", () => {
    const rebuilt = [history(0, 1_000, "old"), history(100_000, 101_000, "overlap")];
    const watched = [live(100_000, "live")];
    expect(mergeTurnSources(rebuilt, watched).map((turn) => turn.id)).toEqual(["old", "live"]);
  });

  it("treats a missing endedAt as the turn's start when deciding overlap", () => {
    const rebuilt = [history(500, undefined, "no-end")];
    const watched = [live(1_000, "live")];
    expect(mergeTurnSources(rebuilt, watched).map((turn) => turn.id)).toEqual(["no-end", "live"]);
  });
});
