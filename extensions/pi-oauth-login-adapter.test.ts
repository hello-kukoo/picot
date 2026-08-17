// ABOUTME: Contract tests for the Phase-0 verified Pi Codex device-code OAuth adapter.
// ABOUTME: Uses a fake public login surface; no real OAuth network calls or secrets.

import { describe, expect, test } from "vitest";
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthType,
  createPiOAuthLoginAdapter,
  type OAuthDeviceCode,
  type PiOAuthLoginEvents,
  probeCodexDeviceCodeCapability,
  type VerifiedPublicPiRuntime,
} from "./pi-oauth-login-adapter.ts";

/** Minimal fake of the public ModelRuntime surface verified in Phase 0. */
function fakeSupportedSurface(
  options: {
    deviceCode?: OAuthDeviceCode;
    progress?: string;
    authUrl?: string;
    loginReject?: Error;
    providerResult?: { access: string; refresh: string; authorizationCode: string };
  } = {},
): VerifiedPublicPiRuntime {
  return {
    async login(_providerId: string, _type: AuthType, interaction: AuthInteraction) {
      if (options.loginReject) throw options.loginReject;
      interaction.notify({
        type: "device_code",
        userCode: options.deviceCode?.userCode ?? "ABCD-EFGH",
        verificationUri: options.deviceCode?.verificationUri ?? "https://example.test/device",
        ...(options.deviceCode?.intervalSeconds !== undefined
          ? { intervalSeconds: options.deviceCode.intervalSeconds }
          : {}),
        ...(options.deviceCode?.expiresInSeconds !== undefined
          ? { expiresInSeconds: options.deviceCode.expiresInSeconds }
          : {}),
      });
      if (options.progress) interaction.notify({ type: "progress", message: options.progress });
      if (options.authUrl) interaction.notify({ type: "auth_url", url: options.authUrl });
      const secretShape = options.providerResult ?? {
        access: "access-secret",
        refresh: "refresh-secret",
        authorizationCode: "code-secret",
      };
      return { type: "oauth", ...secretShape } as never;
    },
    async checkAuth() {
      return { configured: false };
    },
    async logout() {},
  };
}

test("reports provider-unavailable when openai-codex is absent", async () => {
  const adapter = createPiOAuthLoginAdapter({
    login: async () => ({ type: "oauth" }) as never,
    checkAuth: async () => {
      throw new Error("unknown provider: openai-codex");
    },
    logout: async () => {},
  });
  await expect(adapter.getCodexCapability()).resolves.toMatchObject({
    kind: "provider-unavailable",
  });
});

test("reports unsupported when the runtime exposes no login method", async () => {
  const adapter = createPiOAuthLoginAdapter({ checkAuth: async () => ({}) } as never);
  await expect(adapter.getCodexCapability()).resolves.toMatchObject({ kind: "unsupported" });
});

test("reports supported for a runtime exposing ModelRuntime.login and checkAuth", async () => {
  const adapter = createPiOAuthLoginAdapter(fakeSupportedSurface());
  await expect(adapter.getCodexCapability()).resolves.toEqual({
    kind: "supported",
    provider: "openai-codex",
    methods: ["device_code"],
  });
});

test("forwards a non-secret device-code event and progress", async () => {
  const events: unknown[] = [];
  const adapter = createPiOAuthLoginAdapter(
    fakeSupportedSurface({
      deviceCode: {
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      },
      progress: "Waiting for authorization",
    }),
  );
  await adapter.startCodexDeviceCodeLogin(
    {
      onDeviceCode: (value) => events.push({ type: "device", ...value }),
      onProgress: (message) => events.push({ type: "progress", message }),
    } as PiOAuthLoginEvents,
    new AbortController().signal,
  );

  expect(events).toEqual([
    {
      type: "device",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    },
    { type: "progress", message: "Waiting for authorization" },
  ]);
});

test("omits optional device-code fields when Pi omits them", async () => {
  const events: unknown[] = [];
  const adapter = createPiOAuthLoginAdapter(fakeSupportedSurface({}));
  await adapter.startCodexDeviceCodeLogin(
    {
      onDeviceCode: (value) => events.push(value),
      onProgress: () => {},
    } as PiOAuthLoginEvents,
    new AbortController().signal,
  );

  expect(events).toEqual([
    {
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.test/device",
    },
  ]);
});

test("never includes credential-shaped fields in emitted events", async () => {
  const emitted: unknown[] = [];
  const adapter = createPiOAuthLoginAdapter(
    fakeSupportedSurface({
      providerResult: {
        access: "access-secret",
        refresh: "refresh-secret",
        authorizationCode: "code-secret",
      },
    }),
  );

  await adapter.startCodexDeviceCodeLogin(
    {
      onDeviceCode: (value) => emitted.push(value),
      onProgress: (message) => emitted.push({ message }),
    } as PiOAuthLoginEvents,
    new AbortController().signal,
  );

  expect(JSON.stringify(emitted)).not.toContain("access-secret");
  expect(JSON.stringify(emitted)).not.toContain("refresh-secret");
  expect(JSON.stringify(emitted)).not.toContain("code-secret");
});

test("propagates cancellation without converting it into success", async () => {
  const controller = new AbortController();
  const adapter = createPiOAuthLoginAdapter(
    fakeSupportedSurface({
      loginReject: Object.assign(new Error("aborted"), { name: "AbortError" }),
    }),
  );
  const started = adapter.startCodexDeviceCodeLogin(
    { onDeviceCode: () => {}, onProgress: () => {} } as PiOAuthLoginEvents,
    controller.signal,
  );
  await expect(started).rejects.toMatchObject({ name: "AbortError" });
});

describe("probeCodexDeviceCodeCapability", () => {
  test("reports unsupported when the runtime exposes no login method", async () => {
    await expect(
      probeCodexDeviceCodeCapability({}, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });

  test("records device-code and progress reachability, then reports supported", async () => {
    const probeRuntime = {
      login: (_providerId: string, _type: string, interaction: AuthInteraction) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://example.test/device",
        } satisfies AuthEvent);
        interaction.notify({ type: "progress", message: "waiting" } satisfies AuthEvent);
        return Promise.resolve({ type: "oauth" } as never);
      },
    };
    await expect(
      probeCodexDeviceCodeCapability(probeRuntime, new AbortController().signal),
    ).resolves.toEqual({
      kind: "supported",
      provider: "openai-codex",
      sawDeviceCode: true,
      sawProgress: true,
    });
  });

  test("treats AbortError as a successful reachability probe", async () => {
    const probeRuntime = {
      login: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    };
    await expect(
      probeCodexDeviceCodeCapability(probeRuntime, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "supported" });
  });

  test("sanitizes non-abort failures into a bounded reason", async () => {
    const probeRuntime = {
      login: () =>
        Promise.reject(new Error("token=secret&code=secret Authorization: Bearer secret")),
    };
    const result = await probeCodexDeviceCodeCapability(probeRuntime, new AbortController().signal);
    expect(result.kind).toBe("provider-unavailable");
    if (result.kind === "provider-unavailable") {
      expect(JSON.stringify(result.reason)).not.toMatch(/secret|Bearer/i);
    }
  });
});
