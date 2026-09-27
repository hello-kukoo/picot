// ABOUTME: Covers the AI-analysis prompt builder and the throwaway-session
// ABOUTME: lifecycle (spawn, prompt, read reply, always delete) it drives.

import { expect, test, vi } from "vitest";
import { buildAnalysisPrompt, buildTranscript, runAiAnalysis } from "./session-ai-runner.js";

function turn(overrides = {}) {
  return {
    index: 1,
    status: "completed",
    error: null,
    prompt: "fix the bug",
    steps: [],
    ...overrides,
  };
}

test("buildTranscript renders each turn's prompt and steps", () => {
  const text = buildTranscript([
    turn({
      steps: [
        { kind: "tool", label: "read", detail: "src/a.js", status: "ok", error: null },
        { kind: "tool", label: "bash", detail: "npm test", status: "error", error: "exit 1" },
      ],
    }),
  ]);
  expect(text).toContain("Turn 1 - completed");
  expect(text).toContain("User: fix the bug");
  expect(text).toContain("[tool] read (src/a.js) - ok");
  expect(text).toContain("[tool] bash (npm test) - error ERROR: exit 1");
});

test("buildTranscript truncates from the front, keeping the tail", () => {
  const bigStep = { kind: "tool", label: "read", detail: "x".repeat(100), status: "ok" };
  const turns = Array.from({ length: 500 }, (_, i) => turn({ index: i, steps: [bigStep] }));
  const text = buildTranscript(turns, { maxChars: 500 });
  expect(text.length).toBeLessThan(600);
  expect(text).toMatch(/^\.\.\.\[\d+ earlier characters truncated\]\.\.\./);
  expect(text).toContain(`Turn ${turns.length - 1} - completed`);
  expect(text).not.toContain("Turn 0 - completed");
});

test("buildAnalysisPrompt asks for risk/blocker/failure sections and embeds the transcript", () => {
  const prompt = buildAnalysisPrompt([turn()]);
  expect(prompt).toContain("风险点 (Risk points)");
  expect(prompt).toContain("卡点 (Blockers / stuck points)");
  expect(prompt).toContain("失败点 (Failure points)");
  expect(prompt).toContain("User: fix the bug");
});

test("runAiAnalysis spawns a session, prompts it, reads the reply from the runtime snapshot, then deletes the persisted session", async () => {
  const target = { workspaceId: "w1", sessionId: "temp-1", instanceId: "i1" };
  const boundTarget = { workspaceId: "w1", sessionId: "persisted-1", instanceId: "i1" };
  const spawnSession = vi.fn().mockResolvedValue(target);
  const request = vi.fn().mockResolvedValue({});
  // A fresh runtime trades its temporary session id for a persisted one once
  // the host serves a snapshot -- deleteSessions must be asked to clean up
  // both, since a delete for an id with no matching file is a harmless no-op.
  // The reply itself comes from the snapshot's own in-memory state, not a
  // disk re-read, so there is no race with the session's on-disk log still
  // being written.
  const snapshot = vi.fn().mockResolvedValue({
    target: boundTarget,
    state: {
      messages: [
        { role: "user", content: "analyze this" },
        { role: "assistant", content: [{ type: "text", text: "here are the risks" }] },
      ],
    },
  });
  const deleteSessions = vi.fn().mockResolvedValue({});

  const text = await runAiAnalysis({
    runtime: { request, snapshot },
    control: { deleteSessions },
    spawnSession,
    workspaceId: "w1",
    model: { provider: "anthropic", id: "claude" },
    prompt: "analyze this",
  });

  expect(text).toBe("here are the risks");
  expect(spawnSession).toHaveBeenCalledWith("w1");
  expect(request).toHaveBeenCalledWith(
    { type: "set_model", provider: "anthropic", modelId: "claude" },
    target,
    expect.any(Object),
  );
  expect(request).toHaveBeenCalledWith(
    { type: "prompt", message: "analyze this" },
    target,
    expect.any(Object),
  );
  expect(snapshot).toHaveBeenCalledWith("temp-1");
  expect(deleteSessions).toHaveBeenCalledTimes(1);
  expect(deleteSessions.mock.calls[0][0].sort()).toEqual(["persisted-1", "temp-1"]);
});

test("runAiAnalysis still deletes the throwaway session when the prompt fails", async () => {
  const target = { workspaceId: "w1", sessionId: "temp-2", instanceId: "i2" };
  const spawnSession = vi.fn().mockResolvedValue(target);
  const request = vi.fn().mockRejectedValue(new Error("boom"));
  const deleteSessions = vi.fn().mockResolvedValue({});

  await expect(
    runAiAnalysis({
      runtime: { request, snapshot: vi.fn() },
      control: { deleteSessions },
      spawnSession,
      workspaceId: "w1",
      model: null,
      prompt: "analyze this",
    }),
  ).rejects.toThrow("boom");

  // Never got far enough to learn the persisted id -- delete the one spawnSession gave us.
  expect(deleteSessions).toHaveBeenCalledWith(["temp-2"]);
});

test("runAiAnalysis waits for agent_settled before reading the snapshot", async () => {
  // The `prompt` RPC resolves as soon as pi accepts/queues the message, well
  // before the model has actually replied -- snapshotting right away would
  // race the real generation. Simulate that by having the prompt request
  // resolve before the settle event is published; the snapshot the real
  // assertion runs against must only be read after settling.
  const target = { workspaceId: "w1", sessionId: "temp-4", instanceId: "i4" };
  let emitSettled;
  const subscribe = vi.fn((listener) => {
    emitSettled = () =>
      listener({ type: "runtime_event", target, event: { type: "agent_settled" } });
    return () => {};
  });
  const events = [];
  const request = vi.fn((command) => {
    events.push(`request:${command.type}`);
    return Promise.resolve({});
  });
  const snapshot = vi.fn(async () => {
    events.push("snapshot");
    return {
      target,
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done analyzing" }] }],
      },
    };
  });

  const promise = runAiAnalysis({
    runtime: { request, snapshot, subscribe },
    control: { deleteSessions: vi.fn().mockResolvedValue({}) },
    spawnSession: vi.fn().mockResolvedValue(target),
    workspaceId: "w1",
    model: null,
    prompt: "analyze this",
  });

  // Let the prompt request resolve, then confirm the snapshot has not been
  // read yet -- only emitting agent_settled should unblock it.
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["request:prompt"]);

  emitSettled();
  const text = await promise;
  expect(text).toBe("done analyzing");
  expect(events).toEqual(["request:prompt", "snapshot"]);
});

test("runAiAnalysis rejects when the model replies with no text, but still deletes the session", async () => {
  const target = { workspaceId: "w1", sessionId: "temp-3", instanceId: "i3" };
  const deleteSessions = vi.fn().mockResolvedValue({});

  await expect(
    runAiAnalysis({
      runtime: {
        request: vi.fn().mockResolvedValue({}),
        snapshot: vi.fn().mockResolvedValue({ target, state: { messages: [] } }),
      },
      control: { deleteSessions },
      spawnSession: vi.fn().mockResolvedValue(target),
      workspaceId: "w1",
      model: null,
      prompt: "analyze this",
    }),
  ).rejects.toThrow("no analysis text");

  expect(deleteSessions).toHaveBeenCalledWith(["temp-3"]);
});
