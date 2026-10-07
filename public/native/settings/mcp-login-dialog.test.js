// @vitest-environment jsdom

// ABOUTME: Verifies the MCP sign-in dialog: authorization URL display, host-event bridge,
// ABOUTME: status-poll fallback, cancellation, terminal states, and message redaction.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../../i18n.js";
import { createMcpLoginDialog } from "./mcp-login-dialog.js";

setMessages({
  actions: { close: "Close" },
  settings: {
    mcp: {
      login: {
        title: "Sign in to {name}",
        preparing: "Starting sign-in…",
        waiting: "Complete authorization in your browser.",
        openBrowser: "Open browser",
        cancel: "Cancel",
        retry: "Try again",
        failed: "Sign-in failed.",
        cancelled: "Sign-in cancelled.",
      },
    },
  },
});

function createHarness(overrides = {}) {
  let unsubscribed = 0;
  const emit = vi.fn();
  const start = vi.fn(async () => ({ ok: true, operationId: "op-1" }));
  const cancel = vi.fn(async () => ({ ok: true, cancelled: true }));
  const status = vi.fn(async () => ({ ok: true, status: "pending" }));
  const openExternal = vi.fn();
  const onSuccess = vi.fn(async () => {});
  const subscribe = vi.fn((listener) => {
    emit.mockImplementation(listener);
    return () => {
      unsubscribed += 1;
    };
  });
  const dialog = createMcpLoginDialog({
    name: "sentry",
    start,
    cancel,
    status,
    subscribe,
    openExternal,
    onSuccess,
    ...overrides,
  });
  return {
    dialog,
    emit,
    start,
    cancel,
    status,
    openExternal,
    onSuccess,
    subscribe,
    unsubscribed: () => unsubscribed,
  };
}

function backdrop() {
  return document.querySelector(".mcp-login-dialog-backdrop");
}

function action(name) {
  return document.querySelector(`.mcp-login-dialog [data-action="${name}"]`);
}

describe("mcp login dialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("starts the host login operation and renders the preparing state", async () => {
    const { dialog, start, subscribe } = createHarness();
    await dialog.start();

    expect(start).toHaveBeenCalledTimes(1);
    expect(backdrop()).not.toBeNull();
    expect(document.body.textContent).toContain("Sign in to sentry");
    expect(document.body.textContent).toContain("Starting sign-in…");
    expect(action("oauth-cancel")).not.toBeNull();
    expect(action("oauth-open-browser")).toBeNull(); // no URL yet
    expect(subscribe).toHaveBeenCalledTimes(1);
    dialog.destroy();
  });

  it("renders the authorization URL from the event bridge and opens it externally", async () => {
    const { dialog, emit, openExternal } = createHarness();
    await dialog.start();
    emit({ operationId: "op-1", status: "pending", authUrl: "https://auth.test/authorize?x=1" });

    expect(document.querySelector(".mcp-login-dialog-url").textContent).toBe(
      "https://auth.test/authorize?x=1",
    );
    action("oauth-open-browser").click();
    expect(openExternal).toHaveBeenCalledWith("https://auth.test/authorize?x=1");
    dialog.destroy();
  });

  it("surfaces the URL through the status poll when no event frame arrives", async () => {
    vi.useFakeTimers();
    try {
      const { dialog, status } = createHarness();
      status.mockResolvedValue({ ok: true, status: "pending", authUrl: "https://poll.test/auth" });
      await dialog.start();
      expect(document.querySelector(".mcp-login-dialog-url")).toBeNull();

      await vi.advanceTimersByTimeAsync(1000);
      expect(status).toHaveBeenCalledWith("op-1");
      expect(document.querySelector(".mcp-login-dialog-url").textContent).toBe(
        "https://poll.test/auth",
      );
      dialog.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the dialog and refreshes once on success, then stops polling", async () => {
    vi.useFakeTimers();
    try {
      const { dialog, emit, status, onSuccess, unsubscribed } = createHarness();
      await dialog.start();
      emit({ operationId: "op-1", status: "pending", authUrl: "https://auth.test/x" });
      emit({ operationId: "op-1", status: "succeeded" });

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(backdrop()).toBeNull(); // dialog closed on success
      expect(unsubscribed()).toBe(1);
      const calls = status.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(status.mock.calls.length).toBe(calls); // terminal state stops the poll
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a success that arrives only through polling", async () => {
    vi.useFakeTimers();
    try {
      const { dialog, status, onSuccess } = createHarness();
      status
        .mockResolvedValueOnce({ ok: true, status: "pending" })
        .mockResolvedValue({ ok: true, status: "succeeded" });
      await dialog.start();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(backdrop()).toBeNull();
      dialog.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a redacted failure and retries with a fresh operation", async () => {
    const { dialog, emit, start } = createHarness();
    await dialog.start();
    emit({
      operationId: "op-1",
      status: "failed",
      error: "Authorization: Bearer secret https://x.test/cb?code=abc",
    });

    expect(document.body.textContent).toContain("Sign-in failed.");
    expect(document.body.textContent).not.toMatch(/Bearer|secret|code=abc/);
    action("oauth-retry").click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    // Retry restarts the flow in place: the panel goes back to a pending
    // state instead of keeping the failure actions.
    expect(document.body.textContent).toContain("Sign in to sentry");
    expect(action("oauth-retry")).toBeNull();
    dialog.destroy();
    expect(backdrop()).toBeNull();
  });

  it("cancels the host operation and renders the cancelled state", async () => {
    const { dialog, emit, cancel } = createHarness();
    await dialog.start();
    action("oauth-cancel").click();
    expect(cancel).toHaveBeenCalledWith("op-1");
    expect(action("oauth-cancel").disabled).toBe(true);

    emit({ operationId: "op-1", status: "cancelled" });
    expect(document.body.textContent).toContain("Sign-in cancelled.");
    action("oauth-close").click();
    expect(backdrop()).toBeNull();
  });

  it("ignores frames for another operation", async () => {
    const { dialog, emit } = createHarness();
    await dialog.start();
    emit({ operationId: "op-other", status: "succeeded" });
    expect(backdrop()).not.toBeNull();
    expect(document.body.textContent).toContain("Starting sign-in…");
    dialog.destroy();
  });

  it("renders a start failure and releases the subscription", async () => {
    const { dialog, subscribe, unsubscribed } = createHarness({
      start: vi.fn(async () => ({ ok: false, error: "MCP login already active" })),
    });
    await dialog.start();

    expect(document.body.textContent).toContain("MCP login already active");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribed()).toBe(1);
    action("oauth-close").click();
  });

  it("never leaves a rejected start command unhandled", async () => {
    const { dialog } = createHarness({
      start: vi.fn(async () => {
        throw new Error("MCP login already active for this server");
      }),
    });
    await dialog.start();
    expect(document.body.textContent).toContain("MCP login already active for this server");
    action("oauth-close").click();
  });

  it("destroy releases the subscription and the poll", async () => {
    vi.useFakeTimers();
    try {
      const { dialog, status, unsubscribed } = createHarness();
      await dialog.start();
      dialog.destroy();
      expect(unsubscribed()).toBe(1);
      expect(backdrop()).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      expect(status).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles instead of spinning when the status poll keeps failing", async () => {
    vi.useFakeTimers();
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { dialog, status } = createHarness();
      status.mockRejectedValue(new Error("Control command mcp_login_status timed out"));

      await dialog.start();
      await vi.advanceTimersByTimeAsync(1000);
      // One blip keeps waiting: the operation may still complete.
      expect(action("oauth-retry")).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);

      expect(document.body.textContent).toContain("timed out");
      expect(action("oauth-retry")).not.toBeNull();
      const calls = status.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(status.mock.calls.length).toBe(calls); // polling stopped
      error.mockRestore();
      dialog.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cancel button usable when the host rejects the cancel", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("oauth_operation_not_found");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dialog } = createHarness({ cancel });
    await dialog.start();
    action("oauth-cancel").click();

    await vi.waitFor(() => expect(action("oauth-cancel").disabled).toBe(false));
    error.mockRestore();
    dialog.destroy();
  });

  it("treats a non-ok status response as a terminal failure", async () => {
    vi.useFakeTimers();
    try {
      const { dialog, status } = createHarness();
      status.mockResolvedValue({ ok: false, error: "oauth_operation_not_found" });
      await dialog.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(document.body.textContent).toContain("oauth_operation_not_found");
      expect(backdrop()).not.toBeNull();
      dialog.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
