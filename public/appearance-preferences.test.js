// @vitest-environment jsdom
// ABOUTME: Covers appearance level normalizers, per-surface px maps, cookie
// ABOUTME: round-trip, legacy terminal font size migration, and DOM application.

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  applyAppearanceToDom,
  CHAT_FONT_SIZE_PX,
  DEFAULT_FONT_SIZE_LEVEL,
  DEFAULT_PREVIEW_THEME_MODE,
  DEFAULT_SCROLLBACK_LIMIT,
  DEFAULT_SMOOTH_SCROLL_DURATION,
  DEFAULT_TERMINAL_THEME_MODE,
  defaultWebglRenderer,
  FONT_SIZE_LEVELS,
  loadAppearanceCookie,
  migrateLegacyTerminalPreferences,
  nearestFontLevel,
  normalizeFontLevel,
  normalizePreviewThemeMode,
  normalizeScrollbackLimit,
  normalizeSmoothScrollDuration,
  normalizeThemeMode,
  PREVIEW_FONT_SIZE_PX,
  PREVIEW_THEME_MODES,
  resolvePreviewTheme,
  saveAppearanceCookie,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_THEME_MODES,
} from "./appearance-preferences.js";

const COOKIE_KEY = "picot-appearance";

function clearCookie() {
  document.cookie = `${COOKIE_KEY}=; Max-Age=0; Path=/`;
}

function memStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

beforeEach(clearCookie);
afterEach(() => {
  clearCookie();
  document.documentElement.removeAttribute("data-preview-theme");
  document.documentElement.style.removeProperty("--chat-font-size");
  document.documentElement.style.removeProperty("--preview-font-size");
});

test("level lists and defaults match the approved contract", () => {
  expect(FONT_SIZE_LEVELS).toEqual(["small", "normal", "medium", "large", "xlarge"]);
  expect(DEFAULT_FONT_SIZE_LEVEL).toBe("normal");
  expect(CHAT_FONT_SIZE_PX).toEqual({ small: 14, normal: 16, medium: 18, large: 20, xlarge: 22 });
  expect(PREVIEW_FONT_SIZE_PX).toEqual({
    small: 11,
    normal: 13,
    medium: 15,
    large: 17,
    xlarge: 19,
  });
  expect(TERMINAL_FONT_SIZE_PX).toEqual({
    small: 12,
    normal: 15,
    medium: 18,
    large: 22,
    xlarge: 26,
  });
  expect(DEFAULT_FONT_SIZE_LEVEL).toBe("normal");
  expect(DEFAULT_PREVIEW_THEME_MODE).toBe("system");
  expect(PREVIEW_THEME_MODES).toEqual(["system", "light", "dark"]);
  expect(DEFAULT_TERMINAL_THEME_MODE).toBe("dark");
  expect(TERMINAL_THEME_MODES).toEqual(["system", "light", "dark"]);
  expect(DEFAULT_SCROLLBACK_LIMIT).toBe(1000);
  expect(DEFAULT_SMOOTH_SCROLL_DURATION).toBe(0);
});

test("normalizeFontLevel falls back to normal on unknown values", () => {
  for (const level of FONT_SIZE_LEVELS) {
    expect(normalizeFontLevel(level)).toBe(level);
  }
  expect(normalizeFontLevel("huge")).toBe("normal");
  expect(normalizeFontLevel(undefined)).toBe("normal");
  expect(normalizeFontLevel("")).toBe("normal");
  expect(normalizeFontLevel(16)).toBe("normal");
});

test("nearestFontLevel maps legacy px values to the closest level", () => {
  // Exact hits on the terminal map (12/15/18/22/26).
  expect(nearestFontLevel(15, TERMINAL_FONT_SIZE_PX)).toBe("normal");
  expect(nearestFontLevel(26, TERMINAL_FONT_SIZE_PX)).toBe("xlarge");
  // Old range edges.
  expect(nearestFontLevel(10, TERMINAL_FONT_SIZE_PX)).toBe("small");
  expect(nearestFontLevel(32, TERMINAL_FONT_SIZE_PX)).toBe("xlarge");
  // Midpoint rounds to nearest (17 sits between 15 and 18 → medium).
  expect(nearestFontLevel(17, TERMINAL_FONT_SIZE_PX)).toBe("medium");
  // Ties pick the lower level (15 between 14 and 16 on the chat map).
  expect(nearestFontLevel(15, CHAT_FONT_SIZE_PX)).toBe("small");
  // Non-finite falls back to normal.
  expect(nearestFontLevel("bad", TERMINAL_FONT_SIZE_PX)).toBe("normal");
});

test("normalizePreviewThemeMode falls back to system", () => {
  for (const mode of PREVIEW_THEME_MODES) {
    expect(normalizePreviewThemeMode(mode)).toBe(mode);
  }
  expect(normalizePreviewThemeMode("sepia")).toBe("system");
  expect(normalizePreviewThemeMode(undefined)).toBe("system");
});

test("resolvePreviewTheme forces light/dark and follows the Picot theme on system", () => {
  expect(resolvePreviewTheme("light", true)).toBe("light");
  expect(resolvePreviewTheme("light", false)).toBe("light");
  expect(resolvePreviewTheme("dark", false)).toBe("dark");
  expect(resolvePreviewTheme("system", true)).toBe("dark");
  expect(resolvePreviewTheme("system", false)).toBe("light");
});

test("appearance cookie round-trips and normalizes partial writes", () => {
  saveAppearanceCookie({ chatFontSize: "large", terminalFontSize: "xlarge" });
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "large",
    previewFontSize: "normal",
    previewTheme: "system",
    terminalFontSize: "xlarge",
    terminalThemeMode: "dark",
    terminalScrollbackLimit: 1000,
    terminalSmoothScrollDuration: 0,
    terminalWebglRenderer: undefined,
  });

  saveAppearanceCookie({ previewFontSize: "small", previewTheme: "light" });
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "large",
    previewFontSize: "small",
    previewTheme: "light",
    terminalFontSize: "xlarge",
    terminalThemeMode: "dark",
    terminalScrollbackLimit: 1000,
    terminalSmoothScrollDuration: 0,
    terminalWebglRenderer: undefined,
  });
});

test("corrupt or stale cookie values fall back to defaults", () => {
  document.cookie = `${COOKIE_KEY}=not-json; Path=/`;
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "normal",
    previewFontSize: "normal",
    previewTheme: "system",
    terminalFontSize: "normal",
    terminalThemeMode: "dark",
    terminalScrollbackLimit: 1000,
    terminalSmoothScrollDuration: 0,
    terminalWebglRenderer: undefined,
  });

  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(
    JSON.stringify({ chatFontSize: "giant", previewTheme: "sepia" }),
  )}; Path=/`;
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "normal",
    previewFontSize: "normal",
    previewTheme: "system",
    terminalFontSize: "normal",
    terminalThemeMode: "dark",
    terminalScrollbackLimit: 1000,
    terminalSmoothScrollDuration: 0,
    terminalWebglRenderer: undefined,
  });
});

test("terminalWebglRenderer round-trips as a boolean and stays undefined when absent", () => {
  saveAppearanceCookie({ terminalWebglRenderer: false });
  expect(loadAppearanceCookie().terminalWebglRenderer).toBe(false);
  saveAppearanceCookie({ terminalWebglRenderer: true });
  expect(loadAppearanceCookie().terminalWebglRenderer).toBe(true);
  // A non-boolean must not poison the field: it defers to the platform default.
  saveAppearanceCookie({ terminalWebglRenderer: "yes" });
  expect(loadAppearanceCookie().terminalWebglRenderer).toBeUndefined();
});

test("migrateLegacyTerminalPreferences lifts every terminal field and clears storage", () => {
  const storage = memStorage({
    "picot.terminal.preferences": JSON.stringify({
      fontSize: 24,
      themeMode: "light",
      scrollbackLimit: 2000,
      smoothScrollDuration: 120,
      webglRenderer: false,
      junk: "dropped",
    }),
  });
  migrateLegacyTerminalPreferences(storage);
  // The whole per-origin payload is obsolete: the key must be gone.
  expect(storage.getItem("picot.terminal.preferences")).toBe(null);
  const cookie = loadAppearanceCookie();
  expect(cookie.terminalFontSize).toBe("large");
  expect(cookie.terminalThemeMode).toBe("light");
  expect(cookie.terminalScrollbackLimit).toBe(2000);
  expect(cookie.terminalSmoothScrollDuration).toBe(120);
  // jsdom's UA is non-Windows, so false is off-default and must be preserved.
  expect(cookie.terminalWebglRenderer).toBe(false);
  // Idempotent: second run is a no-op.
  migrateLegacyTerminalPreferences(storage);
  expect(loadAppearanceCookie()).toEqual(cookie);
});

test("migration skips default-valued legacy fields, invalid webgl, and corrupt JSON", () => {
  const storage = memStorage({
    "picot.terminal.preferences": JSON.stringify({
      fontSize: 15,
      themeMode: "dark",
      scrollbackLimit: 1000,
      smoothScrollDuration: 0,
      webglRenderer: "yes",
    }),
  });
  const before = loadAppearanceCookie();
  migrateLegacyTerminalPreferences(storage);
  expect(storage.getItem("picot.terminal.preferences")).toBe(null);
  expect(loadAppearanceCookie()).toEqual(before);

  const broken = memStorage({ "picot.terminal.preferences": "{broken" });
  migrateLegacyTerminalPreferences(broken);
  expect(broken.getItem("picot.terminal.preferences")).toBe(null);
  expect(migrateLegacyTerminalPreferences(memStorage())).toBeUndefined();
  expect(migrateLegacyTerminalPreferences(null)).toBeUndefined();
});

test("normalizeThemeMode accepts the three modes and defaults to dark", () => {
  expect(normalizeThemeMode("system")).toBe("system");
  expect(normalizeThemeMode("light")).toBe("light");
  expect(normalizeThemeMode("dark")).toBe("dark");
  expect(normalizeThemeMode("sepia")).toBe("dark");
  expect(normalizeThemeMode(undefined)).toBe("dark");
  expect(normalizeThemeMode(null)).toBe("dark");
  expect(DEFAULT_TERMINAL_THEME_MODE).toBe("dark");
});

test("normalizes terminal display preferences to safe ranges", () => {
  expect(normalizeScrollbackLimit(50)).toBe(100);
  expect(normalizeScrollbackLimit(60000)).toBe(50000);
  expect(normalizeScrollbackLimit(undefined)).toBe(DEFAULT_SCROLLBACK_LIMIT);
  expect(normalizeSmoothScrollDuration(-1)).toBe(0);
  expect(normalizeSmoothScrollDuration(2500)).toBe(1000);
  expect(normalizeSmoothScrollDuration(undefined)).toBe(DEFAULT_SMOOTH_SCROLL_DURATION);
  expect(normalizeSmoothScrollDuration("")).toBe(DEFAULT_SMOOTH_SCROLL_DURATION);
});

test("defaultWebglRenderer is ON except on Windows", () => {
  expect(
    defaultWebglRenderer(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    ),
  ).toBe(false);
  expect(
    defaultWebglRenderer(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    ),
  ).toBe(true);
  expect(
    defaultWebglRenderer(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
    ),
  ).toBe(true);
  expect(defaultWebglRenderer("")).toBe(true);
  expect(defaultWebglRenderer(undefined)).toBe(true);
});

test("applyAppearanceToDom sets font variables and the resolved preview theme", () => {
  applyAppearanceToDom({
    chatFontSize: "large",
    previewFontSize: "small",
    previewTheme: "dark",
    picotThemeIsDark: false,
  });
  expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("20px");
  expect(document.documentElement.style.getPropertyValue("--preview-font-size")).toBe("11px");
  expect(document.documentElement.getAttribute("data-preview-theme")).toBe("dark");

  // System mode removes the attribute so the panel keeps the active Picot
  // theme's own palette instead of the canonical forced-mode one.
  applyAppearanceToDom({
    chatFontSize: "large",
    previewFontSize: "small",
    previewTheme: "system",
    picotThemeIsDark: true,
  });
  expect(document.documentElement.getAttribute("data-preview-theme")).toBe(null);
});
