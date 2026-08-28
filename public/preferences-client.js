// ABOUTME: DB-backed application preferences over Native-only broker controls;
// ABOUTME: cookies remain the synchronous render cache so first paint never flashes.

/**
 * Canonical preference keys (point-separated namespace per SPEC §6).
 * Values are arbitrary JSON stored in the MetadataStore preferences table.
 */
export const PREFERENCE_KEYS = Object.freeze({
  theme: "ui.theme",
  locale: "ui.locale",
});

/**
 * Thin promise wrapper around broker `preference.*` controls. Availability
 * mirrors the sidebar's registry gating: desktop-native clients only.
 */
export function createPreferencesClient({ transport }) {
  const available = () =>
    Boolean(
      transport?.available &&
        transport.capabilities?.native &&
        typeof transport.getPreference === "function" &&
        typeof transport.setPreference === "function",
    );

  return {
    available,
    async get(key) {
      const result = await transport.getPreference(key);
      const value = result?.value;
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await transport.setPreference(key, value);
    },
    async remove(key) {
      await transport.deletePreference(key);
    },
    async list(prefix = "") {
      const result = await transport.listPreferences(prefix);
      return result?.preferences ?? {};
    },
  };
}

/**
 * Persist a user-initiated render preference change (SPEC §6.2 step 3):
 * apply the value (render + cookie write-through) and mirror it into the DB
 * truth. The apply always runs first so browser/LAN surfaces without broker
 * preference controls keep the cookie-only behavior; a failed DB write is
 * surfaced as `{ ok:false }` rather than thrown into UI handlers.
 */
export async function saveUserRenderPreference({ client, key, value, apply }) {
  await apply(value);
  if (!client.available()) {
    return { ok: false, reason: "preferences-unavailable-non-native" };
  }
  try {
    await client.set(key, value);
    return { ok: true };
  } catch (error) {
    console.error("[prefs] persist failed:", error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

/**
 * Reconcile render-cache preferences (theme/locale) with the DB truth.
 *
 * Per-entry contract:
 * - `readCache()` returns the cookie-backed current value (or null).
 * - `apply(value)` renders the value AND persists it back to the cookie,
 *   keeping cookie == rendered state at all times.
 *
 * Semantics:
 * - DB empty + cache present → seed DB once (first-run migration).
 * - DB differs from cache → apply() wins the render and rewrites the cache.
 * - Any control failure surfaces deterministically as `{ ok:false }`; this
 *   helper never throws into unrelated startup flows.
 */
export async function reconcileRenderPreferences({ client, entries }) {
  if (!client.available()) {
    return { ok: false, reason: "preferences-unavailable-non-native" };
  }
  try {
    for (const entry of entries) {
      let stored = null;
      stored = await client.get(entry.key);
      const cached = entry.readCache();
      if (stored === null) {
        // First run: lift the existing cookie into the DB without forcing a
        // re-render of a value the user can already see.
        if (cached !== null && cached !== undefined) {
          await client.set(entry.key, cached);
        }
        continue;
      }
      if (cached !== stored) {
        entry.apply(stored);
      }
    }
    return { ok: true };
  } catch (error) {
    console.error("[prefs] reconcile failed:", error);
    return { ok: false, reason: String(error?.message || error) };
  }
}
