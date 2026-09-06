// ABOUTME: Display-only terminal UI preferences (font size, scrollback). Host
// ABOUTME: state stays authoritative; no process-sensitive key is ever persisted.

import { DEFAULT_TERMINAL_FONT_SIZE } from "./terminal-font.js";

const ALLOWED_KEYS = new Set([
  "fontSize",
  "scrollbackLimit",
  "smoothScrollDuration",
  "webglRenderer",
  "themeMode",
]);

export const DEFAULT_FONT_SIZE = DEFAULT_TERMINAL_FONT_SIZE;
export const DEFAULT_SCROLLBACK_LIMIT = 1000;
export const DEFAULT_SMOOTH_SCROLL_DURATION = 0;

function clampNumber(value, fallback, min, max) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

export function normalizeFontSize(value) {
  return clampNumber(value, DEFAULT_FONT_SIZE, 10, 32);
}

export function normalizeScrollbackLimit(value) {
  return clampNumber(value, DEFAULT_SCROLLBACK_LIMIT, 100, 50000);
}

export function normalizeSmoothScrollDuration(value) {
  return clampNumber(value, DEFAULT_SMOOTH_SCROLL_DURATION, 0, 1000);
}

/** Terminal color scheme modes: follow the Picot theme, or force one. */
export const TERMINAL_THEME_MODES = ["system", "light", "dark"];
export const DEFAULT_TERMINAL_THEME_MODE = "dark";

/** Unknown/stale values fall back to the default (dark). */
export function normalizeThemeMode(value) {
  return TERMINAL_THEME_MODES.includes(value) ? value : DEFAULT_TERMINAL_THEME_MODE;
}

/**
 * WebGL renderer is opt-in per platform: default ON on macOS/Linux, OFF on
 * Windows until GPU driver coverage is validated. `userAgent` is injectable
 * for tests.
 */
export function defaultWebglRenderer(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
) {
  return !/Windows/i.test(userAgent);
}

/**
 * TerminalPreferences remembers display-only UI choices. It rejects and omits
 * any process-sensitive key (terminalId, owner, root, output, checkpoint,
 * title, capability, ...) so the serialized payload never leaks runtime state.
 */
export class TerminalPreferences {
  constructor(storage, key = "picot.terminal.preferences") {
    this.storage = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    this.key = key;
  }

  load() {
    if (!this.storage) return {};
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const clean = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (ALLOWED_KEYS.has(k)) clean[k] = v;
      }
      return clean;
    } catch {
      return {};
    }
  }

  save(prefs) {
    if (!this.storage) return;
    const clean = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      if (ALLOWED_KEYS.has(k)) clean[k] = v;
    }
    this.storage.setItem(this.key, JSON.stringify(clean));
  }
}
