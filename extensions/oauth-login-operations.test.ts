// ABOUTME: Unit tests for owner-bound OAuth operation ownership, lifecycle, and redaction.
// ABOUTME: Verifies transitions, cancellation, no-secret event payloads, and cleanup.

import { describe, expect, test } from "vitest";
import {
  createOAuthLoginOperationManager,
  type OAuthOwnerConnection,
  sanitizeOAuthError,
} from "./oauth-login-operations.ts";

function createTestSocket(id = "ws"): OAuthOwnerConnection {
  const ws = {
    readyState: 1,
    send: () => {},
    close: () => {},
    terminate: () => {},
    ping: () => {},
  } as OAuthOwnerConnection;
  Object.defineProperty(ws, "socketId", { value: id });
  return ws;
}

describe("oauth login operation manager", () => {
  test("allows one active operation and rejects a second", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const ownerA = createTestSocket("a");
    const ownerB = createTestSocket("b");
    manager.start(ownerA, 1, "openai-codex");
    expect(() => manager.start(ownerB, 1, "openai-codex")).toThrow(
      "OAuth login already in progress",
    );
  });

  test("rejects a different owner reading or cancelling an operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const ownerA = createTestSocket("a");
    const ownerB = createTestSocket("b");
    manager.start(ownerA, 1, "openai-codex");
    expect(() => manager.getStatus(ownerB, "op-1")).toThrow(
      "OAuth operation is not owned by this client",
    );
    expect(() => manager.cancel(ownerB, "op-1")).toThrow(
      "OAuth operation is not owned by this client",
    );
  });

  test("cancel aborts and emits a terminal owner-scoped event", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    const { signal } = manager.start(owner, 1, "openai-codex");
    const event = manager.cancel(owner, "op-1");
    expect(signal.aborted).toBe(true);
    expect(event).toMatchObject({ type: "oauth_login_cancelled", operationId: "op-1" });
  });

  test("sanitizes failure messages", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    manager.start(owner, 1, "openai-codex");
    const event = manager.fail(
      owner,
      "op-1",
      new Error("token=secret&code=secret Authorization: Bearer secret"),
    );
    expect(JSON.stringify(event)).not.toMatch(/secret|Authorization|token=|code=/i);
  });

  test("device-code and progress events carry no credential fields", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    manager.start(owner, 1, "openai-codex");
    const codeEvent = manager.bindDeviceCode(owner, "op-1", {
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    expect(codeEvent).toMatchObject({
      type: "oauth_login_device_code",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    expect(JSON.stringify(codeEvent)).not.toMatch(/access|refresh|authorization[_ -]?code/i);

    const progressEvent = manager.bindProgress(owner, "op-1", "Waiting for authorization");
    expect(progressEvent).toMatchObject({
      type: "oauth_login_progress",
      message: "Waiting for authorization",
    });
  });

  test("terminal events remove the active operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    manager.start(owner, 1, "openai-codex");
    manager.complete(owner, "op-1");
    // After completion a new operation may start.
    const second = manager.start(owner, 1, "openai-codex");
    expect(second.operationId).toBe("op-1");
  });

  test("abortAllForOwner aborts only the matching owner's operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const ownerA = createTestSocket("a");
    const ownerB = createTestSocket("b");
    const { signal } = manager.start(ownerA, 1, "openai-codex");
    manager.abortAllForOwner(ownerB);
    expect(signal.aborted).toBe(false);
    manager.abortAllForOwner(ownerA);
    expect(signal.aborted).toBe(true);
  });

  test("abortAllForGenerationChange aborts the active operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    const { signal } = manager.start(owner, 1, "openai-codex");
    manager.abortAllForGenerationChange();
    expect(signal.aborted).toBe(true);
  });

  test("getStatus reports the current state", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("a");
    manager.start(owner, 1, "openai-codex");
    expect(manager.getStatus(owner, "op-1")).toEqual({
      provider: "openai-codex",
      state: "starting",
    });
    manager.bindDeviceCode(owner, "op-1", {
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
    });
    expect(manager.getStatus(owner, "op-1").state).toBe("awaiting_device_authorization");
  });
});

describe("sanitizeOAuthError", () => {
  test("removes query strings, Authorization fragments, and credential pairs", () => {
    const out = sanitizeOAuthError("token=secret&code=secret Authorization: Bearer secret");
    expect(out).not.toMatch(/secret|Bearer|token=|code=/i);
  });

  test("truncates long messages", () => {
    const long = `A very long error ${"x".repeat(400)} with token=abc`;
    const out = sanitizeOAuthError(long);
    expect(out.length).toBeLessThanOrEqual(243);
  });

  test("falls back to a fixed message when nothing safe remains", () => {
    expect(sanitizeOAuthError("Bearer abc123")).toBe("OAuth login failed");
  });
});

test("cancel after a terminal state throws (bridge tolerates it)", () => {
  const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
  const owner = createTestSocket("a");
  manager.start(owner, 1, "openai-codex");
  manager.cancel(owner, "op-1");
  // The operation is gone; a second cancel (e.g. AbortError race) must not
  // silently succeed — the bridge wraps it in try/catch.
  expect(() => manager.cancel(owner, "op-1")).toThrow("OAuth operation not found");
});
