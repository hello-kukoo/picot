// @vitest-environment node

// ABOUTME: Exercises the extension-settings bridge ops against temp HOME dirs.
// ABOUTME: The real ~/.config/rpiv-advisor/advisor.json is never touched.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advisorConfigGet, advisorConfigPath, advisorConfigSet } from "./extension-settings";

let home: string;
let realHome: string | undefined;
let realXdg: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ext-settings-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  realXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  if (realXdg !== undefined) process.env.XDG_CONFIG_HOME = realXdg;
  else delete process.env.XDG_CONFIG_HOME;
  rmSync(home, { recursive: true, force: true });
});

function writeAdvisorFile(content: string) {
  mkdirSync(dirname(advisorConfigPath()), { recursive: true });
  writeFileSync(advisorConfigPath(), content);
}

function makeRegistry(models) {
  return {
    getAll: () => models,
    getAvailable: async () => models.filter((m) => m.provider !== "locked"),
  };
}

const MODELS = [
  {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: {},
    thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", max: "max" },
  },
  {
    provider: "minimax-cn",
    id: "MiniMax-M3",
    name: "MiniMax M3",
    reasoning: {},
    // pi-ai semantics: absent mapping ≠ unsupported — explicit null excludes.
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
  },
  { provider: "plain", id: "no-reasoning", name: "Plain" },
  { provider: "locked", id: "no-creds", name: "Locked" },
];

describe("advisorConfigGet", () => {
  it("missing file → off state with the catalog from the live registry", async () => {
    const result = await advisorConfigGet(makeRegistry(MODELS));
    expect(result.modelKey).toBeUndefined();
    expect(result.effort).toBeUndefined();

    const claude = result.models.find((m) => m.key === "anthropic/claude-sonnet");
    expect(claude?.levels).toEqual(["minimal", "low", "medium", "high", "max"]);
    expect(claude?.available).toBe(true);
    // "off" and unsupported entries never appear: TUI buildEffortItems parity.
    const minimax = result.models.find((m) => m.key === "minimax-cn/MiniMax-M3");
    expect(minimax?.levels).toEqual(["low", "high"]);
    // A model without reasoning offers no effort levels.
    expect(result.models.find((m) => m.key === "plain/no-reasoning")?.levels).toEqual([]);
    // Unavailable models stay listed with available:false.
    expect(result.models.find((m) => m.key === "locked/no-creds")?.available).toBe(false);
    // Sorted by key.
    expect(result.models.map((m) => m.key)).toEqual([...result.models.map((m) => m.key)].sort());
  });

  it("reads modelKey/effort from the advisor's own config path", async () => {
    writeAdvisorFile(
      JSON.stringify({
        modelKey: "minimax-cn/MiniMax-M3",
        effort: "high",
        guidance: { promptSnippet: "be terse" },
        disabledForModels: ["plain/no-reasoning"],
      }),
    );
    const result = await advisorConfigGet(makeRegistry(MODELS));
    expect(result.modelKey).toBe("minimax-cn/MiniMax-M3");
    expect(result.effort).toBe("high");
  });

  it("malformed and non-object files degrade to off state", async () => {
    writeAdvisorFile("{ not json");
    expect(await advisorConfigGet(makeRegistry([]))).toMatchObject({
      modelKey: undefined,
      effort: undefined,
    });
    writeAdvisorFile('"a string"');
    const result = await advisorConfigGet(makeRegistry([]));
    expect(result.modelKey).toBeUndefined();
  });
});

describe("advisorConfigSet", () => {
  it("writes modelKey+effort atomically formatted, preserving unknown keys", () => {
    writeAdvisorFile(
      JSON.stringify({
        guidance: { promptSnippet: "keep" },
        disabledForModels: [{ model: "x", minEffort: "low" }],
        futureKey: true,
      }),
    );
    const result = advisorConfigSet({ modelKey: "anthropic/claude-sonnet", effort: "high" });
    expect(result.config.modelKey).toBe("anthropic/claude-sonnet");
    expect(result.config.effort).toBe("high");
    expect(result.config.guidance).toEqual({ promptSnippet: "keep" });
    expect(result.config.disabledForModels).toEqual([{ model: "x", minEffort: "low" }]);
    expect(result.config.futureKey).toBe(true);

    const raw = readFileSync(advisorConfigPath(), "utf8");
    expect(raw).toContain('  "modelKey"'); // 2-space indent, saveJsonConfig parity
    expect(raw.endsWith("\n")).toBe(true);
    expect((statSync(advisorConfigPath()).mode & 0o777).toString(8)).toBe("600");
  });

  it("null clears keys; absent params leave them unchanged", () => {
    advisorConfigSet({ modelKey: "a/b", effort: "low" });
    advisorConfigSet({ effort: null }); // only effort touched
    let doc = JSON.parse(readFileSync(advisorConfigPath(), "utf8"));
    expect(doc).toEqual({ modelKey: "a/b" });

    advisorConfigSet({ modelKey: null });
    doc = JSON.parse(readFileSync(advisorConfigPath(), "utf8"));
    expect(doc).toEqual({});
  });

  it("validates effort domain and modelKey type", () => {
    expect(() => advisorConfigSet({ effort: "off" })).toThrow(/effort/);
    expect(() => advisorConfigSet({ effort: "ultra" })).toThrow(/effort/);
    expect(() => advisorConfigSet({ modelKey: 42 })).toThrow(/modelKey/);
  });

  it("creates the config directory on first write", () => {
    const result = advisorConfigSet({ modelKey: "p/m", effort: "minimal" });
    expect(result.config).toEqual({ modelKey: "p/m", effort: "minimal" });
    expect(JSON.parse(readFileSync(advisorConfigPath(), "utf8"))).toEqual({
      modelKey: "p/m",
      effort: "minimal",
    });
  });
});

describe("XDG_CONFIG_HOME semantics (rpiv-config parity)", () => {
  const defaultPath = () => join(home, ".config", "rpiv-advisor", "advisor.json");

  it("absolute XDG dir: set writes there, get reads from there", async () => {
    const xdgDir = mkdtempSync(join(tmpdir(), "ext-settings-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdgDir;
      const xdgFile = join(xdgDir, "rpiv-advisor", "advisor.json");

      advisorConfigSet({ modelKey: "anthropic/claude-sonnet", effort: "high" });
      expect(existsSync(xdgFile)).toBe(true);
      expect(existsSync(defaultPath())).toBe(false);

      const result = await advisorConfigGet(makeRegistry([]));
      expect(result.modelKey).toBe("anthropic/claude-sonnet");
      expect(result.effort).toBe("high");
    } finally {
      rmSync(xdgDir, { recursive: true, force: true });
    }
  });

  it("no file at XDG but legacy file present: get reads legacy, set still writes XDG", async () => {
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    mkdirSync(dirname(defaultPath()), { recursive: true });
    writeFileSync(defaultPath(), JSON.stringify({ modelKey: "legacy/model", effort: "low" }));

    const result = await advisorConfigGet(makeRegistry([]));
    expect(result.modelKey).toBe("legacy/model");
    expect(result.effort).toBe("low");

    advisorConfigSet({ modelKey: "next/model" });
    expect(existsSync(join(home, "xdg", "rpiv-advisor", "advisor.json"))).toBe(true);
    expect(JSON.parse(readFileSync(defaultPath(), "utf8"))).toEqual({
      modelKey: "legacy/model",
      effort: "low",
    });
  });

  it("malformed XDG file does not silently fall back to a healthy legacy file", async () => {
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    const xdgFile = join(home, "xdg", "rpiv-advisor", "advisor.json");
    mkdirSync(dirname(xdgFile), { recursive: true });
    writeFileSync(xdgFile, "{ not json");
    mkdirSync(dirname(defaultPath()), { recursive: true });
    writeFileSync(defaultPath(), JSON.stringify({ modelKey: "legacy/model" }));

    const result = await advisorConfigGet(makeRegistry([]));
    expect(result.modelKey).toBeUndefined();
  });

  it("relative XDG value routes to the default ~/.config path", () => {
    process.env.XDG_CONFIG_HOME = "rel/xdg";
    advisorConfigSet({ modelKey: "p/m" });
    expect(advisorConfigPath()).toBe(defaultPath());
    expect(existsSync(defaultPath())).toBe(true);
  });

  it("~/xdg expands to the home-based absolute path", () => {
    process.env.XDG_CONFIG_HOME = "~/xdg";
    advisorConfigSet({ modelKey: "p/m" });
    const expanded = join(home, "xdg", "rpiv-advisor", "advisor.json");
    expect(advisorConfigPath()).toBe(expanded);
    expect(existsSync(expanded)).toBe(true);
    expect(existsSync(defaultPath())).toBe(false);
  });

  it("unset XDG keeps the default ~/.config behavior", () => {
    advisorConfigSet({ modelKey: "p/m" });
    expect(advisorConfigPath()).toBe(defaultPath());
    expect(existsSync(defaultPath())).toBe(true);
  });
});
