import { afterEach, describe, expect, test, vi } from "vitest";
import {
  installHostOriginFetch,
  NATIVE_CAPABILITY_GLOBAL,
  NATIVE_CAPABILITY_HEADER,
} from "./host-origin.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__PICOT_HOST_FETCH_INSTALLED__;
  delete globalThis[NATIVE_CAPABILITY_GLOBAL];
});

describe("host-origin fetch", () => {
  test("adds capability header to same-origin host API requests", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    const env = {
      location: {
        pathname: "/workspaces/w-1/sessions/s-1",
        origin: "http://127.0.0.1:44000",
        href: "http://127.0.0.1:44000/workspaces/w-1/sessions/s-1",
      },
      fetch: fetchMock,
      [NATIVE_CAPABILITY_GLOBAL]: "cap-secret",
    };
    installHostOriginFetch(env);

    await env.fetch("/api/files", { headers: { Accept: "application/json" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files",
      expect.objectContaining({
        headers: expect.objectContaining({
          get: expect.any(Function),
        }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].headers.get(NATIVE_CAPABILITY_HEADER)).toBe("cap-secret");
    expect(env[NATIVE_CAPABILITY_GLOBAL]).toBeUndefined();
  });

  test("does not add capability to Pi-origin or remote requests", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    const env = {
      location: {
        pathname: "/",
        origin: "http://127.0.0.1:44000",
        href: "http://127.0.0.1:44000/",
      },
      fetch: fetchMock,
      [NATIVE_CAPABILITY_GLOBAL]: "cap-secret",
    };
    installHostOriginFetch(env);

    await env.fetch("/api/files");
    await env.fetch("http://remote.example/api/files");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/files", {});
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://remote.example/api/files", {});
  });
});
