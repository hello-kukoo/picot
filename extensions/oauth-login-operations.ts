// ABOUTME: Owns in-memory, desktop-owner-bound Pi OAuth login operations.
// ABOUTME: Projects only non-secret device-code progress and terminal states to the WebView.

import { randomUUID } from "node:crypto";
import type { OAuthDeviceCode } from "./pi-oauth-login-adapter.ts";

/**
 * Structural owner-connection identity: the initiating WebSocket object.
 * Mirrors embedded-server's `OAuthOwnerConnection` shape without importing it, so this
 * module stays free of the embedded-server dependency cycle.
 */
export type OAuthOwnerConnection = {
  readyState: number;
  send: (data: string) => unknown;
  close: () => void;
  terminate: () => void;
  ping: () => void;
  isAlive?: boolean;
};

export type OAuthOperationState =
  | "starting"
  | "awaiting_device_authorization"
  | "polling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type OAuthOperationEvent =
  | {
      type: "oauth_login_device_code";
      operationId: string;
      provider: "openai-codex";
      verificationUri: string;
      userCode: string;
      expiresInSeconds?: number;
      intervalSeconds?: number;
    }
  | { type: "oauth_login_progress"; operationId: string; message: string }
  | {
      type:
        | "oauth_login_complete"
        | "oauth_login_failed"
        | "oauth_login_cancelled"
        | "oauth_login_expired";
      operationId: string;
      provider: "openai-codex";
      message?: string;
    };

export type OAuthLoginOperationManager = {
  start(
    ownerConnection: OAuthOwnerConnection,
    processGeneration: number,
    provider: "openai-codex",
  ): {
    operationId: string;
    signal: AbortSignal;
  };
  bindDeviceCode(
    ownerConnection: OAuthOwnerConnection,
    operationId: string,
    code: OAuthDeviceCode,
  ): OAuthOperationEvent;
  bindProgress(
    ownerConnection: OAuthOwnerConnection,
    operationId: string,
    message: string,
  ): OAuthOperationEvent;
  complete(ownerConnection: OAuthOwnerConnection, operationId: string): OAuthOperationEvent;
  fail(
    ownerConnection: OAuthOwnerConnection,
    operationId: string,
    error: unknown,
  ): OAuthOperationEvent;
  cancel(ownerConnection: OAuthOwnerConnection, operationId: string): OAuthOperationEvent;
  expire(ownerConnection: OAuthOwnerConnection, operationId: string): OAuthOperationEvent;
  getStatus(
    ownerConnection: OAuthOwnerConnection,
    operationId: string,
  ): {
    provider: "openai-codex";
    state: OAuthOperationState;
  };
  abortAllForOwner(ownerConnection: OAuthOwnerConnection): void;
  abortAllForGenerationChange(): void;
};

type OAuthOperation = {
  operationId: string;
  ownerConnection: OAuthOwnerConnection;
  processGeneration: number;
  provider: "openai-codex";
  state: OAuthOperationState;
  controller: AbortController;
};

const PROVIDER = "openai-codex";

/**
 * Strip token-like material from a failure message before it reaches the
 * WebView: "Authorization: Bearer <token>" units, bare "Bearer <token>",
 * key=value / key: value credential pairs, and URL query fragments. Falls
 * back to a fixed message when nothing safe remains.
 */
export function sanitizeOAuthError(raw: unknown): string {
  const collapsed = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = collapsed
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s]+/gi, " [redacted]")
    .replace(/\bbearer\s+[^\s]+/gi, " [redacted]")
    .replace(
      /\b(?:token|refresh|access|secret|code|key|authorization)\b\s*=\s*[^\s]+/gi,
      " [redacted]",
    )
    .replace(
      /\b(?:token|refresh|access|secret|code|key|authorization)\b\s*:\s*[^\s]+/gi,
      " [redacted]",
    )
    .replace(/[?&][^\s]*/g, " [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
  // If redaction left no readable content (only redaction markers), fall back
  // to a fixed message so the WebView never shows a bare placeholder.
  const meaningful = bounded.replace(/\[redacted\]/g, "").trim();
  return meaningful ? bounded : "OAuth login failed";
}

export function createOAuthLoginOperationManager(
  options: { createId?: () => string } = {},
): OAuthLoginOperationManager {
  const createId = options.createId ?? (() => randomUUID());
  let active: OAuthOperation | null = null;

  function assertOwner(
    operation: OAuthOperation,
    ownerConnection: OAuthOwnerConnection,
    operationId: string,
  ) {
    if (operation.ownerConnection !== ownerConnection) {
      throw new Error("OAuth operation is not owned by this client");
    }
    if (operation.operationId !== operationId) {
      throw new Error("OAuth operation not found");
    }
  }

  function removeActive(operation: OAuthOperation) {
    if (active === operation) active = null;
  }

  function terminal(operation: OAuthOperation, event: OAuthOperationEvent): OAuthOperationEvent {
    removeActive(operation);
    return event;
  }

  return {
    start(ownerConnection, processGeneration, provider) {
      if (provider !== PROVIDER) {
        throw new Error(`Unsupported OAuth provider: ${provider}`);
      }
      if (active) {
        throw new Error("OAuth login already in progress");
      }
      const operation: OAuthOperation = {
        operationId: createId(),
        ownerConnection,
        processGeneration,
        provider,
        state: "starting",
        controller: new AbortController(),
      };
      active = operation;
      return { operationId: operation.operationId, signal: operation.controller.signal };
    },

    bindDeviceCode(ownerConnection, operationId, code) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.state = "awaiting_device_authorization";
      return {
        type: "oauth_login_device_code",
        operationId: active.operationId,
        provider: PROVIDER,
        verificationUri: code.verificationUri,
        userCode: code.userCode,
        ...(code.expiresInSeconds !== undefined ? { expiresInSeconds: code.expiresInSeconds } : {}),
        ...(code.intervalSeconds !== undefined ? { intervalSeconds: code.intervalSeconds } : {}),
      };
    },

    bindProgress(ownerConnection, operationId, message) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.state = "polling";
      return {
        type: "oauth_login_progress",
        operationId: active.operationId,
        message,
      };
    },

    complete(ownerConnection, operationId) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.state = "succeeded";
      return terminal(active, {
        type: "oauth_login_complete",
        operationId: active.operationId,
        provider: PROVIDER,
      });
    },

    fail(ownerConnection, operationId, error) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.state = "failed";
      return terminal(active, {
        type: "oauth_login_failed",
        operationId: active.operationId,
        provider: PROVIDER,
        message: sanitizeOAuthError(error),
      });
    },

    cancel(ownerConnection, operationId) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.controller.abort();
      active.state = "cancelled";
      return terminal(active, {
        type: "oauth_login_cancelled",
        operationId: active.operationId,
        provider: PROVIDER,
      });
    },

    expire(ownerConnection, operationId) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      active.state = "expired";
      return terminal(active, {
        type: "oauth_login_expired",
        operationId: active.operationId,
        provider: PROVIDER,
      });
    },

    getStatus(ownerConnection, operationId) {
      if (!active) throw new Error("OAuth operation not found");
      assertOwner(active, ownerConnection, operationId);
      return { provider: PROVIDER, state: active.state };
    },

    abortAllForOwner(ownerConnection) {
      if (active && active.ownerConnection === ownerConnection) {
        active.controller.abort();
        removeActive(active);
      }
    },

    abortAllForGenerationChange() {
      if (active) {
        active.controller.abort();
        removeActive(active);
      }
    },
  };
}
