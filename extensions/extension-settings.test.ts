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
import {
  advisorConfigGet,
  advisorConfigPath,
  advisorConfigSet,
  planModeConfigGet,
  planModeConfigSet,
  safetyGuardConfigGet,
  safetyGuardConfigSet,
  webAccessConfigGet,
  webAccessConfigSet,
} from "./extension-settings";

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

// ─── Shared hermetic env for the package-op suites ──────────────────────────
// PI_CODING_AGENT_DIR and PI_SAFETY_GUARD_CONFIG_FILE redirect these ops away
// from the temp HOME, and a dev machine may well have either set.
let realAgentDir: string | undefined;
let realGuardFile: string | undefined;

function isolatePackageEnv() {
  beforeEach(() => {
    realAgentDir = process.env.PI_CODING_AGENT_DIR;
    realGuardFile = process.env.PI_SAFETY_GUARD_CONFIG_FILE;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  });
  afterEach(() => {
    if (realAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = realAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;
    if (realGuardFile !== undefined) process.env.PI_SAFETY_GUARD_CONFIG_FILE = realGuardFile;
    else delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  });
}

function writeFileAt(filePath: string, content: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function readJsonAt(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("planModeConfig ops", () => {
  isolatePackageEnv();
  const planFile = () => join(home, ".pi", "agent", "pi-plan-mode.json");

  it("missing file reads as the empty document plus the live catalog", async () => {
    const result = await planModeConfigGet(makeRegistry(MODELS));
    expect(result.settings).toEqual({});
    expect(result.invalid).toBeUndefined();
    expect(result.models.map((m) => m.key)).toEqual([
      "anthropic/claude-sonnet",
      "locked/no-creds",
      "minimax-cn/MiniMax-M3",
      "plain/no-reasoning",
    ]);
  });

  it("an unreadable file is reported, not silently read as empty", async () => {
    writeFileAt(planFile(), "{not json");
    const result = await planModeConfigGet(makeRegistry(MODELS));
    expect(result.settings).toBeNull();
    expect(result.invalid?.reason).toBeTruthy();
  });

  it("refuses to write onto an unreadable file", () => {
    writeFileAt(planFile(), "{not json");
    expect(() => planModeConfigSet({ key: "thinkingLevel", value: "high" })).toThrow(
      /invalid file/,
    );
    expect(readFileSync(planFile(), "utf8")).toBe("{not json");
  });

  it("patch semantics: enum rejects, null clears, unknown keys reject", () => {
    expect(() => planModeConfigSet({ key: "thinkingLevel", value: "ultra" })).toThrow(
      /thinkingLevel must be one of/,
    );
    expect(() =>
      planModeConfigSet({ key: "implementationPlanRetention", value: "forever" }),
    ).toThrow(/implementationPlanRetention must be one of/);
    planModeConfigSet({ key: "thinkingLevel", value: "high" });
    expect(readJsonAt(planFile())).toEqual({ thinkingLevel: "high" });
    planModeConfigSet({ key: "thinkingLevel", value: null });
    expect(readJsonAt(planFile())).toEqual({});
    expect(() => planModeConfigSet({ key: "nope", value: 1 })).toThrow(
      /unknown plan-mode config key/,
    );
    expect(() => planModeConfigSet({ key: "defaultPlanTools", value: [1] })).toThrow(
      /array of strings/,
    );
  });

  it("entries apply every patch to one document in one write", () => {
    const result = planModeConfigSet({
      entries: [
        { key: "thinkingLevel", value: "max" },
        { key: "defaultPlanTools", value: ["read", "grep"] },
      ],
    });
    expect(result.config).toEqual({
      thinkingLevel: "max",
      defaultPlanTools: ["read", "grep"],
    });
    expect(readJsonAt(planFile())).toEqual(result.config);
  });

  it("a failing entry batch leaves the file untouched", () => {
    expect(() =>
      planModeConfigSet({
        entries: [
          { key: "thinkingLevel", value: "max" },
          { key: "nope", value: true },
        ],
      }),
    ).toThrow(/unknown plan-mode config key/);
    expect(existsSync(planFile())).toBe(false);
  });

  it("rejects a malformed entries payload", () => {
    expect(() => planModeConfigSet({ entries: [] })).toThrow(/non-empty array/);
    expect(() => planModeConfigSet({ entries: [{ value: "x" }] })).toThrow(/needs a key/);
  });
});

describe("safetyGuardConfig ops", () => {
  isolatePackageEnv();
  const guardFile = () => join(home, ".pi", "agent", "safety-guard.json");

  it("missing file reads as empty with no invalid reason", () => {
    const data = safetyGuardConfigGet();
    expect(data.config).toEqual({});
    expect(data.invalid).toBeUndefined();
  });

  it("reports an unreadable file and refuses to overwrite it", () => {
    writeFileAt(guardFile(), "[1,2");
    const data = safetyGuardConfigGet();
    expect(data.config).toBeNull();
    expect(data.invalid?.reason).toBeTruthy();
    expect(() => safetyGuardConfigSet({ key: "enabled", value: false })).toThrow(/invalid file/);
    expect(readFileSync(guardFile(), "utf8")).toBe("[1,2");
  });

  it("validates categories, steppers and auto-review fields", () => {
    expect(() => safetyGuardConfigSet({ key: "categories.nope", value: true })).toThrow(
      /unknown category/,
    );
    expect(() => safetyGuardConfigSet({ key: "categories.secrets", value: "yes" })).toThrow(
      /must be a boolean/,
    );
    expect(() => safetyGuardConfigSet({ key: "contextLines.before", value: 21 })).toThrow(/0–20/);
    expect(() => safetyGuardConfigSet({ key: "autoReview.model.provider", value: 7 })).toThrow(
      /must be a string/,
    );
    expect(() => safetyGuardConfigSet({ key: "nope", value: true })).toThrow(
      /unknown safety-guard config key/,
    );
  });

  it("writes the paired auto-review model in a single document", () => {
    const result = safetyGuardConfigSet({
      entries: [
        { key: "autoReview.model.provider", value: "anthropic" },
        { key: "autoReview.model.modelId", value: "claude-sonnet" },
      ],
    });
    expect(result.config).toEqual({
      autoReview: { model: { provider: "anthropic", modelId: "claude-sonnet" } },
    });
    expect(readJsonAt(guardFile())).toEqual(result.config);
  });

  it("refuses writes when the config is relocated by env", () => {
    const relocated = join(home, "elsewhere.json");
    process.env.PI_SAFETY_GUARD_CONFIG_FILE = relocated;
    const data = safetyGuardConfigGet();
    expect(data.relocatedByEnv).toBe(true);
    expect(data.configPath).toBe(relocated);
    expect(() => safetyGuardConfigSet({ key: "enabled", value: true })).toThrow(/relocated/);
    expect(existsSync(guardFile())).toBe(false);
  });
});

describe("webAccessConfig ops", () => {
  isolatePackageEnv();
  const agentFile = () => join(home, ".pi", "agent", "web-search.json");
  const legacyFile = () => join(home, ".pi", "web-search.json");
  const xdgFile = (xdgHome: string) => join(xdgHome, "pi", "web-search.json");

  function withTempXdg(run: (xdgHome: string) => void) {
    const xdgHome = mkdtempSync(join(tmpdir(), "webaccess-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdgHome;
      run(xdgHome);
    } finally {
      rmSync(xdgHome, { recursive: true, force: true });
      delete process.env.XDG_CONFIG_HOME;
    }
  }

  function withEnv(names: string[], run: () => void) {
    const real = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      run();
    } finally {
      for (const [name, value] of real) {
        if (value !== undefined) process.env[name] = value;
      }
    }
  }

  it("masks secrets and reads the package's flat key names", () => {
    writeFileAt(
      agentFile(),
      JSON.stringify({
        openaiApiKey: "sk-abcdefgh",
        crawl4aiApiToken: "c4-token-1234",
        brightdataApiKey: "bd-key-9999",
        searxngBaseUrl: "https://search.example.com",
        brightdataSerpZone: "pi_serp",
      }),
    );
    const data = webAccessConfigGet();
    expect(data.fields.openaiApiKey).toEqual({ configured: true, preview: "efgh" });
    expect(data.fields.crawl4aiApiToken).toEqual({ configured: true, preview: "1234" });
    expect(data.fields.brightdataApiKey).toEqual({ configured: true, preview: "9999" });
    expect(data.fields["crawl4ai.token"]).toBeUndefined();
    expect(data.fields["brightdata.key"]).toBeUndefined();
    expect(data.nonSecrets.searxngBaseUrl).toBe("https://search.example.com");
    expect(data.nonSecrets.brightdataSerpZone).toBe("pi_serp");
    expect(JSON.stringify(data)).not.toContain("sk-abcdefgh");
  });

  it("badges env keys by the package's own variable names", () => {
    withEnv(["OPENAI_API_KEY", "SERPAPI_KEY", "SEARCH1API_KEY"], () => {
      writeFileAt(agentFile(), "{}");
      process.env.SERPAPI_KEY = "serp";
      process.env.SEARCH1API_KEY = "s1";
      const data = webAccessConfigGet();
      expect(data.envKeyed).toContain("serpapiApiKey");
      expect(data.envKeyed).toContain("search1apiApiKey");
      expect(data.envKeyed).not.toContain("openaiApiKey");
    });
  });

  it("writes the XDG target when XDG is set and no config exists", () => {
    withTempXdg((xdgHome) => {
      webAccessConfigSet({ key: "openaiApiKey", value: "sk-x" });
      expect(readJsonAt(xdgFile(xdgHome))).toEqual({ openaiApiKey: "sk-x" });
      expect(existsSync(agentFile())).toBe(false);
    });
  });

  it("keeps writing the legacy ~/.pi file the runtime still reads", () => {
    writeFileAt(legacyFile(), JSON.stringify({ braveApiKey: "BSA-legacy" }));
    expect(webAccessConfigGet().fields.braveApiKey.configured).toBe(true);
    webAccessConfigSet({ key: "exaApiKey", value: "exa-new" });
    expect(readJsonAt(legacyFile())).toEqual({ braveApiKey: "BSA-legacy", exaApiKey: "exa-new" });
    expect(existsSync(agentFile())).toBe(false);
  });

  it("prefers the legacy file over a fresh XDG path", () => {
    withTempXdg((xdgHome) => {
      writeFileAt(legacyFile(), JSON.stringify({ braveApiKey: "BSA-legacy" }));
      expect(webAccessConfigGet().fields.braveApiKey.configured).toBe(true);
      webAccessConfigSet({ key: "exaApiKey", value: "exa-new" });
      expect(existsSync(xdgFile(xdgHome))).toBe(false);
      expect(readJsonAt(legacyFile())).toEqual({ braveApiKey: "BSA-legacy", exaApiKey: "exa-new" });
    });
  });

  it("prefers the agent file over the legacy file when XDG is unset", () => {
    writeFileAt(legacyFile(), JSON.stringify({ braveApiKey: "BSA-legacy" }));
    writeFileAt(agentFile(), JSON.stringify({ exaApiKey: "exa-agent" }));
    expect(webAccessConfigGet().fields.exaApiKey.configured).toBe(true);
    expect(webAccessConfigGet().fields.braveApiKey.configured).toBe(false);
  });

  it("lets an explicit PI_CODING_AGENT_DIR win over every tier", () => {
    const explicit = mkdtempSync(join(tmpdir(), "webaccess-agent-"));
    try {
      process.env.PI_CODING_AGENT_DIR = explicit;
      withTempXdg((xdgHome) => {
        writeFileAt(legacyFile(), JSON.stringify({ braveApiKey: "BSA-legacy" }));
        writeFileAt(xdgFile(xdgHome), JSON.stringify({ exaApiKey: "exa-xdg" }));
        webAccessConfigSet({ key: "openaiApiKey", value: "sk-explicit" });
        expect(readJsonAt(join(explicit, "web-search.json"))).toEqual({
          openaiApiKey: "sk-explicit",
        });
        expect(existsSync(agentFile())).toBe(false);
      });
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it("rejects unknown keys and wrong types, and writes flat names", () => {
    expect(() => webAccessConfigSet({ key: "crawl4ai.token", value: "x" })).toThrow(
      /unknown web-access config key/,
    );
    expect(() => webAccessConfigSet({ key: "image.enabled", value: "yes" })).toThrow(/boolean/);
    expect(() => webAccessConfigSet({ key: "openaiApiKey", value: 7 })).toThrow(/string or null/);
    webAccessConfigSet({ key: "crawl4aiApiToken", value: "c4" });
    expect(readJsonAt(agentFile())).toEqual({ crawl4aiApiToken: "c4" });
  });

  it("lands a paired answer model in one write", () => {
    const result = webAccessConfigSet({
      entries: [
        { key: "fetch.answerProvider", value: "openai" },
        { key: "fetch.answerModel", value: "gpt-x" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(readJsonAt(agentFile())).toEqual({
      fetch: { answerProvider: "openai", answerModel: "gpt-x" },
    });
  });

  it("writes credential files 0600", () => {
    webAccessConfigSet({ key: "openaiApiKey", value: "sk-secret" });
    expect(statSync(agentFile()).mode & 0o777).toBe(0o600);
  });

  it("reports an invalid file instead of reading it as empty", () => {
    writeFileAt(agentFile(), "{not json");
    const data = webAccessConfigGet();
    expect(data.invalid?.reason).toBeTruthy();
    expect(data.fields).toEqual({});
    expect(() => webAccessConfigSet({ key: "openaiApiKey", value: "sk-x" })).toThrow(
      /invalid file/,
    );
    expect(readFileSync(agentFile(), "utf8")).toBe("{not json");
  });
});
