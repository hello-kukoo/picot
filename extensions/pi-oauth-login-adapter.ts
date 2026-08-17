// ABOUTME: Adapts Pi's verified public Codex device-code OAuth API for Picot.
// ABOUTME: Emits only non-secret device-code and progress data; Pi owns tokens and persistence.

import type { AuthEvent, AuthInteraction, AuthType, Credential } from "@earendil-works/pi-ai";

export type { AuthEvent, AuthInteraction, AuthType };

/**
 * Device-code payload forwarded to the WebView. `expiresInSeconds` and
 * `intervalSeconds` are optional because Pi's `AuthEvent.device_code` event
 * declares them optional; the dialog hides its countdown when absent.
 */
export type OAuthDeviceCode = {
  verificationUri: string;
  userCode: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
};

/** Non-secret login events projected to the Picot UI. */
export type PiOAuthLoginEvents = {
  onDeviceCode(deviceCode: OAuthDeviceCode): void;
  onProgress(message: string): void;
  onAuthUrl?(url: string, instructions?: string): void;
  onInfo?(message: string): void;
};

export type OAuthCapability =
  | { kind: "supported"; provider: "openai-codex"; methods: ["device_code"] }
  | { kind: "provider-unavailable"; reason: string }
  | { kind: "unsupported"; reason: string };

/**
 * The public Pi `ModelRuntime` surface Phase 0 verified: `login()`,
 * `checkAuth()`, `getProviderAuthStatus()`, and `logout()` are declared on
 * the exported class; `AuthInteraction` is caller-supplied so Picot injects
 * the device-code/progress projection and an AbortSignal.
 */
export type VerifiedPublicPiRuntime = {
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  checkAuth(providerId: string): Promise<{ configured?: boolean } | undefined>;
  logout(providerId: string): Promise<void>;
};

export type PiOAuthLoginAdapter = {
  getCodexCapability(): Promise<OAuthCapability>;
  startCodexDeviceCodeLogin(events: PiOAuthLoginEvents, signal: AbortSignal): Promise<void>;
};

/**
 * Create the adapter over the verified public Pi runtime surface. The runtime
 * is the caller-provided ModelRuntime (or a test fake conforming to
 * VerifiedPublicPiRuntime); no private fields, reflection, or property probing.
 */
export function createPiOAuthLoginAdapter(runtime: VerifiedPublicPiRuntime): PiOAuthLoginAdapter {
  return {
    async getCodexCapability(): Promise<OAuthCapability> {
      if (!runtime || typeof runtime.login !== "function") {
        return { kind: "unsupported", reason: "Pi runtime does not expose ModelRuntime.login" };
      }
      try {
        await runtime.checkAuth("openai-codex");
      } catch {
        return {
          kind: "provider-unavailable",
          reason: "openai-codex is not a registered provider",
        };
      }
      return { kind: "supported", provider: "openai-codex", methods: ["device_code"] };
    },

    async startCodexDeviceCodeLogin(
      events: PiOAuthLoginEvents,
      signal: AbortSignal,
    ): Promise<void> {
      const interaction: AuthInteraction = {
        signal,
        prompt: async () => {
          throw new Error("Codex device-code flow does not require manual input");
        },
        notify: (event: AuthEvent) => {
          switch (event.type) {
            case "device_code":
              events.onDeviceCode({
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                ...(event.intervalSeconds !== undefined
                  ? { intervalSeconds: event.intervalSeconds }
                  : {}),
                ...(event.expiresInSeconds !== undefined
                  ? { expiresInSeconds: event.expiresInSeconds }
                  : {}),
              });
              break;
            case "progress":
              events.onProgress(event.message);
              break;
            case "auth_url":
              events.onAuthUrl?.(event.url, event.instructions);
              break;
            case "info":
              events.onInfo?.(event.message);
              break;
          }
        },
      };
      await runtime.login("openai-codex", "oauth", interaction);
    },
  };
}

/**
 * Development-only Phase 0 probe (no production command). Establishes that
 * the embedded runtime can reach an openai-codex device-code flow and that
 * cancellation works, without completing a real login. Output contains only
 * booleans and sanitized reason text — never a user code, verification URL,
 * credential, authorization code, or raw exception.
 */
export type CodexDeviceCodeProbeResult =
  | { kind: "supported"; provider: "openai-codex"; sawDeviceCode: boolean; sawProgress: boolean }
  | { kind: "provider-unavailable"; reason: string }
  | { kind: "unsupported"; reason: string };

export async function probeCodexDeviceCodeCapability(
  runtime: unknown,
  signal: AbortSignal,
): Promise<CodexDeviceCodeProbeResult> {
  const candidate = runtime as Partial<VerifiedPublicPiRuntime> | null;
  if (!candidate || typeof candidate.login !== "function") {
    return {
      kind: "unsupported",
      reason: "ModelRuntime.login is not exposed by the embedded runtime",
    };
  }
  let sawDeviceCode = false;
  let sawProgress = false;
  try {
    await candidate.login("openai-codex", "oauth", {
      signal,
      prompt: async () => {
        throw new Error("Codex device-code flow does not require manual input");
      },
      notify: (event: AuthEvent) => {
        if (event.type === "device_code") sawDeviceCode = true;
        if (event.type === "progress") sawProgress = true;
      },
    });
  } catch (error) {
    if ((error as Error | null)?.name === "AbortError") {
      // Reached the flow and cancelled — exactly the probe's goal.
    } else {
      return {
        kind: "provider-unavailable",
        reason: sanitizeProbeReason((error as Error | null)?.message ?? String(error)),
      };
    }
  }
  return { kind: "supported", provider: "openai-codex", sawDeviceCode, sawProgress };
}

/**
 * Strip token-like material from a probe failure before it reaches the
 * WebView: "Authorization: Bearer <token>" units, bare "Bearer <token>",
 * key=value / key: value credential pairs, and URL query fragments. Falls
 * back to a fixed message when nothing safe remains.
 */
export function sanitizeProbeReason(raw: string): string {
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
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
  const bounded = redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted;
  // If redaction left no readable content (only redaction markers), fall back
  // to a fixed message so the WebView never shows a bare placeholder.
  const meaningful = bounded.replace(/\[redacted\]/g, "").trim();
  return meaningful ? bounded : "login failed";
}
