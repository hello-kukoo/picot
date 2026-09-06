// ABOUTME: Tests for TerminalPreferences: only display-only keys persist, and
// ABOUTME: every process-sensitive key is rejected from the serialized payload.
import { expect, test } from "vitest";
import {
  DEFAULT_SCROLLBACK_LIMIT,
  DEFAULT_SMOOTH_SCROLL_DURATION,
  DEFAULT_TERMINAL_THEME_MODE,
  defaultWebglRenderer,
  normalizeScrollbackLimit,
  normalizeSmoothScrollDuration,
  normalizeThemeMode,
  TerminalPreferences,
} from "./terminal-preferences.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

test("serialized payload has no runtime or secret fields", () => {
  const storage = memStorage();
  const prefs = new TerminalPreferences(storage);
  prefs.save({
    fontSize: 14,
    terminalId: "t1",
    owner: "owner-x",
    root: "/ws",
    cwd: "/ws",
    process: 1234,
    pid: 1234,
    port: 3001,
    output: "secret-output",
    checkpoint: "snap",
    title: "evil",
    capability: "secret-cap",
    generation: 1,
    profileId: "default",
  });
  const raw = storage.getItem("picot.terminal.preferences");
  expect(raw).not.toBeNull();
  for (const forbidden of [
    "fontSize",
    "terminalId",
    "owner",
    "root",
    "cwd",
    "process",
    "pid",
    "port",
    "output",
    "checkpoint",
    "title",
    "capability",
    "generation",
    "profileId",
  ]) {
    expect(raw).not.toContain(forbidden);
  }
});

test("load round-trips allowed preferences", () => {
  const storage = memStorage();
  const prefs = new TerminalPreferences(storage);
  prefs.save({
    scrollbackLimit: 2000,
    smoothScrollDuration: 120,
  });
  expect(prefs.load()).toEqual({
    scrollbackLimit: 2000,
    smoothScrollDuration: 120,
  });
  // Font size is no longer a terminal preference; it lives in the global
  // appearance store and must be rejected here.
  prefs.save({ scrollbackLimit: 3000, fontSize: 20 });
  expect(prefs.load()).toEqual({ scrollbackLimit: 3000 });
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

test("load tolerates corrupt storage", () => {
  const storage = memStorage();
  storage.setItem("picot.terminal.preferences", "{not json");
  const prefs = new TerminalPreferences(storage);
  expect(prefs.load()).toEqual({});
});

test("load drops unknown keys from an older payload", () => {
  const storage = memStorage();
  storage.setItem(
    "picot.terminal.preferences",
    JSON.stringify({ fontSize: 12, legacyColor: "#fff", terminalId: "leak" }),
  );
  const prefs = new TerminalPreferences(storage);
  // Font size migrated to the global appearance store; it is dropped here.
  expect(prefs.load()).toEqual({});
});

test("webglRenderer is an allowed display preference and round-trips", () => {
  const prefs = new TerminalPreferences(memStorage());
  prefs.save({ webglRenderer: false });
  expect(prefs.load()).toEqual({ webglRenderer: false });
  prefs.save({ webglRenderer: true });
  expect(prefs.load()).toEqual({ webglRenderer: true });
});

test("themeMode is an allowed display preference and round-trips", () => {
  const prefs = new TerminalPreferences(memStorage());
  prefs.save({ themeMode: "light" });
  expect(prefs.load()).toEqual({ themeMode: "light" });
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
