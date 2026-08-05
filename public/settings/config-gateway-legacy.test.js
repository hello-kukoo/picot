// ABOUTME: Verifies legacy transport requests and ConfigGateway response mapping.
// ABOUTME: Covers HTTP/RPC errors and timeout handling independently of the UI.

import { afterEach, describe, expect, test, vi } from "vitest";
import { LegacyConfigGateway } from "./config-gateway-legacy.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LegacyConfigGateway", () => {
  test("maps RPC model catalog responses to the ConfigGateway shape", async () => {
    const fetchMock = vi.fn(async (_url, options) => {
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({ type: "list_model_catalog" });
      return new Response(
        JSON.stringify({ success: true, data: { providers: [{ provider: "anthropic" }] } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new LegacyConfigGateway().call("list_model_catalog")).resolves.toEqual({
      ok: true,
      data: { providers: [{ provider: "anthropic" }] },
    });
  });

  test("writes models config through the legacy endpoint", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("/api/models-config");
      expect(options.method).toBe("PUT");
      expect(JSON.parse(options.body)).toEqual({ content: '{"providers":{}}' });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new LegacyConfigGateway().call("write_models_config", { content: '{"providers":{}}' }),
    ).resolves.toEqual({ ok: true });
  });

  test("maps legacy errors without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ success: false, error: "registry unavailable" })),
      ),
    );

    await expect(new LegacyConfigGateway().call("list_model_catalog")).resolves.toEqual({
      ok: false,
      error: "registry unavailable",
    });
  });

  test("returns a controlled timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    await expect(
      new LegacyConfigGateway().call("list_model_catalog", {}, { timeoutMs: 1 }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });
});
