// ABOUTME: Appearance preferences for the dedicated Appearance settings page:
// ABOUTME: five-level font sizes (chat / preview / terminal) and the preview
// ABOUTME: theme mode. Cookie is the synchronous render cache; the DB mirror
// ABOUTME: goes through PREFERENCE_KEYS like ui.theme / ui.locale.

/**
 * Shared five-level font size scale. Per-surface px maps live in the
 * *_FONT_SIZE_PX tables; `normal` always equals the previously hardcoded
 * value for that surface.
 */
export const FONT_SIZE_LEVELS = ["small", "normal", "medium", "large", "xlarge"];
export const DEFAULT_FONT_SIZE_LEVEL = "normal";

export const CHAT_FONT_SIZE_PX = { small: 14, normal: 16, medium: 18, large: 20, xlarge: 22 };
export const PREVIEW_FONT_SIZE_PX = { small: 11, normal: 13, medium: 15, large: 17, xlarge: 19 };
export const TERMINAL_FONT_SIZE_PX = { small: 12, normal: 15, medium: 18, large: 22, xlarge: 26 };

/** Preview color scheme modes: follow the Picot theme, or force one. */
export const PREVIEW_THEME_MODES = ["system", "light", "dark"];
export const DEFAULT_PREVIEW_THEME_MODE = "system";

const APPEARANCE_COOKIE = "picot-appearance";
const APPEARANCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

export function normalizeFontLevel(value) {
  return FONT_SIZE_LEVELS.includes(value) ? value : DEFAULT_FONT_SIZE_LEVEL;
}

/**
 * Map a legacy pixel value onto the closest level of `pxMap`. Ties pick the
 * lower level; non-finite input falls back to the default level.
 */
export function nearestFontLevel(px, pxMap) {
  const value = Number(px);
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE_LEVEL;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of FONT_SIZE_LEVELS) {
    const distance = Math.abs(pxMap[level] - value);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** Unknown/stale preview theme values fall back to system. */
export function normalizePreviewThemeMode(value) {
  return PREVIEW_THEME_MODES.includes(value) ? value : DEFAULT_PREVIEW_THEME_MODE;
}

/**
 * Resolve the effective preview color scheme: "light"/"dark" force a side,
 * "system" follows the active Picot theme's dark flag.
 */
export function resolvePreviewTheme(mode, picotThemeIsDark) {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return picotThemeIsDark ? "dark" : "light";
}

function readAppearanceCookieRaw() {
  try {
    const prefix = `${APPEARANCE_COOKIE}=`;
    const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
    if (!entry) return null;
    return JSON.parse(decodeURIComponent(entry.slice(prefix.length)));
  } catch {
    return null;
  }
}

function writeAppearanceCookieRaw(value) {
  try {
    const serialized = encodeURIComponent(JSON.stringify(value));
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async; the synchronous render cache needs document.cookie (same as themes.js)
    document.cookie = `${APPEARANCE_COOKIE}=${serialized}; Max-Age=${APPEARANCE_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — sandboxed contexts fall back to defaults until a DB reconcile
  }
}

/** Normalized appearance values from the cookie cache; defaults when absent/corrupt. */
export function loadAppearanceCookie() {
  const raw = readAppearanceCookieRaw() || {};
  return {
    chatFontSize: normalizeFontLevel(raw.chatFontSize),
    previewFontSize: normalizeFontLevel(raw.previewFontSize),
    previewTheme: normalizePreviewThemeMode(raw.previewTheme),
    terminalFontSize: normalizeFontLevel(raw.terminalFontSize),
  };
}

/** Merge a patch into the cookie cache (values normalized before writing). */
export function saveAppearanceCookie(patch) {
  const merged = { ...loadAppearanceCookie(), ...(patch || {}) };
  writeAppearanceCookieRaw({
    chatFontSize: normalizeFontLevel(merged.chatFontSize),
    previewFontSize: normalizeFontLevel(merged.previewFontSize),
    previewTheme: normalizePreviewThemeMode(merged.previewTheme),
    terminalFontSize: normalizeFontLevel(merged.terminalFontSize),
  });
}

/**
 * Mirror the rendered appearance onto the document: font-size custom
 * properties, plus the preview theme attribute CSS scopes its light/dark
 * overrides against. In "system" mode the attribute is REMOVED so the panel
 * keeps the active Picot theme's own palette; only forced modes set it.
 */
export function applyAppearanceToDom({
  chatFontSize,
  previewFontSize,
  previewTheme,
  picotThemeIsDark,
}) {
  const root = document.documentElement;
  root.style.setProperty(
    "--chat-font-size",
    `${CHAT_FONT_SIZE_PX[normalizeFontLevel(chatFontSize)]}px`,
  );
  root.style.setProperty(
    "--preview-font-size",
    `${PREVIEW_FONT_SIZE_PX[normalizeFontLevel(previewFontSize)]}px`,
  );
  const mode = normalizePreviewThemeMode(previewTheme);
  if (mode === "system") {
    root.removeAttribute("data-preview-theme");
  } else {
    root.setAttribute("data-preview-theme", resolvePreviewTheme(mode, picotThemeIsDark));
  }
}

/**
 * One-time migration: lift the legacy terminal font size (px) out of the
 * per-origin localStorage payload onto the level scale, seed it for the
 * caller (which persists it into the cookie/DB dual-track), and drop the
 * key from localStorage. Returns the migrated level, or null when there is
 * nothing to migrate. Idempotent.
 */
export function migrateLegacyTerminalFontSize(storage) {
  const KEY = "picot.terminal.preferences";
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const { fontSize, ...rest } = parsed;
    const level = Number.isFinite(Number(fontSize))
      ? nearestFontLevel(fontSize, TERMINAL_FONT_SIZE_PX)
      : null;
    storage.setItem(KEY, JSON.stringify(rest));
    return level && level !== DEFAULT_FONT_SIZE_LEVEL ? level : null;
  } catch {
    return null;
  }
}
