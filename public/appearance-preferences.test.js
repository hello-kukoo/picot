// @vitest-environment jsdom
// ABOUTME: Covers appearance level normalizers, per-surface px maps, cookie
// ABOUTME: round-trip, legacy terminal font size migration, and DOM application.

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  applyAppearanceToDom,
  CHAT_FONT_SIZE_PX,
  DEFAULT_FONT_SIZE_LEVEL,
  DEFAULT_PREVIEW_THEME_MODE,
  FONT_SIZE_LEVELS,
  loadAppearanceCookie,
  migrateLegacyTerminalFontSize,
  nearestFontLevel,
  normalizeFontLevel,
  normalizePreviewThemeMode,
  PREVIEW_FONT_SIZE_PX,
  PREVIEW_THEME_MODES,
  resolvePreviewTheme,
  saveAppearanceCookie,
  TERMINAL_FONT_SIZE_PX,
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
  });

  saveAppearanceCookie({ previewFontSize: "small", previewTheme: "light" });
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "large",
    previewFontSize: "small",
    previewTheme: "light",
    terminalFontSize: "xlarge",
  });
});

test("corrupt or stale cookie values fall back to defaults", () => {
  document.cookie = `${COOKIE_KEY}=not-json; Path=/`;
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "normal",
    previewFontSize: "normal",
    previewTheme: "system",
    terminalFontSize: "normal",
  });

  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(
    JSON.stringify({ chatFontSize: "giant", previewTheme: "sepia" }),
  )}; Path=/`;
  expect(loadAppearanceCookie()).toEqual({
    chatFontSize: "normal",
    previewFontSize: "normal",
    previewTheme: "system",
    terminalFontSize: "normal",
  });
});

test("migrateLegacyTerminalFontSize converts px, drops the key, and is idempotent", () => {
  const storage = memStorage({
    "picot.terminal.preferences": JSON.stringify({ fontSize: 24, scrollbackLimit: 2000 }),
  });
  expect(migrateLegacyTerminalFontSize(storage)).toBe("large");
  expect(JSON.parse(storage.getItem("picot.terminal.preferences"))).toEqual({
    scrollbackLimit: 2000,
  });
  // Second run: key is gone, nothing to migrate.
  expect(migrateLegacyTerminalFontSize(storage)).toBe(null);

  expect(
    migrateLegacyTerminalFontSize(memStorage({ "picot.terminal.preferences": "{broken" })),
  ).toBe(null);
  expect(migrateLegacyTerminalFontSize(memStorage())).toBe(null);
  // Non-finite px values do not migrate and are still dropped.
  const junk = memStorage({
    "picot.terminal.preferences": JSON.stringify({ fontSize: "bad" }),
  });
  expect(migrateLegacyTerminalFontSize(junk)).toBe(null);
  expect(JSON.parse(junk.getItem("picot.terminal.preferences"))).toEqual({});
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
