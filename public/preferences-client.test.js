// ABOUTME: Verifies DB-backed preference client and render-cache reconciliation:
// ABOUTME: seed-once migration, DB-wins apply path, deterministic Remote failure,
// ABOUTME: and pass-through set/delete for user updates.

import { describe, expect, test, vi } from "vitest";
import {
  createPreferencesClient,
  PREFERENCE_KEYS,
  reconcileRenderPreferences,
  saveUserRenderPreference,
} from "./preferences-client.js";

function makeTransport({ native = true, available = true, fail = null } = {}) {
  const stored = new Map();
  return {
    state: stored,
    available,
    capabilities: { native },
    getPreference: vi.fn(async (key) => {
      if (fail) throw new Error(fail);
      return { value: stored.has(key) ? stored.get(key) : null };
    }),
    setPreference: vi.fn(async (key, value) => {
      if (fail) throw new Error(fail);
      stored.set(key, value);
      return {};
    }),
    deletePreference: vi.fn(async (key) => {
      if (fail) throw new Error(fail);
      stored.delete(key);
      return {};
    }),
    listPreferences: vi.fn(async () => ({ preferences: Object.fromEntries(stored) })),
  };
}

function makeEntries() {
  return [
    {
      key: PREFERENCE_KEYS.theme,
      readCache: vi.fn(() => "night"),
      apply: vi.fn(),
    },
    {
      key: PREFERENCE_KEYS.locale,
      readCache: vi.fn(() => "en"),
      apply: vi.fn(),
    },
  ];
}

describe("preferences availability", () => {
  test("non-native or disconnected transports are reported unavailable", async () => {
    expect(createPreferencesClient({ transport: makeTransport() }).available()).toBe(true);
    expect(
      createPreferencesClient({ transport: makeTransport({ native: false }) }).available(),
    ).toBe(false);
    expect(
      createPreferencesClient({ transport: makeTransport({ available: false }) }).available(),
    ).toBe(false);

    // Reconciliation surfaces unavailability deterministically.
    const outcome = await reconcileRenderPreferences({
      client: createPreferencesClient({ transport: makeTransport({ native: false }) }),
      entries: [],
    });
    expect(outcome).toEqual({ ok: false, reason: "preferences-unavailable-non-native" });
  });
});

describe("reconcile semantics", () => {
  test("empty DB seeds from the cookie without forcing a re-render", async () => {
    const transport = makeTransport();
    const entries = makeEntries();
    const outcome = await reconcileRenderPreferences({
      client: createPreferencesClient({ transport }),
      entries,
    });

    expect(outcome.ok).toBe(true);
    expect(transport.state.get(PREFERENCE_KEYS.theme)).toBe("night");
    expect(transport.state.get(PREFERENCE_KEYS.locale)).toBe("en");
    expect(entries.every((entry) => entry.apply.mock.calls.length === 0)).toBe(true);
  });

  test("DB value that differs from cache wins the render and rewrites cookie via apply", async () => {
    const transport = makeTransport();
    transport.state.set(PREFERENCE_KEYS.theme, "dawn");
    transport.state.set(PREFERENCE_KEYS.locale, "zh");
    const entries = makeEntries();
    const outcome = await reconcileRenderPreferences({
      client: createPreferencesClient({ transport }),
      entries,
    });

    expect(outcome.ok).toBe(true);
    expect(entries[0].apply).toHaveBeenCalledWith("dawn");
    expect(entries[1].apply).toHaveBeenCalledWith("zh");
  });

  test("matching values skip redundant applies", async () => {
    const transport = makeTransport();
    transport.state.set(PREFERENCE_KEYS.theme, "night");
    transport.state.set(PREFERENCE_KEYS.locale, "en");
    const entries = makeEntries();
    await reconcileRenderPreferences({ client: createPreferencesClient({ transport }), entries });
    // Both cache values match the DB exactly: no re-render, no extra writes.
    expect(entries[0].apply).not.toHaveBeenCalled();
    expect(entries[1].apply).not.toHaveBeenCalled();
    expect(transport.setPreference).not.toHaveBeenCalled();
  });

  test("control failures surface as ok:false without throwing into startup", async () => {
    const transport = makeTransport({ fail: "native desktop owner required" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await reconcileRenderPreferences({
      client: createPreferencesClient({ transport }),
      entries: makeEntries(),
    });
    errorSpy.mockRestore();
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("native desktop owner required");
  });
});

describe("client pass-through", () => {
  test("get/set/delete/list map straight onto broker controls", async () => {
    const transport = makeTransport();
    const client = createPreferencesClient({ transport });

    expect(await client.get(PREFERENCE_KEYS.theme)).toBeNull(); // absent → null
    await client.set(PREFERENCE_KEYS.theme, { mode: "dark" });
    expect(await client.get(PREFERENCE_KEYS.theme)).toEqual({ mode: "dark" });
    expect(await client.list("ui.")).toEqual({ "ui.theme": { mode: "dark" } });
    await client.remove(PREFERENCE_KEYS.theme);
    expect(await client.get(PREFERENCE_KEYS.theme)).toBeNull();
  });
});

describe("user-initiated persistence (SPEC §6.2 step 3)", () => {
  test("a user change is applied locally and mirrored into the DB truth", async () => {
    const transport = makeTransport();
    transport.state.set(PREFERENCE_KEYS.theme, "night");
    const client = createPreferencesClient({ transport });
    const apply = vi.fn();

    const outcome = await saveUserRenderPreference({
      client,
      key: PREFERENCE_KEYS.theme,
      value: "dawn",
      apply,
    });

    expect(outcome).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith("dawn");
    expect(transport.setPreference).toHaveBeenCalledWith(PREFERENCE_KEYS.theme, "dawn");
    expect(transport.state.get(PREFERENCE_KEYS.theme)).toBe("dawn");
  });

  test("a saved change survives a restart reconcile against a stale cookie", async () => {
    const transport = makeTransport();
    transport.state.set(PREFERENCE_KEYS.theme, "night");
    const client = createPreferencesClient({ transport });
    await saveUserRenderPreference({
      client,
      key: PREFERENCE_KEYS.theme,
      value: "dawn",
      apply: () => {},
    });

    // Restart: bootstrap paints the cookie first (here modeled stale), then
    // reconcile must side with the DB truth — the user's change — not revert.
    const restartApply = vi.fn();
    const outcome = await reconcileRenderPreferences({
      client,
      entries: [
        {
          key: PREFERENCE_KEYS.theme,
          readCache: () => "night",
          apply: restartApply,
        },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(restartApply).toHaveBeenCalledWith("dawn");
  });

  test("non-native surfaces apply locally and report unavailability deterministically", async () => {
    const transport = makeTransport({ native: false });
    const apply = vi.fn();

    const outcome = await saveUserRenderPreference({
      client: createPreferencesClient({ transport }),
      key: PREFERENCE_KEYS.theme,
      value: "dawn",
      apply,
    });

    expect(outcome).toEqual({ ok: false, reason: "preferences-unavailable-non-native" });
    expect(apply).toHaveBeenCalledWith("dawn");
    expect(transport.setPreference).not.toHaveBeenCalled();
  });

  test("broker write failures never break the render path", async () => {
    const transport = makeTransport({ fail: "broker unavailable" });
    const apply = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await saveUserRenderPreference({
      client: createPreferencesClient({ transport }),
      key: PREFERENCE_KEYS.theme,
      value: "dawn",
      apply,
    });
    errorSpy.mockRestore();

    expect(apply).toHaveBeenCalledWith("dawn");
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("broker unavailable");
  });
});
