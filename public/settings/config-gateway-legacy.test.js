// ABOUTME: Verifies the ConfigGateway host-control mapping and error/timeout shape.
// ABOUTME: Locks per-file targets so a settings save can never write the wrong file.

import { afterEach, describe, expect, test, vi } from "vitest";
import { LegacyConfigGateway } from "./config-gateway-legacy.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeTransport() {
  return {
    settingsGet: vi.fn(async () => ({ value: {}, path: "" })),
    settingsPut: vi.fn(async () => ({ saved: true })),
    agentTextFileGet: vi.fn(async () => ({ content: "", path: "" })),
    agentTextFilePut: vi.fn(async () => ({ saved: true })),
    openExternal: vi.fn(async () => ({})),
    getOauthLoginCapabilities: vi.fn(async () => ({ providers: [] })),
    logoutOauthLogin: vi.fn(async () => ({})),
  };
}

describe("LegacyConfigGateway", () => {
  test("reports model catalog as unsupported instead of calling a retired surface", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("list_model_catalog"),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("no native runtime implementation"),
    });
    // The gap must not be papered over with a request to any other host op.
    expect(transport.settingsGet).not.toHaveBeenCalled();
    expect(transport.agentTextFileGet).not.toHaveBeenCalled();
    expect(transport.getOauthLoginCapabilities).not.toHaveBeenCalled();
  });

  test("writes models.json through the JSON control that keeps the host backup", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("write_models_config", {
        content: '{"providers":{}}',
      }),
    ).resolves.toEqual({ ok: true });
    expect(transport.settingsPut).toHaveBeenCalledWith("models.json", { providers: {} }, "global");
    expect(transport.agentTextFilePut).not.toHaveBeenCalled();
  });

  test("writes agent config to settings.json, never to an agent instruction file", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("write_agent_config", {
        content: '{"theme":"dark"}',
      }),
    ).resolves.toEqual({ ok: true });
    expect(transport.settingsPut).toHaveBeenCalledWith(
      "settings.json",
      { theme: "dark" },
      "global",
    );
  });

  test("rejects malformed JSON before it reaches the host", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("write_models_config", { content: "{oops" }),
    ).resolves.toEqual({ ok: false, error: "Config must be valid JSON" });
    expect(transport.settingsPut).not.toHaveBeenCalled();
  });

  test("reads AGENTS.md as text through the host text-file control", async () => {
    const transport = fakeTransport();
    transport.agentTextFileGet.mockResolvedValueOnce({
      content: "# Global rules",
      path: "/home/.pi/agent/AGENTS.md",
    });

    await expect(new LegacyConfigGateway({ transport }).call("read_agents_md")).resolves.toEqual({
      ok: true,
      data: { path: "/home/.pi/agent/AGENTS.md", content: "# Global rules", exists: true },
    });
    expect(transport.agentTextFileGet).toHaveBeenCalledWith("AGENTS.md", "global");
  });

  test("writes APPEND_SYSTEM.md to its own file, never AGENTS.md", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("write_append_system_md", {
        content: "Be terse.",
      }),
    ).resolves.toEqual({ ok: true });
    expect(transport.agentTextFilePut).toHaveBeenCalledWith(
      "APPEND_SYSTEM.md",
      "Be terse.",
      "global",
    );
  });

  test("re-serializes JSON config for the editor", async () => {
    const transport = fakeTransport();
    transport.settingsGet.mockResolvedValueOnce({
      value: { providers: { x: 1 } },
      path: "/home/.pi/agent/models.json",
    });

    await expect(
      new LegacyConfigGateway({ transport }).call("read_models_config"),
    ).resolves.toEqual({
      ok: true,
      data: {
        path: "/home/.pi/agent/models.json",
        content: '{\n  "providers": {\n    "x": 1\n  }\n}',
        exists: true,
      },
    });
  });

  test("treats an absent file as an empty editor rather than a failure", async () => {
    for (const [operation, transport] of [
      ["read_append_system_md", fakeTransport()],
      ["read_models_config", fakeTransport()],
    ]) {
      const missing = new Error("Config file unavailable");
      missing.code = "config_not_found";
      if (operation === "read_append_system_md") missing.code = "config_not_found";
      if (transport.agentTextFileGet.mock)
        transport.agentTextFileGet.mockRejectedValueOnce(missing);
      if (transport.settingsGet.mock) transport.settingsGet.mockRejectedValueOnce(missing);

      await expect(new LegacyConfigGateway({ transport }).call(operation)).resolves.toEqual({
        ok: true,
        data: { path: "", content: "", exists: false },
      });
    }
  });

  test("maps host errors without throwing", async () => {
    const transport = fakeTransport();
    transport.agentTextFilePut.mockRejectedValueOnce(new Error("registry unavailable"));

    await expect(
      new LegacyConfigGateway({ transport }).call("write_agents_md", { content: "x" }),
    ).resolves.toEqual({ ok: false, error: "registry unavailable" });
  });

  test("returns a controlled timeout error", async () => {
    const transport = fakeTransport();
    transport.settingsGet.mockReturnValueOnce(new Promise(() => {}));

    await expect(
      new LegacyConfigGateway({ transport }).call("read_agent_config", {}, { timeoutMs: 1 }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  test("opens an external URL through the host control", async () => {
    const transport = fakeTransport();

    await expect(
      new LegacyConfigGateway({ transport }).call("open_external", {
        url: "https://example.test/device",
      }),
    ).resolves.toEqual({ ok: true });
    expect(transport.openExternal).toHaveBeenCalledWith("https://example.test/device");
  });
});

test("maps OAuth login capabilities through the host control", async () => {
  const transport = fakeTransport();
  transport.getOauthLoginCapabilities.mockResolvedValueOnce({
    providers: [{ providerId: "openai-codex", deviceCode: true, configured: false }],
  });

  await expect(
    new LegacyConfigGateway({ transport }).call("get_oauth_login_capabilities"),
  ).resolves.toEqual({
    ok: true,
    data: { providers: [{ providerId: "openai-codex", deviceCode: true, configured: false }] },
  });
});

test("maps OAuth capabilities failure to ok:false", async () => {
  const transport = fakeTransport();
  transport.getOauthLoginCapabilities.mockRejectedValueOnce(new Error("unavailable"));

  await expect(
    new LegacyConfigGateway({ transport }).call("get_oauth_login_capabilities"),
  ).resolves.toEqual({ ok: false, error: "unavailable" });
});

test("maps OAuth logout through the host control with the provider param", async () => {
  const transport = fakeTransport();

  await expect(
    new LegacyConfigGateway({ transport }).call("logout_oauth_login", { provider: "openai-codex" }),
  ).resolves.toEqual({ ok: true });
  expect(transport.logoutOauthLogin).toHaveBeenCalledWith({ provider: "openai-codex" });
});

test("reports every operation as unavailable when no transport is wired", async () => {
  const gateway = new LegacyConfigGateway();

  await expect(gateway.call("read_models_config")).resolves.toEqual({
    ok: false,
    error: expect.stringContaining("no native runtime implementation"),
  });
  await expect(gateway.call("read_agents_md")).resolves.toEqual({
    ok: false,
    error: expect.stringContaining("no native runtime implementation"),
  });
  await expect(gateway.call("open_external", { url: "https://example.test" })).resolves.toEqual({
    ok: false,
    error: expect.stringContaining("no native runtime implementation"),
  });
});

test("still throws on an unknown operation", async () => {
  await expect(
    new LegacyConfigGateway({ transport: fakeTransport() }).call("nope"),
  ).resolves.toEqual({ ok: false, error: "Unknown operation: nope" });
});
