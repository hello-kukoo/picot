// @vitest-environment node

// ABOUTME: Exercises the MCP settings bridge ops over pi-mcp-adapter's layered config files.
// ABOUTME: Uses isolated temp dirs so tests never touch a developer's real mcp.json layers.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  listMcpServers,
  saveMcpServer,
  stripJsonComments,
  toggleMcpServer,
} from "./mcp-settings";

let home: string;
let agentDir: string;
let projectDir: string;
let realHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  agentDir = join(home, "pi-agent");
  projectDir = join(home, "project");
  mkdirSync(join(home, ".config", "mcp"), { recursive: true });
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function writeJson(p: string, value: unknown) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function readJson(p: string) {
  return JSON.parse(readFileSync(p, "utf8"));
}

const sharedGlobal = (home: string) => join(home, ".config", "mcp", "mcp.json");
const agentsGlobal = (home: string) => join(home, ".agents", "mcp.json");
const piGlobal = (agentDir: string) => join(agentDir, "mcp.json");
const sharedProject = (projectDir: string) => join(projectDir, ".mcp.json");
const piProject = (projectDir: string) => join(projectDir, ".pi", "mcp.json");

describe("listMcpServers", () => {
  it("merges shared-global layers later-wins with per-entry sourceFile", () => {
    writeJson(sharedGlobal(home), {
      mcpServers: { grep: { url: "https://mcp.grep.app" }, first: { command: "a" } },
    });
    writeJson(agentsGlobal(home), { mcpServers: { grep: { url: "https://overridden.example" } } });
    writeJson(piGlobal(agentDir), { mcpServers: { context7: { command: "npx" } } });

    const result = listMcpServers(agentDir, projectDir);
    const grep = result.groups.sharedGlobal.find((e) => e.name === "grep");
    const first = result.groups.sharedGlobal.find((e) => e.name === "first");
    expect(grep?.entry).toEqual({ url: "https://overridden.example" });
    expect(grep?.sourceFile).toBe(agentsGlobal(home));
    expect(grep?.editable).toBe(false);
    expect(first?.sourceFile).toBe(sharedGlobal(home));
    expect(result.groups.piGlobal.find((e) => e.name === "context7")?.editable).toBe(true);
  });

  it("project group merges .mcp.json (read-only) under .pi/mcp.json (editable)", () => {
    writeJson(sharedProject(projectDir), {
      mcpServers: { repoTool: { command: "run repo-tool" } },
    });
    writeJson(piProject(projectDir), {
      mcpServers: { local: { command: "run local" }, repoTool: { command: "run local-override" } },
    });

    const result = listMcpServers(agentDir, projectDir);
    const repoTool = result.groups.project.find((e) => e.name === "repoTool");
    const local = result.groups.project.find((e) => e.name === "local");
    // Later layer wins and the winner's source decides editability.
    expect(repoTool?.entry).toEqual({ command: "run local-override" });
    expect(repoTool?.sourceFile).toBe(piProject(projectDir));
    expect(repoTool?.editable).toBe(true);
    // A name defined only in the shared project layer stays read-only.
    writeJson(piProject(projectDir), { mcpServers: {} });
    const reread = listMcpServers(agentDir, projectDir).groups.project.find(
      (e) => e.name === "repoTool",
    );
    expect(reread?.editable).toBe(false);
    expect(local).toBeDefined();
  });

  it("effectiveDisabled follows the full later-wins merge across all layers", () => {
    writeJson(sharedGlobal(home), { mcpServers: { grep: { url: "u", disabled: true } } });
    writeJson(piGlobal(agentDir), { mcpServers: { grep: { url: "u" } } }); // re-enabled higher up
    writeJson(piProject(projectDir), {
      mcpServers: { context7: { command: "npx", disabled: true } },
    });

    const result = listMcpServers(agentDir, projectDir);
    expect(result.groups.sharedGlobal.find((e) => e.name === "grep")?.effectiveDisabled).toBe(
      false,
    );
    expect(result.groups.piGlobal.find((e) => e.name === "grep")?.effectiveDisabled).toBe(false);
    expect(result.groups.project.find((e) => e.name === "context7")?.effectiveDisabled).toBe(true);
  });

  it("accepts JSONC files with comments and trailing commas", () => {
    writeFileSync(
      piGlobal(agentDir),
      `{
  // team defaults
  "mcpServers": {
    "grep": { "url": "https://mcp.grep.app", }, // trailing comma
  },
}`,
    );
    const result = listMcpServers(agentDir, projectDir);
    expect(result.groups.piGlobal.find((e) => e.name === "grep")?.entry.url).toBe(
      "https://mcp.grep.app",
    );
    expect(result.groupErrors.piGlobal).toBeUndefined();
  });

  it("reads the mcp-servers key variant and reports editable pi-global entries", () => {
    writeJson(piGlobal(agentDir), { "mcp-servers": { legacy: { command: "old-key" } } });
    const result = listMcpServers(agentDir, projectDir);
    const legacy = result.groups.piGlobal.find((e) => e.name === "legacy");
    expect(legacy?.entry).toEqual({ command: "old-key" });
    expect(legacy?.editable).toBe(true);
  });

  it("surfaces malformed layer errors per group without crashing", () => {
    writeFileSync(piGlobal(agentDir), "{ not json");
    const result = listMcpServers(agentDir, projectDir);
    expect(typeof result.groupErrors.piGlobal).toBe("string");
    expect(result.groupErrors.piGlobal?.length ?? 0).toBeGreaterThan(0);
    expect(result.groups.piGlobal).toEqual([]);
  });

  it("reports adapter not installed from settings.json packages", () => {
    writeJson(join(agentDir, "settings.json"), { packages: ["npm:pi-lens"] });
    expect(listMcpServers(agentDir, projectDir).installed).toBe(false);
  });
});

describe("stripJsonComments", () => {
  it("keeps // inside strings and strips real comments", () => {
    expect(stripJsonComments('{"a": "x // y", "b": 1 // real\n}')).toBe(
      '{"a": "x // y", "b": 1 \n}',
    );
    expect(stripJsonComments('{"a": 1 /* block */}')).toBe('{"a": 1 }');
  });
});

describe("saveMcpServer", () => {
  it("upserts, preserves document keys, and writes 2-space indent with newline", () => {
    writeJson(piGlobal(agentDir), {
      imports: ["codex"],
      mcpServers: { old: { command: "keep-me", customField: true } },
    });
    saveMcpServer(
      { scope: "piGlobal", name: "new-srv", entry: { command: "npx", args: ["-y", "x"] } },
      agentDir,
      "",
    );
    const raw = readFileSync(piGlobal(agentDir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "mcpServers"'); // 2-space indent
    const doc = JSON.parse(raw);
    expect(doc.imports).toEqual(["codex"]);
    expect(doc.mcpServers["new-srv"]).toEqual({ command: "npx", args: ["-y", "x"] });
  });

  it("preserves an array command round-trip", () => {
    writeJson(piGlobal(agentDir), {
      mcpServers: { cd: { command: ["npx", "-y", "chrome-devtools-mcp"], lifecycle: "lazy" } },
    });
    saveMcpServer(
      {
        scope: "piGlobal",
        name: "cd",
        entry: { command: ["npx", "-y", "chrome-devtools-mcp"], lifecycle: "lazy" },
      },
      agentDir,
      "",
    );
    expect(readJson(piGlobal(agentDir)).mcpServers.cd.command).toEqual([
      "npx",
      "-y",
      "chrome-devtools-mcp",
    ]);
  });

  it("writes back under the file's original mcp-servers key", () => {
    writeJson(piGlobal(agentDir), { "mcp-servers": { legacy: { command: "old" } } });
    saveMcpServer({ scope: "piGlobal", name: "extra", entry: { command: "new" } }, agentDir, "");
    const doc = readJson(piGlobal(agentDir));
    expect(doc["mcp-servers"].extra).toEqual({ command: "new" });
    expect(doc.mcpServers).toBeUndefined(); // no dual-key pollution
  });

  it("project scope writes only to .pi/mcp.json and rejects shared scope", () => {
    saveMcpServer(
      { scope: "project", name: "p", entry: { command: "run p" } },
      agentDir,
      projectDir,
    );
    expect(readJson(piProject(projectDir)).mcpServers.p).toEqual({ command: "run p" });
    expect(existsSync(sharedProject(projectDir))).toBe(false);
    expect(() =>
      saveMcpServer({ scope: "sharedGlobal", name: "x", entry: {} }, agentDir, ""),
    ).toThrow();
  });

  it("validates name and transport", () => {
    expect(() =>
      saveMcpServer({ scope: "piGlobal", name: "bad name", entry: { command: "x" } }, agentDir, ""),
    ).toThrow();
    expect(() =>
      saveMcpServer({ scope: "piGlobal", name: "ok", entry: { env: {} } }, agentDir, ""),
    ).toThrow();
  });

  it("rejects an invalid command type instead of silently keeping the old value", () => {
    writeJson(piGlobal(agentDir), { mcpServers: { a: { command: "keep" } } });
    expect(() =>
      saveMcpServer({ scope: "piGlobal", name: "a", entry: { command: 123 } }, agentDir, ""),
    ).toThrow(/command must be a string/);
    // Empty command on a command-only entry leaves no transport — the final
    // transport check rejects it (documented behavior, not silent).
    expect(() =>
      saveMcpServer({ scope: "piGlobal", name: "a", entry: { command: "" } }, agentDir, ""),
    ).toThrow(/needs a command/);
  });
});

describe("deleteMcpServer", () => {
  it("removes the entry and is idempotent", () => {
    writeJson(piGlobal(agentDir), { mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    deleteMcpServer({ scope: "piGlobal", name: "a" }, agentDir, "");
    deleteMcpServer({ scope: "piGlobal", name: "a" }, agentDir, "");
    expect(Object.keys(readJson(piGlobal(agentDir)).mcpServers)).toEqual(["b"]);
  });
});

describe("toggleMcpServer", () => {
  it("disable writes only the disabled flag into the pi-project layer", () => {
    writeJson(piGlobal(agentDir), { mcpServers: { grep: { url: "https://mcp.grep.app" } } });
    toggleMcpServer({ name: "grep", disable: true }, agentDir, projectDir);
    const doc = readJson(piProject(projectDir));
    expect(doc.mcpServers.grep).toEqual({ disabled: true });
    expect(readJson(piGlobal(agentDir)).mcpServers.grep.disabled).toBeUndefined();
  });

  it("enable removes the flag when lower layers are enabled (and deletes the empty entry)", () => {
    writeJson(piProject(projectDir), { mcpServers: { grep: { disabled: true } } });
    const result = toggleMcpServer({ name: "grep", disable: false }, agentDir, projectDir);
    expect(result.changed).toBe(true);
    expect(readJson(piProject(projectDir)).mcpServers).toEqual({});
  });

  it("enable with no project entry and no lower disable writes nothing", () => {
    writeJson(piGlobal(agentDir), { mcpServers: { grep: { url: "u" } } });
    toggleMcpServer({ name: "grep", disable: false }, agentDir, projectDir);
    expect(existsSync(piProject(projectDir))).toBe(false);
  });

  it("enable writes disabled:false when a lower layer itself is disabled", () => {
    writeJson(piGlobal(agentDir), { mcpServers: { grep: { url: "u", disabled: true } } });
    const result = toggleMcpServer({ name: "grep", disable: false }, agentDir, projectDir);
    expect(result.disabled).toBe(false);
    expect(readJson(piProject(projectDir)).mcpServers.grep).toEqual({ disabled: false });
  });

  it("enable consults the shared-project layer for the lower-disabled check (P1-2)", () => {
    writeJson(sharedProject(projectDir), {
      mcpServers: { repoTool: { command: "run", disabled: true } },
    });
    const result = toggleMcpServer({ name: "repoTool", disable: false }, agentDir, projectDir);
    expect(result.disabled).toBe(false);
    expect(readJson(piProject(projectDir)).mcpServers.repoTool).toEqual({ disabled: false });
  });

  it("no-op disable on an already-disabled project entry skips the write", () => {
    writeJson(piProject(projectDir), { mcpServers: { grep: { disabled: true } } });
    const before = readFileSync(piProject(projectDir), "utf8");
    const result = toggleMcpServer({ name: "grep", disable: true }, agentDir, projectDir);
    expect(result.changed).toBe(false);
    expect(readFileSync(piProject(projectDir), "utf8")).toBe(before);
  });
});
