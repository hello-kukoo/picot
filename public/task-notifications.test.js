import { describe, expect, it, vi } from "vitest";
import { createTaskNotifications } from "./task-notifications.js";

function harness({ enabled = () => true, t } = {}) {
  const sendData = vi.fn().mockResolvedValue({ ok: true });
  const notifications = createTaskNotifications(
    { sendData },
    enabled,
    t ? { t } : { logger: { warn: vi.fn() } },
  );
  return { notifications, sendData };
}

const TARGET = { workspaceId: "ws-1", sessionId: "sess-1", instanceId: "inst-1" };

function frame(type, target = TARGET, extra = {}) {
  return { target, event: { type, ...extra } };
}

describe("task notifications", () => {
  it("notifies once when a started agent settles", () => {
    const { notifications, sendData } = harness();
    notifications.handleRuntimeFrame(frame("agent_start"));
    notifications.handleRuntimeFrame(frame("agent_settled"));
    expect(sendData).toHaveBeenCalledTimes(1);
    expect(sendData).toHaveBeenCalledWith("show_task_notification", {
      title: expect.any(String),
      body: expect.any(String),
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
  });

  it("reports the runtime error in the body when the task failed", () => {
    const { notifications, sendData } = harness();
    notifications.handleRuntimeFrame(frame("agent_start"));
    notifications.handleRuntimeFrame(frame("agent_end", TARGET, { error: "boom" }));
    const body = sendData.mock.calls[0][1].body;
    expect(body).toContain("boom");
  });

  it("skips settles without a matching start instead of double-notifying", () => {
    const { notifications, sendData } = harness();
    notifications.handleRuntimeFrame(frame("agent_settled"));
    expect(sendData).not.toHaveBeenCalled();
  });

  it("does not notify while disabled", () => {
    const { notifications, sendData } = harness({ enabled: () => false });
    notifications.handleRuntimeFrame(frame("agent_start"));
    notifications.handleRuntimeFrame(frame("agent_end"));
    expect(sendData).not.toHaveBeenCalled();
  });

  it("ignores frames without an event payload", () => {
    const { notifications, sendData } = harness();
    notifications.handleRuntimeFrame({ target: TARGET });
    notifications.handleRuntimeFrame(null);
    expect(sendData).not.toHaveBeenCalled();
  });

  it("uses localized titles", () => {
    const { notifications, sendData } = harness({
      t: (key) => `⟪${key}⟫`,
    });
    notifications.handleRuntimeFrame(frame("agent_start"));
    notifications.handleRuntimeFrame(frame("agent_settled"));
    expect(sendData.mock.calls[0][1].title).toBe("⟪settings.taskCompleteTitle⟫");
  });
});
