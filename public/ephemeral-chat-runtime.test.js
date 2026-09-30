import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EphemeralChatRuntime } from "./ephemeral-chat-runtime.js";

function fakeTransport() {
  const sent = [];
  return {
    sent,
    sendEphemeral: vi.fn((instanceId, generation, payload) => {
      sent.push({ instanceId, generation, payload });
      return `ep-${sent.length}`;
    }),
  };
}

function makeRuntime(overrides = {}) {
  const transport = overrides.transport ?? fakeTransport();
  const runtime = new EphemeralChatRuntime({
    descriptor: {
      instanceId: overrides.instanceId ?? "inst-1",
      generation: overrides.generation ?? 3,
      kind: overrides.kind ?? "side-chat",
      title: overrides.title ?? null,
    },
    transport,
  });
  return { runtime, transport };
}

function eventFrame(runtimeSequence, event) {
  return {
    instanceId: "inst-1",
    generation: 3,
    runtimeSequence,
    payload: { type: "event", event },
  };
}

function snapshot(overrides = {}) {
  return {
    type: "ephemeral_snapshot",
    instanceId: "inst-1",
    generation: 3,
    runtimeSequenceWatermark: 0,
    messages: [],
    assistantDraft: null,
    tools: [],
    model: null,
    thinkingLevel: "off",
    isStreaming: false,
    contextUsage: null,
    error: null,
    ...overrides,
  };
}

describe("EphemeralChatRuntime outbound commands", () => {
  it("sends a prompt through the owner-scoped transport", () => {
    const { runtime, transport } = makeRuntime();
    runtime.sendPrompt("hello", [{ data: "x", mimeType: "image/png" }]);
    expect(transport.sendEphemeral).toHaveBeenCalledWith(
      "inst-1",
      3,
      expect.objectContaining({
        type: "prompt",
        message: "hello",
        images: [{ data: "x", mimeType: "image/png" }],
      }),
    );
  });

  it("sends abort, a correctly shaped model selection, thinking, and extension-ui responses", () => {
    const { runtime, transport } = makeRuntime();
    runtime.abort();
    runtime.setModel("anthropic", "claude-3");
    runtime.setThinkingLevel("high");
    runtime.respondToExtensionUi("ui-1", { value: "yes" });
    const types = transport.sent.map((s) => s.payload.type);
    expect(types).toEqual(["abort", "set_model", "set_thinking_level", "extension_ui_response"]);
    expect(transport.sent[1].payload).toMatchObject({
      provider: "anthropic",
      modelId: "claude-3",
    });
    expect(transport.sent[3].payload).toMatchObject({ id: "ui-1", value: "yes" });
  });

  it("uses the runtime's available thinking levels and effective cycle result", async () => {
    const { runtime, transport } = makeRuntime();
    const levelsPromise = runtime.getAvailableThinkingLevels();
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 3,
      payload: {
        type: "response",
        id: "ep-1",
        command: "get_available_thinking_levels",
        success: true,
        data: { levels: ["off", "high", "xhigh"] },
      },
    });
    await expect(levelsPromise).resolves.toEqual(["off", "high", "xhigh"]);

    const cyclePromise = runtime.cycleThinkingLevel();
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 3,
      payload: {
        type: "response",
        id: "ep-2",
        command: "cycle_thinking_level",
        success: true,
        data: { level: "high", levels: ["off", "high", "xhigh"] },
      },
    });
    await expect(cyclePromise).resolves.toEqual({
      level: "high",
      levels: ["off", "high", "xhigh"],
    });
    expect(runtime.thinkingLevel).toBe("high");
    expect(runtime.thinkingLevels).toEqual(["off", "high", "xhigh"]);
    expect(transport.sent.map((entry) => entry.payload.type)).toEqual([
      "get_available_thinking_levels",
      "cycle_thinking_level",
    ]);
  });

  it("returns the ephemeral runtime's available models from its correlated response", async () => {
    const { runtime } = makeRuntime();
    const modelsPromise = runtime.getAvailableModels();
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 3,
      payload: {
        type: "response",
        id: "ep-1",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "anthropic", id: "claude-3" }] },
      },
    });
    await expect(modelsPromise).resolves.toEqual([{ provider: "anthropic", id: "claude-3" }]);
  });

  it("drops commands after destroy and is idempotent", () => {
    const { runtime, transport } = makeRuntime();
    runtime.destroy();
    expect(() => runtime.destroy()).not.toThrow();
    runtime.sendPrompt("late");
    expect(transport.sendEphemeral).not.toHaveBeenCalled();
  });
});

describe("EphemeralChatRuntime frame filtering", () => {
  it("ignores frames for another instance or generation", () => {
    const { runtime } = makeRuntime();
    const states = [];
    runtime.addEventListener("renderstate", (e) => states.push(e.detail));
    runtime.applySequencedEvent({
      instanceId: "other",
      generation: 3,
      runtimeSequence: 1,
      payload: { type: "event", event: { type: "agent_start" } },
    });
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 99,
      runtimeSequence: 1,
      payload: { type: "event", event: { type: "agent_start" } },
    });
    expect(states).toEqual([]);
  });
});

describe("EphemeralChatRuntime snapshot + sequenced replay", () => {
  it("queues events before the snapshot and replays them in order after mounting", () => {
    const { runtime } = makeRuntime();
    const states = [];
    runtime.addEventListener("renderstate", (e) => states.push(e.detail));

    runtime.applySequencedEvent(eventFrame(1, { type: "agent_start" }));
    runtime.applySequencedEvent(eventFrame(2, { type: "agent_end" }));
    // Not mounted yet: no renderstate emissions from events.
    expect(states).toEqual([]);

    runtime.applySnapshot(snapshot({ runtimeSequenceWatermark: 0, isStreaming: false }));
    // After snapshot the queue drains: streaming went true then false.
    expect(states.at(-1).isStreaming).toBe(false);
    expect(runtime.lastAppliedSequence).toBe(2);
  });

  it("applySnapshot replaces state and watermark from another instance only when matching", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot({
      ...snapshot({ runtimeSequenceWatermark: 5, messages: [{ role: "user", content: "x" }] }),
      instanceId: "wrong",
    });
    expect(runtime.mounted).toBe(false);
    runtime.applySnapshot(
      snapshot({ runtimeSequenceWatermark: 5, messages: [{ role: "user", content: "x" }] }),
    );
    expect(runtime.mounted).toBe(true);
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.lastAppliedSequence).toBe(5);
  });

  it("normalizes Pi user content blocks in an authoritative snapshot", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(
      snapshot({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Restored prompt" }],
          },
        ],
      }),
    );
    expect(runtime.messages).toEqual([{ role: "user", content: "Restored prompt" }]);
  });

  it("ignores duplicate or out-of-order sequences", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot({ runtimeSequenceWatermark: 10 }));
    const states = [];
    runtime.addEventListener("renderstate", (e) => states.push(e.detail));
    runtime.applySequencedEvent(eventFrame(10, { type: "agent_start" })); // duplicate
    runtime.applySequencedEvent(eventFrame(9, { type: "agent_start" })); // older
    expect(states).toEqual([]);
  });

  it("requests a fresh snapshot on a sequence gap", () => {
    const { runtime, transport } = makeRuntime();
    runtime.applySnapshot(snapshot({ runtimeSequenceWatermark: 10 }));
    let resnapshot = 0;
    runtime.addEventListener("resnapshot", () => {
      resnapshot += 1;
    });
    runtime.applySequencedEvent(eventFrame(20, { type: "agent_start" }));
    expect(resnapshot).toBe(1);
    expect(transport.sent.some((s) => s.payload.type === "ephemeral_snapshot_request")).toBe(true);
    expect(runtime.mounted).toBe(false);
  });
});

describe("EphemeralChatRuntime reduce", () => {
  it("accumulates assistant text/thinking and finalizes on message_end", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(
      eventFrame(1, { type: "message_start", message: { role: "assistant", content: "" } }),
    );
    runtime.applySequencedEvent(
      eventFrame(2, {
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "text_delta", delta: "Hel" },
      }),
    );
    runtime.applySequencedEvent(
      eventFrame(3, {
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "thinking", delta: "reasoning" },
      }),
    );
    expect(runtime.assistantDraft).toEqual({ text: "Hel", thinking: "reasoning" });
    runtime.applySequencedEvent(
      eventFrame(4, { type: "message_end", message: { role: "assistant", content: "Hello" } }),
    );
    expect(runtime.assistantDraft).toBeNull();
    expect(runtime.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("normalizes Pi user content blocks for the shared message renderer", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(
      eventFrame(1, {
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", data: "base64-image", mimeType: "image/png" },
          ],
        },
      }),
    );
    expect(runtime.messages).toEqual([
      {
        role: "user",
        content: "Describe this",
        images: [{ data: "base64-image", mimeType: "image/png" }],
      },
    ]);
  });

  it("transitions a tool through pending -> streaming -> complete", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(
      eventFrame(1, {
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "bash",
        args: {},
      }),
    );
    runtime.applySequencedEvent(
      eventFrame(2, { type: "tool_execution_update", toolCallId: "tc1", partialResult: "p" }),
    );
    runtime.applySequencedEvent(
      eventFrame(3, { type: "tool_execution_end", toolCallId: "tc1", result: "done" }),
    );
    expect(runtime.tools.get("tc1")).toMatchObject({ status: "complete", output: "done" });
  });
});

describe("EphemeralChatRuntime unread + title", () => {
  it("marks unread while inactive and clears on acknowledgeVisible", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    const unreadEvents = [];
    runtime.addEventListener("unreadchange", (e) => unreadEvents.push(e.detail.unread));
    runtime.applySequencedEvent(eventFrame(1, { type: "agent_start" }));
    expect(runtime.unread).toBe(true);
    expect(unreadEvents).toContain(true);
    runtime.acknowledgeVisible();
    expect(runtime.unread).toBe(false);
    expect(unreadEvents.at(-1)).toBe(false);
  });

  it("emits a title prompt once from the first user message", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    const titles = [];
    runtime.addEventListener("titleprompt", (e) => titles.push(e.detail.text));
    runtime.applySequencedEvent(
      eventFrame(1, {
        type: "message_start",
        message: { role: "user", content: "summarize this" },
      }),
    );
    runtime.applySequencedEvent(
      eventFrame(2, { type: "message_start", message: { role: "user", content: "again" } }),
    );
    expect(titles).toEqual(["summarize this"]);
  });

  it("reconstructs a missing title from an authoritative snapshot", () => {
    const { runtime } = makeRuntime();
    const titles = [];
    runtime.addEventListener("titleprompt", (event) => titles.push(event.detail.text));
    runtime.applySnapshot(
      snapshot({ messages: [{ role: "user", content: "restore this title" }] }),
    );
    expect(titles).toEqual(["restore this title"]);
  });

  it("reports close risk with messages/streaming flags", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    expect(runtime.getCloseRisk()).toMatchObject({
      instanceId: "inst-1",
      generation: 3,
      kind: "side-chat",
      hasMessages: false,
      streaming: false,
    });
    runtime.applySequencedEvent(eventFrame(1, { type: "agent_start" }));
    expect(runtime.getCloseRisk().streaming).toBe(true);
  });

  it("routes a snapshot reply (payload.type ephemeral_snapshot) to applySnapshot", () => {
    const { runtime } = makeRuntime();
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 3,
      payload: {
        type: "ephemeral_snapshot",
        instanceId: "inst-1",
        generation: 3,
        runtimeSequenceWatermark: 0,
        messages: [{ role: "user", content: "from snapshot" }],
        assistantDraft: null,
        tools: [],
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        contextUsage: null,
        error: null,
      },
    });
    expect(runtime.mounted).toBe(true);
    expect(runtime.messages).toHaveLength(1);
  });

  it("accepts runtimeSequence nested in payload when the envelope omits it", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 3,
      payload: { type: "event", runtimeSequence: 1, event: { type: "agent_start" } },
    });
    expect(runtime.isStreaming).toBe(true);
    expect(runtime.lastAppliedSequence).toBe(1);
  });
});

// Frames below mirror the real native-hub wire: the Rust host forwards Pi's
// session events as raw top-level frames (captured against embedded pi
// 0.87.1), not the legacy Node-broker {type:"event"} envelope.
function rawEventFrame(runtimeSequence, event) {
  return { instanceId: "inst-1", generation: 3, runtimeSequence, payload: event };
}

describe("EphemeralChatRuntime raw native event frames", () => {
  it("applies a raw Pi turn: user echo, assistant stream, agent lifecycle", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(rawEventFrame(1, { type: "agent_start" }));
    runtime.applySequencedEvent(
      rawEventFrame(2, { type: "message_start", message: { role: "user", content: "hi" } }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(3, { type: "message_start", message: { role: "assistant", content: [] } }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(4, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "PONG" },
      }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(5, {
        type: "message_end",
        message: {
          role: "assistant",
          content: "PONG",
          usage: { input: 10, output: 5, cost: { total: 0.01 } },
        },
      }),
    );
    runtime.applySequencedEvent(rawEventFrame(6, { type: "agent_end", messages: [] }));
    expect(runtime.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(runtime.assistantDraft).toBeNull();
    expect(runtime.isStreaming).toBe(false);
    expect(runtime.totalTokens).toBe(15);
    expect(runtime.cost).toBe(0.01);
  });

  it("applies raw model_select and thinking_level_select frames", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(
      rawEventFrame(1, { type: "model_select", model: { id: "m", provider: "p" } }),
    );
    runtime.applySequencedEvent(rawEventFrame(2, { type: "thinking_level_select", level: "high" }));
    expect(runtime.model).toEqual({ id: "m", provider: "p" });
    expect(runtime.thinkingLevel).toBe("high");
  });

  it("keeps the default thinking-level ladder when the snapshot omits the list", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot({ thinkingLevel: "high" }));
    expect(runtime.thinkingLevel).toBe("high");
    expect(runtime.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("groups a raw Pi turn: user, tools, assistant, closed on turn_end", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(rawEventFrame(1, { type: "turn_start" }));
    runtime.applySequencedEvent(
      rawEventFrame(2, { type: "message_start", message: { role: "user", content: "run ls" } }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(3, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(4, { type: "tool_execution_update", toolCallId: "t1", partialResult: "a.txt" }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(5, {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: "a.txt",
        isError: false,
      }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(6, {
        type: "message_end",
        message: {
          role: "assistant",
          content: "done",
          usage: { input: 1, output: 1, cost: { total: 0 } },
        },
      }),
    );
    runtime.applySequencedEvent(
      rawEventFrame(7, { type: "turn_end", message: { role: "assistant", content: "done" } }),
    );
    runtime.applySequencedEvent(rawEventFrame(8, { type: "turn_start" }));
    expect(runtime.turns).toHaveLength(2);
    expect(runtime.turns[0].user.content).toBe("run ls");
    expect(runtime.turns[0].tools).toHaveLength(1);
    expect(runtime.turns[0].tools[0]).toMatchObject({
      toolCallId: "t1",
      toolName: "bash",
      status: "complete",
      output: "a.txt",
    });
    expect(runtime.turns[0].assistant.content).toBe("done");
    expect(runtime.turns[0].closed).toBe(true);
    expect(runtime.turns[1].closed).toBe(false);
  });

  it("rebuilds turns from a snapshot carrying a turns array", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(
      snapshot({
        turns: [
          {
            user: { role: "user", content: "hi" },
            tools: [
              { toolCallId: "t9", toolName: "bash", args: {}, output: "", status: "complete" },
            ],
            assistant: { role: "assistant", content: "yo" },
            closed: true,
          },
        ],
      }),
    );
    expect(runtime.turns).toHaveLength(1);
    expect(runtime.turns[0].tools[0].toolCallId).toBe("t9");
  });

  it("preserves legacy-snapshot history when the first live event arrives", () => {
    const { runtime } = makeRuntime();
    // Legacy host snapshot: messages + flat tools, no turns.
    runtime.applySnapshot(
      snapshot({
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
        tools: [
          { toolCallId: "t0", toolName: "bash", args: {}, output: "old", status: "complete" },
        ],
      }),
    );
    expect(runtime.turns).toBeNull();
    runtime.applySequencedEvent(rawEventFrame(1, { type: "turn_start" }));
    runtime.applySequencedEvent(
      rawEventFrame(2, { type: "message_start", message: { role: "user", content: "new" } }),
    );
    // History survives as a synthesized closed turn; the new event opens one.
    expect(runtime.turns).toHaveLength(2);
    expect(runtime.turns[0].user.content).toBe("old question");
    expect(runtime.turns[0].assistant.content).toBe("old answer");
    expect(runtime.turns[0].tools[0].toolCallId).toBe("t0");
    expect(runtime.turns[0].closed).toBe(true);
    expect(runtime.turns[1].user.content).toBe("new");
    expect(runtime.turns[1].closed).toBe(false);
  });

  it("rebuilds from the shared cross-language fixture (pinned to Rust serialization)", () => {
    // tests/fixtures/ephemeral/turns-snapshot.json is asserted byte-equal on
    // the Rust side (snapshot_carries_turn_grouped_projection); consuming it
    // here pins both ends of the wire contract.
    const fixture = JSON.parse(
      readFileSync("tests/fixtures/ephemeral/turns-snapshot.json", "utf8"),
    );
    const { runtime } = makeRuntime();
    runtime.applySnapshot(fixture);
    expect(runtime.turns).toEqual([
      {
        user: { role: "user", content: "run ls" },
        tools: [
          {
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "ls" },
            output: "a.txt",
            status: "complete",
          },
        ],
        assistant: { role: "assistant", content: "done", stopReason: "end_turn" },
        closed: true,
      },
    ]);
  });

  it("keeps turns null when the snapshot carries no turns (legacy host)", () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    expect(runtime.turns).toBeNull();
  });

  it("routes a top-level native snapshot frame to applySnapshot", () => {
    const { runtime } = makeRuntime();
    runtime.applySequencedEvent({
      type: "ephemeral_snapshot",
      requestId: "ep-snap",
      instanceId: "inst-1",
      generation: 3,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [],
      model: { id: "ZHIPU/glm-5.3-flash", provider: "OpenCodex" },
      thinkingLevel: "high",
      isStreaming: false,
      contextUsage: null,
      error: null,
    });
    expect(runtime.mounted).toBe(true);
    expect(runtime.model?.id).toBe("ZHIPU/glm-5.3-flash");
    expect(runtime.thinkingLevel).toBe("high");
  });

  it('still accepts the legacy {type:"event"} envelope', () => {
    const { runtime } = makeRuntime();
    runtime.applySnapshot(snapshot());
    runtime.applySequencedEvent(eventFrame(1, { type: "agent_start" }));
    expect(runtime.isStreaming).toBe(true);
  });
});
