// ABOUTME: Display-only terminal UI preferences (font size, scrollback). Host
// ABOUTME: state stays authoritative; no process-sensitive key is ever persisted.

const ALLOWED_KEYS = new Set(["fontSize", "bellStyle", "scrollbackLimit", "smoothScroll"]);

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
