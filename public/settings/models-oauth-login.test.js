// ABOUTME: JSDOM tests for the owner-scoped Codex device-code login dialog.
// ABOUTME: Verifies rendering, external browser open, cancellation, completion, and redaction.

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createModelsOAuthLoginDialog } from "./models-oauth-login.js";

function deviceCodeEvent(operationId = "op-1") {
  return {
    type: "oauth_event",
    event: {
      type: "oauth_login_device_code",
      operationId,
      provider: "openai-codex",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    },
  };
}

function createHarness(overrides = {}) {
  const emit = vi.fn();
  const command = vi.fn(async () => ({
    success: true,
    data: { operationId: "op-1", provider: "openai-codex", state: "starting" },
  }));
  const openExternal = vi.fn();
  const copyText = vi.fn();
  const onSuccess = vi.fn();
  const subscribe = vi.fn((listener) => {
    emit.mockImplementation(listener);
    return () => {};
  });
  const dialog = createModelsOAuthLoginDialog({
    command,
    subscribe,
    openExternal,
    copyText,
    onSuccess,
    ...overrides,
  });
  return { dialog, emit, command, openExternal, copyText, onSuccess, subscribe };
}

describe("models OAuth login dialog", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost",
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  test("starts the Codex device-code operation and renders non-secret code", async () => {
    const { dialog, emit, command } = createHarness();
    await dialog.start();
    emit(deviceCodeEvent());

    expect(command).toHaveBeenCalledWith({
      type: "start_oauth_login",
      provider: "openai-codex",
      method: "device_code",
    });
    expect(document.body.textContent).toContain("ABCD-EFGH");
    expect(document.body.textContent).toContain("https://example.test/device");
    expect(document.body.textContent).not.toMatch(/access|refresh|authorization[_ -]?code/i);
  });

  test("opens the Pi-provided verification URL externally and copies only the device code", async () => {
    const { dialog, emit, openExternal, copyText } = createHarness();
    await dialog.start();
    emit(deviceCodeEvent());
    document.querySelector('[data-action="oauth-open-browser"]').click();
    document.querySelector('[data-action="oauth-copy-code"]').click();

    expect(openExternal).toHaveBeenCalledWith("https://example.test/device");
    expect(copyText).toHaveBeenCalledWith("ABCD-EFGH");
  });

  test("cancels only the current operation and tears down subscription", async () => {
    const { dialog, command } = createHarness();
    await dialog.start();
    document.querySelector('[data-action="oauth-cancel"]').click();

    expect(command).toHaveBeenCalledWith({
      type: "cancel_oauth_login",
      operationId: "op-1",
    });
    const unsubscribe = vi.fn();
    const emit2 = vi.fn();
    const dialog2 = createModelsOAuthLoginDialog({
      command,
      subscribe: (listener) => {
        emit2.mockImplementation(listener);
        return unsubscribe;
      },
      openExternal: vi.fn(),
      copyText: vi.fn(),
      onSuccess: vi.fn(),
    });
    await dialog2.start();
    dialog2.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("completion invokes refresh once and does not render raw failure secrets", async () => {
    const { dialog, emit, onSuccess } = createHarness();
    await dialog.start();
    emit({
      type: "oauth_event",
      event: {
        type: "oauth_login_complete",
        operationId: "op-1",
        provider: "openai-codex",
      },
    });
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toMatch(/access|refresh|authorization[_ -]?code/i);
  });

  test("ignores events for another operation", async () => {
    const { dialog, emit } = createHarness();
    await dialog.start();
    emit(deviceCodeEvent("other-op"));
    expect(document.body.textContent).not.toContain("ABCD-EFGH");
  });

  test("failure shows a redacted message and allows retry", async () => {
    const { dialog, emit, command } = createHarness();
    await dialog.start();
    emit({
      type: "oauth_event",
      event: {
        type: "oauth_login_failed",
        operationId: "op-1",
        provider: "openai-codex",
        message: "token=secret Authorization: Bearer abc",
      },
    });
    expect(document.body.textContent).not.toMatch(/secret|Bearer|token=/i);
    const retry = document.querySelector('[data-action="oauth-retry"]');
    expect(retry).not.toBeNull();
    retry.click();
    expect(command).toHaveBeenCalledWith({
      type: "start_oauth_login",
      provider: "openai-codex",
      method: "device_code",
    });
  });
  test("countdown and progress messages coexist in separate nodes", async () => {
    const { dialog, emit } = createHarness();
    // Start with real timers so the async start command resolves normally;
    // only the countdown interval needs to be faked.
    await dialog.start();
    vi.useFakeTimers();
    try {
      emit(deviceCodeEvent());
      emit({
        type: "oauth_event",
        event: {
          type: "oauth_login_progress",
          operationId: "op-1",
          message: "Waiting for authorization",
        },
      });

      const countdownEl = document.querySelector(".oauth-login-dialog-countdown");
      const statusEl = document.querySelector(".oauth-login-dialog-status");
      expect(countdownEl?.textContent).toBe("600s");
      expect(statusEl?.textContent).toBe("Waiting for authorization");

      // After one tick the countdown decrements while the progress message
      // stays intact — neither clobbers the other.
      vi.advanceTimersByTime(1000);
      expect(countdownEl?.textContent).toBe("599s");
      expect(statusEl?.textContent).toBe("Waiting for authorization");
    } finally {
      vi.useRealTimers();
    }
  });

  test("renders the expired state and notifies onTerminal", async () => {
    const onTerminal = vi.fn();
    const { dialog, emit } = createHarness({ onTerminal });
    await dialog.start();
    emit({
      type: "oauth_event",
      event: {
        type: "oauth_login_expired",
        operationId: "op-1",
        provider: "openai-codex",
      },
    });
    expect(document.querySelector('[data-action="oauth-retry"]')).not.toBeNull();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  test("surfaces a start failure instead of leaving the dialog silent", async () => {
    const command = vi.fn(async () => ({ success: false, error: "Model runtime not ready" }));
    const { dialog } = createHarness({ command });
    await dialog.start();
    expect(document.querySelector('[data-action="oauth-retry"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Model runtime not ready");
  });

  test("invokes onTerminal on cancelled and failed terminal states", async () => {
    const onTerminal = vi.fn();
    const { dialog, emit } = createHarness({ onTerminal });
    await dialog.start();
    emit({
      type: "oauth_event",
      event: {
        type: "oauth_login_failed",
        operationId: "op-1",
        provider: "openai-codex",
        message: "boom",
      },
    });
    emit({
      type: "oauth_event",
      event: {
        type: "oauth_login_cancelled",
        operationId: "op-1",
        provider: "openai-codex",
      },
    });
    expect(onTerminal).toHaveBeenCalledTimes(2);
  });
});
