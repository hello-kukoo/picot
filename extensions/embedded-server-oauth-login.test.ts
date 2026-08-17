// @vitest-environment node

// ABOUTME: Verifies the embedded-server OAuth bridge contract via the operation
// ABOUTME: manager + adapter combination: owner scoping, event ordering, and refresh semantics.

import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { assertNonEphemeralOAuthCommand } from "./embedded-server.ts";
import {
  createOAuthLoginOperationManager,
  type OAuthOperationEvent,
  type OAuthOwnerConnection,
} from "./oauth-login-operations.ts";
import {
  type AuthInteraction,
  type AuthType,
  createPiOAuthLoginAdapter,
  type VerifiedPublicPiRuntime,
} from "./pi-oauth-login-adapter.ts";

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

/** Fake runtime that drives the device-code sequence like the real Pi flow. */
function fakePiRuntime(): VerifiedPublicPiRuntime {
  return {
    async login(_providerId: string, _type: AuthType, interaction: AuthInteraction) {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      });
      interaction.notify({ type: "progress", message: "Waiting for authorization" });
      return { type: "oauth" } as Credential;
    },
    async checkAuth() {
      return undefined;
    },
    async logout() {},
  };
}

describe("embedded-server OAuth bridge contract", () => {
  test("start returns an opaque operation id and forwards device-code + progress to the owner", async () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const adapter = createPiOAuthLoginAdapter(fakePiRuntime());
    const owner = createTestSocket("owner");
    const frames: OAuthOperationEvent[] = [];
    const started = manager.start(owner, 1, "openai-codex");
    expect(started.operationId).toBe("op-1");
    expect(JSON.stringify(started)).not.toContain("token");
    expect(JSON.stringify(started)).not.toContain("secret");

    await adapter.startCodexDeviceCodeLogin(
      {
        onDeviceCode: (code) => frames.push(manager.bindDeviceCode(owner, "op-1", code)),
        onProgress: (message) => frames.push(manager.bindProgress(owner, "op-1", message)),
      },
      started.signal,
    );

    expect(frames).toEqual([
      {
        type: "oauth_login_device_code",
        operationId: "op-1",
        provider: "openai-codex",
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      },
      { type: "oauth_login_progress", operationId: "op-1", message: "Waiting for authorization" },
    ]);
  });

  test("a different owner cannot query or cancel the operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("owner");
    const other = createTestSocket("other");
    manager.start(owner, 1, "openai-codex");
    expect(() => manager.getStatus(other, "op-1")).toThrow(
      "OAuth operation is not owned by this client",
    );
    expect(() => manager.cancel(other, "op-1")).toThrow(
      "OAuth operation is not owned by this client",
    );
  });

  test("cancel aborts the adapter signal and emits a terminal event", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("owner");
    const { signal } = manager.start(owner, 1, "openai-codex");
    const event = manager.cancel(owner, "op-1");
    expect(signal.aborted).toBe(true);
    expect(event).toMatchObject({ type: "oauth_login_cancelled", operationId: "op-1" });
  });

  test("success completion permits a single catalog refresh decision", async () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const adapter = createPiOAuthLoginAdapter(fakePiRuntime());
    const owner = createTestSocket("owner");
    const started = manager.start(owner, 1, "openai-codex");
    let refreshCount = 0;
    const refresh = () => {
      refreshCount += 1;
    };

    await adapter.startCodexDeviceCodeLogin(
      { onDeviceCode: () => {}, onProgress: () => {} },
      started.signal,
    );
    // Bridge success path: complete then refresh exactly once.
    manager.complete(owner, "op-1");
    refresh();
    expect(refreshCount).toBe(1);
    // The operation is removed, so a second completion must throw (not double-refresh).
    expect(() => manager.complete(owner, "op-1")).toThrow("OAuth operation not found");
  });

  test("failure emits a sanitized terminal event and never claims success", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("owner");
    manager.start(owner, 1, "openai-codex");
    const event = manager.fail(
      owner,
      "op-1",
      new Error("token=secret&code=secret Authorization: Bearer secret"),
    );
    expect(event).toMatchObject({ type: "oauth_login_failed", operationId: "op-1" });
    expect(JSON.stringify(event)).not.toMatch(/secret|Bearer|token=|code=/i);
    // Failed operation is removed: no refresh should follow.
    expect(() => manager.getStatus(owner, "op-1")).toThrow("OAuth operation not found");
  });

  test("expiry emits oauth_login_expired and clears the operation", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("owner");
    manager.start(owner, 1, "openai-codex");
    const event = manager.expire(owner, "op-1");
    expect(event).toMatchObject({ type: "oauth_login_expired", operationId: "op-1" });
    expect(() => manager.getStatus(owner, "op-1")).toThrow("OAuth operation not found");
  });

  test("closing the initiating socket aborts its operation without replay", () => {
    const manager = createOAuthLoginOperationManager({ createId: () => "op-1" });
    const owner = createTestSocket("owner");
    const { signal } = manager.start(owner, 1, "openai-codex");
    manager.abortAllForOwner(owner);
    expect(signal.aborted).toBe(true);
    // A later connection cannot observe the old operation.
    const later = createTestSocket("later");
    expect(() => manager.getStatus(later, "op-1")).toThrow("OAuth operation not found");
  });
});

describe("embedded-server OAuth ephemeral gate", () => {
  test("assertNonEphemeralOAuthCommand rejects in an ephemeral runtime", () => {
    const previousKind = process.env.PI_STUDIO_EPHEMERAL_KIND;
    const previousId = process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
    const previousGen = process.env.PI_STUDIO_EPHEMERAL_GENERATION;
    process.env.PI_STUDIO_EPHEMERAL_KIND = "quick-chat";
    process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID = "ephemeral-1";
    process.env.PI_STUDIO_EPHEMERAL_GENERATION = "1";
    try {
      expect(() => assertNonEphemeralOAuthCommand("start_oauth_login")).toThrow(
        "OAuth login commands are not available in temporary chat",
      );
    } finally {
      if (previousKind === undefined) delete process.env.PI_STUDIO_EPHEMERAL_KIND;
      else process.env.PI_STUDIO_EPHEMERAL_KIND = previousKind;
      if (previousId === undefined) delete process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
      else process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID = previousId;
      if (previousGen === undefined) delete process.env.PI_STUDIO_EPHEMERAL_GENERATION;
      else process.env.PI_STUDIO_EPHEMERAL_GENERATION = previousGen;
    }
  });

  test("assertNonEphemeralOAuthCommand allows in a desktop runtime", () => {
    const previousKind = process.env.PI_STUDIO_EPHEMERAL_KIND;
    delete process.env.PI_STUDIO_EPHEMERAL_KIND;
    delete process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
    delete process.env.PI_STUDIO_EPHEMERAL_GENERATION;
    try {
      expect(() => assertNonEphemeralOAuthCommand("start_oauth_login")).not.toThrow();
    } finally {
      if (previousKind !== undefined) process.env.PI_STUDIO_EPHEMERAL_KIND = previousKind;
    }
  });
});
