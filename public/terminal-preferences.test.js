// ABOUTME: Tests for TerminalPreferences: only display-only keys persist, and
// ABOUTME: every process-sensitive key is rejected from the serialized payload.
import { expect, test } from "vitest";
import { TerminalPreferences } from "./terminal-preferences.js";

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
  expect(raw).toContain("fontSize");
  for (const forbidden of [
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
  prefs.save({ fontSize: 16, scrollbackLimit: 2000 });
  expect(prefs.load()).toEqual({ fontSize: 16, scrollbackLimit: 2000 });
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
  expect(prefs.load()).toEqual({ fontSize: 12 });
});
