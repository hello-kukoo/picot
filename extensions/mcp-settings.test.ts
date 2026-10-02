// @vitest-environment node

// ABOUTME: Exercises the MCP settings ops over Pi 0.99+ native config files (user + project mcp.json).
// ABOUTME: Also covers the one-shot migration from orphaned pi-mcp-adapter / shared config layers.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  listMcpServers,
  migrateAdapterConfig,
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

const userFile = (agentDir: string) => join(agentDir, "mcp.json");
const projectFile = (projectDir: string) => join(projectDir, ".pi", "mcp.json");
const adapterGlobal = (agentDir: string) => join(agentDir, "mcp-adapter.json");
const adapterProject = (projectDir: string) => join(projectDir, ".pi", "mcp-adapter.json");
const sharedGlobal = (home: string) => join(home, ".config", "mcp", "mcp.json");
const agentsGlobal = (home: string) => join(home, ".agents", "mcp.json");
const sharedProject = (projectDir: string) => join(projectDir, ".mcp.json");

describe("listMcpServers (native two-file model)", () => {
  it("returns user and project groups with enabled state and sourceFile", () => {
    writeJson(userFile(agentDir), {
      mcpServers: {
        context7: { command: "npx" },
        paused: { command: "npx", enabled: false },
      },
    });
    writeJson(projectFile(projectDir), { mcpServers: { repoTool: { url: "https://t.example" } } });

    const result = listMcpServers(agentDir, projectDir);
    expect(result.groups.piGlobal.map((e) => e.name).sort()).toEqual(["context7", "paused"]);
    expect(result.groups.project.map((e) => e.name)).toEqual(["repoTool"]);
    const paused = result.groups.piGlobal.find((e) => e.name === "paused");
    expect(paused?.enabled).toBe(false);
    expect(paused?.sourceFile).toBe(userFile(agentDir));
    expect(paused?.editable).toBe(true);
    expect(result.groups.piGlobal.find((e) => e.name === "context7")?.enabled).toBe(true);
  });

  it("reads comments and the mcp-servers key spelling from legacy sources", () => {
    writeJson(adapterGlobal(agentDir), { "mcp-servers": { zread: { url: "https://z.example" } } });
    const result = listMcpServers(agentDir, projectDir);
    const target = result.migrations.find((m) => m.id === "adapterGlobal");
    expect(target?.missing).toEqual(["zread"]);
  });

  it("offers the orphaned adapter global config for migration, minus existing names", () => {
    writeJson(userFile(agentDir), { mcpServers: { MiniMax: { command: "uvx" } } });
    writeJson(adapterGlobal(agentDir), {
      mcpServers: {
        MiniMax: { command: "uvx", directTools: true },
        zread: { url: "https://z.example", directTools: true },
      },
    });

    const result = listMcpServers(agentDir, projectDir);
    const target = result.migrations.find((m) => m.id === "adapterGlobal");
    expect(target?.missing).toEqual(["zread"]);
    expect(target?.sourceFile).toBe(adapterGlobal(agentDir));
  });

  it("offers shared-global and shared-project layers native pi never reads", () => {
    writeJson(agentsGlobal(home), { mcpServers: { grep: { url: "https://g.example" } } });
    writeJson(sharedProject(projectDir), {
      mcpServers: { repoShared: { command: "run shared" } },
    });

    const result = listMcpServers(agentDir, projectDir);
    const shared = result.migrations.find((m) => m.id === "sharedGlobal");
    expect(shared?.missing).toEqual(["grep"]);
    expect(shared?.sourceFile).toBe(agentsGlobal(home));
    const proj = result.migrations.find((m) => m.id === "sharedProject");
    expect(proj?.missing).toEqual(["repoShared"]);
  });

  it("offers the orphaned adapter project config against .pi/mcp.json", () => {
    writeJson(adapterProject(projectDir), { mcpServers: { local: { command: "run" } } });
    const result = listMcpServers(agentDir, projectDir);
    const target = result.migrations.find((m) => m.id === "adapterProject");
    expect(target?.missing).toEqual(["local"]);
    expect(target?.sourceFile).toBe(adapterProject(projectDir));
  });

  it("reports group errors for malformed JSON and hides empty migrations", () => {
    mkdirSync(join(agentDir, ""), { recursive: true });
    writeFileSync(userFile(agentDir), "{ not json", "utf8");
    const result = listMcpServers(agentDir, projectDir);
    expect(result.groupErrors.piGlobal).toBeTruthy();
    expect(result.migrations).toEqual([]);
  });

  it("skips the project group entirely when cwd is the home directory", () => {
    writeJson(projectFile(home), { mcpServers: { stray: { command: "x" } } });
    const result = listMcpServers(agentDir, home);
    expect(result.groups.project).toEqual([]);
  });
});

describe("saveMcpServer (native validation)", () => {
  it("writes into the user file and preserves unrelated document keys", () => {
    writeJson(userFile(agentDir), { other: true, mcpServers: { keep: { command: "k" } } });
    const result = saveMcpServer(
      { scope: "piGlobal", name: "docs", entry: { url: "https://d.example" } },
      agentDir,
      projectDir,
    );
    expect(result.path).toBe(userFile(agentDir));
    const doc = readJson(userFile(agentDir));
    expect(doc.other).toBe(true);
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["docs", "keep"]);
    expect(doc.mcpServers.docs).toEqual({ url: "https://d.example" });
  });

  it("writes into .pi/mcp.json for project scope and rejects it without a cwd", () => {
    const result = saveMcpServer(
      { scope: "project", name: "docs", entry: { command: "run" } },
      agentDir,
      projectDir,
    );
    expect(result.path).toBe(projectFile(projectDir));
    expect(() =>
      saveMcpServer({ scope: "project", name: "x", entry: { command: "run" } }, agentDir, ""),
    ).toThrow(/No active project/);
  });

  it("rejects dots in server names and -/_ near-duplicates (native rules)", () => {
    expect(() =>
      saveMcpServer(
        { scope: "piGlobal", name: "my.server", entry: { command: "a" } },
        agentDir,
        "",
      ),
    ).toThrow(/letters, digits/);
    writeJson(userFile(agentDir), { mcpServers: { "dev-radius": { command: "a" } } });
    expect(() =>
      saveMcpServer(
        { scope: "piGlobal", name: "dev_radius", entry: { command: "b" } },
        agentDir,
        "",
      ),
    ).toThrow(/differ only in/i);
  });

  it("keeps transports mutually exclusive and validates native fields", () => {
    saveMcpServer(
      {
        scope: "piGlobal",
        name: "mixed",
        entry: { command: "npx", args: ["-y", "x"], url: "https://u.example" },
      },
      agentDir,
      projectDir,
    );
    // url wins: command/args cleared.
    expect(readJson(userFile(agentDir)).mcpServers.mixed).toEqual({ url: "https://u.example" });

    expect(() =>
      saveMcpServer(
        { scope: "piGlobal", name: "bad", entry: { command: "x", exposure: "loud" } },
        agentDir,
        projectDir,
      ),
    ).toThrow(/exposure/);
    saveMcpServer(
      {
        scope: "piGlobal",
        name: "ok",
        entry: { command: "x", exposure: "direct", timeout: 30, enabled: false, description: "d" },
      },
      agentDir,
      projectDir,
    );
    expect(readJson(userFile(agentDir)).mcpServers.ok).toEqual({
      command: "x",
      exposure: "direct",
      timeout: 30,
      enabled: false,
      description: "d",
    });
  });

  it("preserves unknown existing fields on edit", () => {
    writeJson(userFile(agentDir), {
      mcpServers: { docs: { command: "npx", futureField: { a: 1 } } },
    });
    saveMcpServer(
      { scope: "piGlobal", name: "docs", entry: { command: "npx2" } },
      agentDir,
      projectDir,
    );
    expect(readJson(userFile(agentDir)).mcpServers.docs.futureField).toEqual({ a: 1 });
  });
});

describe("deleteMcpServer", () => {
  it("deletes idempotently and keeps other entries", () => {
    writeJson(userFile(agentDir), {
      mcpServers: { a: { command: "a" }, b: { command: "b" } },
    });
    deleteMcpServer({ scope: "piGlobal", name: "a" }, agentDir, projectDir);
    deleteMcpServer({ scope: "piGlobal", name: "a" }, agentDir, projectDir);
    expect(Object.keys(readJson(userFile(agentDir)).mcpServers)).toEqual(["b"]);
  });
});

describe("toggleMcpServer (in-place enabled flag)", () => {
  it("disables by setting enabled:false in the defining file and enables by removing it", () => {
    writeJson(userFile(agentDir), { mcpServers: { docs: { command: "npx" } } });

    const off = toggleMcpServer(
      { scope: "piGlobal", name: "docs", disable: true },
      agentDir,
      projectDir,
    );
    expect(off).toEqual({ name: "docs", enabled: false, changed: true });
    expect(readJson(userFile(agentDir)).mcpServers.docs.enabled).toBe(false);

    const noop = toggleMcpServer(
      { scope: "piGlobal", name: "docs", disable: true },
      agentDir,
      projectDir,
    );
    expect(noop.changed).toBe(false);

    const on = toggleMcpServer(
      { scope: "piGlobal", name: "docs", disable: false },
      agentDir,
      projectDir,
    );
    expect(on).toEqual({ name: "docs", enabled: true, changed: true });
    expect(readJson(userFile(agentDir)).mcpServers.docs.enabled).toBeUndefined();
  });

  it("toggles a project entry in .pi/mcp.json", () => {
    writeJson(projectFile(projectDir), { mcpServers: { repo: { url: "https://r" } } });
    toggleMcpServer({ scope: "project", name: "repo", disable: true }, agentDir, projectDir);
    expect(readJson(projectFile(projectDir)).mcpServers.repo.enabled).toBe(false);
  });
});

describe("migrateAdapterConfig", () => {
  it("merges only missing adapter-global entries with field mapping and lossy reporting", () => {
    writeJson(userFile(agentDir), { mcpServers: { MiniMax: { command: "uvx" } } });
    writeJson(adapterGlobal(agentDir), {
      mcpServers: {
        MiniMax: { command: "old", directTools: true },
        zread: { url: "https://z", directTools: true },
        paused: { command: "p", disabled: true },
        weird: { command: "w", directTools: false, inheritEnv: true, lifecycle: "x" },
      },
    });

    const result = migrateAdapterConfig({ target: "adapterGlobal" }, agentDir, projectDir);
    expect(result.migrated.sort()).toEqual(["paused", "weird", "zread"]);
    expect(result.skipped).toEqual(["MiniMax"]);
    expect(result.lossy).toEqual(["weird"]);

    const doc = readJson(userFile(agentDir));
    expect(doc.mcpServers.MiniMax).toEqual({ command: "uvx" }); // untouched
    expect(doc.mcpServers.zread).toEqual({ url: "https://z", exposure: "direct" });
    expect(doc.mcpServers.paused).toEqual({ command: "p", enabled: false });
    expect(doc.mcpServers.weird).toEqual({ command: "w" });
    // Source file always stays; migration is a copy, not a move.
    expect(readJson(adapterGlobal(agentDir)).mcpServers.zread).toBeDefined();
  });

  it("migrates the adapter project config into .pi/mcp.json", () => {
    writeJson(adapterProject(projectDir), {
      mcpServers: { local: { command: "run", directTools: true } },
    });
    const result = migrateAdapterConfig({ target: "adapterProject" }, agentDir, projectDir);
    expect(result.migrated).toEqual(["local"]);
    expect(readJson(projectFile(projectDir)).mcpServers.local).toEqual({
      command: "run",
      exposure: "direct",
    });
  });

  it("migrates shared-global layers (later-wins among them) into the user file", () => {
    writeJson(sharedGlobal(home), {
      mcpServers: { grep: { url: "https://g1" }, first: { command: "a" } },
    });
    writeJson(agentsGlobal(home), { mcpServers: { grep: { url: "https://g2" } } });

    const result = migrateAdapterConfig({ target: "sharedGlobal" }, agentDir, projectDir);
    expect(result.migrated.sort()).toEqual(["first", "grep"]);
    const doc = readJson(userFile(agentDir));
    expect(doc.mcpServers.grep).toEqual({ url: "https://g2" });
    expect(doc.mcpServers.first).toEqual({ command: "a" });
  });

  it("migrates the shared project .mcp.json into .pi/mcp.json", () => {
    writeJson(sharedProject(projectDir), { mcpServers: { repoShared: { command: "run" } } });
    const result = migrateAdapterConfig({ target: "sharedProject" }, agentDir, projectDir);
    expect(result.migrated).toEqual(["repoShared"]);
    expect(readJson(projectFile(projectDir)).mcpServers.repoShared).toEqual({ command: "run" });
  });

  it("is a no-op when nothing is missing", () => {
    writeJson(adapterGlobal(agentDir), { mcpServers: { docs: { command: "x" } } });
    writeJson(userFile(agentDir), { mcpServers: { docs: { command: "x" } } });
    const result = migrateAdapterConfig({ target: "adapterGlobal" }, agentDir, projectDir);
    expect(result).toEqual({ migrated: [], skipped: ["docs"], lossy: [] });
  });

  it("rejects unknown targets", () => {
    expect(() => migrateAdapterConfig({ target: "adapter" }, agentDir, projectDir)).toThrow(
      /target/,
    );
  });
});

describe("stripJsonComments", () => {
  it("strips comments and trailing commas string-aware", () => {
    const raw = `{
      // line comment
      "a": "http://x", /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ a: "http://x", b: [1, 2] });
  });
});
