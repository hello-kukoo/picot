// ABOUTME: MCP server inventory and mutation ops over Pi 0.99+ native config files.
// ABOUTME: Manages the two native layers (user ~/.pi/agent/mcp.json + project .pi/mcp.json); migrates orphaned adapter/shared layers.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type McpWriteScope = "piGlobal" | "project";

export interface McpListEntry {
  name: string;
  entry: Record<string, unknown>;
  /** Absolute path of the file this entry is defined in. */
  sourceFile: string;
  /** Native files are always pi-owned and editable. */
  editable: true;
  /** Native enabled state: false only when the entry carries `enabled: false`. */
  enabled: boolean;
}

export interface McpMigrationTarget {
  id: "adapterGlobal" | "adapterProject" | "sharedGlobal" | "sharedProject";
  sourceFile: string;
  /** Entry names present in the source but missing from the native target file. */
  missing: string[];
}

interface McpLayerRead {
  doc: Record<string, unknown> | null;
  serverKey: string;
  error?: string;
}

/** Native server names: letters, digits, `_`, `-` (docs/mcp.md configuration rules). */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXPOSURE_VALUES = new Set(["direct", "codemode", "codemode-deferred", "deferred", "hidden"]);
const ENTRY_STRING_KEYS = new Set(["url", "cwd", "description"]);
const ENTRY_OBJECT_KEYS = new Set(["env", "headers", "toolExposure"]);
const ADAPTER_DROP_FIELDS = ["directTools", "inheritEnv", "lifecycle", "disabled"] as const;

const SHARED_GLOBAL_FILENAMES = [
  path.join(".config", "mcp", "mcp.json"),
  path.join(".agents", "mcp.json"),
  path.join(".agents", "mcp", "mcp.json"),
] as const;

function homeDir(): string {
  // Mirrors picot-config.ts's resolveHomeDir precedence: env override first,
  // passwd fallback second. Keeps temp-dir tests hermetic on macOS where
  // os.homedir() ignores process.env.HOME.
  const fromEnv = process.env.HOME ?? process.env.USERPROFILE;
  if (fromEnv?.trim()) return fromEnv;
  return os.homedir();
}

/** JSONC tolerance shared with the adapter era: strips // and block comments
 * plus trailing commas, string-aware so `//` inside a value survives. */
export function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < raw.length) out += raw[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readMcpLayer(filePath: string): McpLayerRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { doc: null, serverKey: "mcpServers" }; // ENOENT: layer absent.
  }
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    const serverKey =
      parsed.mcpServers !== undefined
        ? "mcpServers"
        : parsed["mcp-servers"] !== undefined
          ? "mcp-servers"
          : "mcpServers";
    const servers = parsed[serverKey];
    if (
      servers !== undefined &&
      (typeof servers !== "object" || servers === null || Array.isArray(servers))
    ) {
      return { doc: parsed, serverKey, error: `${serverKey} is not an object` };
    }
    return { doc: parsed, serverKey };
  } catch (error) {
    return {
      doc: null,
      serverKey: "mcpServers",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Native write format: 2-space JSON + trailing newline, atomic tmp+rename. */
function writeMcpLayer(filePath: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  // 0600 on create: MCP configs can carry env secrets, and the rename keeps
  // the temp file's permissions (same contract as advisor.json).
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function userPath(agentDir: string): string {
  return path.join(agentDir, "mcp.json");
}

function projectPath(cwd: string): string {
  return path.join(cwd, ".pi", "mcp.json");
}

function serversOf(layer: McpLayerRead): Record<string, Record<string, unknown>> {
  if (!layer.doc) return {};
  const servers = layer.doc[layer.serverKey];
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, Record<string, unknown>>)
    : {};
}

/** Migration sources, in stable order. Each is read-only forever: the
 * migration is a user-confirmed copy of missing entries, never a move. */
function migrationSources(
  agentDir: string,
  cwd: string,
): { id: McpMigrationTarget["id"]; files: string[]; target: "user" | "project" }[] {
  const sources: { id: McpMigrationTarget["id"]; files: string[]; target: "user" | "project" }[] = [
    { id: "adapterGlobal", files: [path.join(agentDir, "mcp-adapter.json")], target: "user" },
  ];
  if (cwd && cwd !== homeDir()) {
    sources.push({
      id: "adapterProject",
      files: [path.join(cwd, ".pi", "mcp-adapter.json")],
      target: "project",
    });
    sources.push({ id: "sharedProject", files: [path.join(cwd, ".mcp.json")], target: "project" });
  }
  sources.push({
    id: "sharedGlobal",
    files: SHARED_GLOBAL_FILENAMES.map((rel) => path.join(homeDir(), rel)),
    target: "user",
  });
  return sources;
}

/** Merge the source files' entries later-wins, like the adapter used to. */
function mergeFiles(files: string[]): {
  merged: Map<string, Record<string, unknown>>;
  error?: string;
} {
  const merged = new Map<string, Record<string, unknown>>();
  let error: string | undefined;
  for (const file of files) {
    const layer = readMcpLayer(file);
    if (layer.error) error ??= layer.error;
    for (const [name, entry] of Object.entries(serversOf(layer))) merged.set(name, entry);
  }
  return { merged, error };
}

function toListEntries(layer: McpLayerRead, filePath: string): McpListEntry[] {
  return Object.entries(serversOf(layer)).map(([name, entry]) => ({
    name,
    entry,
    sourceFile: filePath,
    editable: true as const,
    enabled: entry.enabled !== false,
  }));
}

/** Inventory across the two native files, plus available one-shot migrations
 * from orphaned adapter/shared layers that native Pi never reads. */
export function listMcpServers(
  agentDir: string,
  cwd: string,
): {
  groups: { piGlobal: McpListEntry[]; project: McpListEntry[] };
  groupErrors: { piGlobal?: string; project?: string };
  migrations: McpMigrationTarget[];
  /** False when no workspace is active (cwd empty/home): the project layer
   *  does not exist, so the UI hides the project tab entirely. */
  projectAvailable: boolean;
} {
  const userLayer = { filePath: userPath(agentDir), layer: readMcpLayer(userPath(agentDir)) };
  const projectLayer =
    cwd && cwd !== homeDir()
      ? { filePath: projectPath(cwd), layer: readMcpLayer(projectPath(cwd)) }
      : null;

  const migrations: McpMigrationTarget[] = [];
  for (const source of migrationSources(agentDir, cwd)) {
    const targetLayer = source.target === "user" ? userLayer : projectLayer;
    if (!targetLayer) continue;
    const existing = new Set(Object.keys(serversOf(targetLayer.layer)));
    const { merged } = mergeFiles(source.files);
    const missing = [...merged.keys()].filter((name) => !existing.has(name));
    if (missing.length > 0) {
      const sourceFile = source.files.find((f) => fs.existsSync(f)) ?? source.files[0];
      migrations.push({ id: source.id, sourceFile, missing });
    }
  }

  return {
    groups: {
      piGlobal: toListEntries(userLayer.layer, userLayer.filePath),
      project: projectLayer ? toListEntries(projectLayer.layer, projectLayer.filePath) : [],
    },
    groupErrors: {
      piGlobal: userLayer.layer.error,
      project: projectLayer?.layer.error,
    },
    migrations,
    projectAvailable: projectLayer !== null,
  };
}

function writeScopeTarget(scope: McpWriteScope, agentDir: string, cwd: string): string {
  if (scope === "piGlobal") return userPath(agentDir);
  if (!cwd) throw new Error("No active project for project-scoped MCP writes");
  return projectPath(cwd);
}

function parseWriteScope(value: unknown): McpWriteScope {
  if (value === "piGlobal" || value === "project") return value;
  throw new Error("scope must be piGlobal or project");
}

/** Native rule: `-` and `_` are the same separator, so dev-radius and
 * dev_radius collide and the second one is rejected. */
function nameKey(name: string): string {
  return name.replace(/[-_]/g, "_");
}

function validateServerName(name: unknown, existingNames: string[]): string {
  if (typeof name !== "string" || !SERVER_NAME_RE.test(name)) {
    throw new Error("Server name may contain only letters, digits, _ and -");
  }
  const key = nameKey(name);
  const collision = existingNames.find(
    (existing) => existing !== name && nameKey(existing) === key,
  );
  if (collision) {
    throw new Error(
      `Server names that differ only in - and _ count as the same server (conflicts with ${collision})`,
    );
  }
  return name;
}

function asStringMap(value: unknown, key: string, validateValues?: (v: string) => void) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`${key}.${k} must be a string`);
    if (validateValues) validateValues.call(null, v);
    out[k] = v;
  }
  return out;
}

/**
 * Keeps only native-known entry fields from `entry`, preserving unknown keys
 * already present in `existing` (Pi may grow fields Picot doesn't know).
 */
function normalizeEntry(
  entry: unknown,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Server entry must be an object");
  }
  const source = entry as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...existing };

  // Transport: mutually exclusive — setting one clears the other.
  if (source.command === undefined) {
    // absent: keep existing (form omits unchanged fields)
  } else if (typeof source.command === "string" && source.command.trim()) {
    merged.command = source.command.trim();
  } else if (Array.isArray(source.command) && source.command.length > 0) {
    merged.command = source.command;
  } else if (source.command === null || source.command === "") {
    delete merged.command;
  } else {
    // Exposed RPC boundary: a non-string/non-array command must error,
    // not silently fall through and keep the previous value.
    throw new Error("command must be a string or an array of strings");
  }
  if (source.url !== undefined) {
    if (source.url === null || source.url === "") {
      delete merged.url;
      delete merged.headers;
    } else if (typeof source.url === "string" && source.url.trim()) {
      merged.url = source.url.trim();
      delete merged.command;
      delete merged.args;
    } else {
      throw new Error("url must be a non-empty string");
    }
  }

  if (source.args === null) delete merged.args;
  else if (source.args !== undefined) {
    if (!Array.isArray(source.args) || !source.args.every((a) => typeof a === "string")) {
      throw new Error("args must be an array of strings");
    }
    merged.args = source.args;
  }

  for (const key of ENTRY_STRING_KEYS) {
    if (source[key] === null || source[key] === "") {
      delete merged[key];
      continue;
    }
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "string") throw new Error(`${key} must be a string`);
    merged[key] = source[key];
  }
  for (const key of ENTRY_OBJECT_KEYS) {
    if (source[key] === null) {
      delete merged[key];
      continue;
    }
    if (source[key] === undefined) continue;
    const value = source[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${key} must be an object`);
    }
    if (key === "toolExposure") {
      merged[key] = asStringMap(value, key, (v) => {
        if (!EXPOSURE_VALUES.has(v))
          throw new Error(`toolExposure value must be an exposure: ${v}`);
      });
    } else {
      merged[key] = asStringMap(value, key);
    }
  }

  if (source.exposure !== undefined && source.exposure !== null) {
    if (typeof source.exposure !== "string" || !EXPOSURE_VALUES.has(source.exposure)) {
      throw new Error(`exposure must be one of ${[...EXPOSURE_VALUES].join(", ")}`);
    }
    merged.exposure = source.exposure;
  } else if (source.exposure === null) {
    delete merged.exposure;
  }

  if (source.timeout !== undefined && source.timeout !== null) {
    if (typeof source.timeout !== "number" || !(source.timeout > 0)) {
      throw new Error("timeout must be a positive number of seconds");
    }
    merged.timeout = source.timeout;
  } else if (source.timeout === null) {
    delete merged.timeout;
  }

  if (source.enabled !== undefined && source.enabled !== null) {
    if (typeof source.enabled !== "boolean") throw new Error("enabled must be a boolean");
    merged.enabled = source.enabled;
  } else if (source.enabled === null) {
    delete merged.enabled;
  }

  // Final transport arbitration: whichever transport is present wins and the
  // other transport's fields are dropped — regardless of the order the form
  // sent them in.
  if (merged.url !== undefined) {
    delete merged.command;
    delete merged.args;
  } else if (merged.command !== undefined) {
    delete merged.url;
    delete merged.headers;
  }
  if (merged.command === undefined && merged.url === undefined) {
    throw new Error("Server entry needs a command (stdio) or a url (remote)");
  }
  return merged;
}

export function saveMcpServer(
  params: Record<string, unknown>,
  agentDir: string,
  cwd: string,
): { scope: McpWriteScope; name: string; path: string } {
  // ponytail: read-modify-write with no lock — two rapid saves can lose one
  // update. Single-user settings UI, acceptable; add a queue if it bites.
  const scope = parseWriteScope(params.scope);
  const filePath = writeScopeTarget(scope, agentDir, cwd);
  const layer = readMcpLayer(filePath);
  const doc: Record<string, unknown> = layer.doc ?? {};
  const servers = serversOf(layer);
  const name = validateServerName(params.name, Object.keys(servers));
  servers[name] = normalizeEntry(params.entry, servers[name]);
  doc[layer.serverKey] = servers;
  writeMcpLayer(filePath, doc);
  return { scope, name, path: filePath };
}

export function deleteMcpServer(
  params: Record<string, unknown>,
  agentDir: string,
  cwd: string,
): { scope: McpWriteScope; name: string; path: string } {
  const scope = parseWriteScope(params.scope);
  const name = params.name;
  if (typeof name !== "string") throw new Error("name must be a string");
  const filePath = writeScopeTarget(scope, agentDir, cwd);
  const layer = readMcpLayer(filePath);
  if (!layer.doc || !(name in serversOf(layer))) return { scope, name, path: filePath }; // Idempotent delete.
  const servers = serversOf(layer);
  delete servers[name];
  layer.doc[layer.serverKey] = servers;
  writeMcpLayer(filePath, layer.doc);
  return { scope, name, path: filePath };
}

/**
 * Native disable semantics: the `enabled` flag lives on the entry in the
 * file that defines it. Disabling sets `enabled: false`; enabling removes
 * the flag so the default (enabled) applies.
 */
export function toggleMcpServer(
  params: Record<string, unknown>,
  agentDir: string,
  cwd: string,
): { name: string; enabled: boolean; changed: boolean } {
  const scope = parseWriteScope(params.scope);
  const disable = params.disable === true;
  const filePath = writeScopeTarget(scope, agentDir, cwd);
  const layer = readMcpLayer(filePath);
  const servers = serversOf(layer);
  const name = typeof params.name === "string" ? params.name : "";
  if (!layer.doc) throw new Error(`Unknown MCP server in ${filePath}: ${name || "(none)"}`);
  const existing = servers[name] as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`Unknown MCP server in ${filePath}: ${name || "(none)"}`);

  let next: Record<string, unknown>;
  if (disable) {
    next = { ...existing, enabled: false };
  } else {
    next = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "enabled"));
  }
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) {
    servers[name] = next;
    layer.doc[layer.serverKey] = servers;
    writeMcpLayer(filePath, layer.doc);
  }
  return { name, enabled: !disable, changed };
}

/** Adapter→native field mapping for the migration copy. Returns the mapped
 * entry plus whether adapter-only fields had to be dropped. */
function mapAdapterEntry(raw: Record<string, unknown>): {
  entry: Record<string, unknown>;
  lossy: boolean;
} {
  const entry: Record<string, unknown> = { ...raw };
  let lossy = false;
  if (entry.disabled === true) entry.enabled = false;
  if (entry.directTools === true) entry.exposure = "direct";
  for (const field of ADAPTER_DROP_FIELDS) {
    if (field in entry) {
      delete entry[field];
      if (field === "inheritEnv" || field === "lifecycle") lossy = true;
    }
  }
  return { entry, lossy };
}

/**
 * User-confirmed one-shot copy from an orphaned adapter/shared layer into the
 * matching native file. Only names missing from the target are merged; the
 * source file is always left in place.
 */
export function migrateAdapterConfig(
  params: Record<string, unknown>,
  agentDir: string,
  cwd: string,
): { migrated: string[]; skipped: string[]; lossy: string[] } {
  const target = params.target;
  const source = migrationSources(agentDir, cwd).find((s) => s.id === target);
  if (!source) throw new Error(`Unknown migration target: ${String(target)}`);
  if (source.target === "project" && !(cwd && cwd !== homeDir())) {
    throw new Error("No active project for project-scoped MCP migration");
  }

  const filePath = source.target === "user" ? userPath(agentDir) : projectPath(cwd);
  const layer = readMcpLayer(filePath);
  const doc: Record<string, unknown> = layer.doc ?? {};
  const servers = serversOf(layer);
  const { merged } = mergeFiles(source.files);

  const migrated: string[] = [];
  const skipped: string[] = [];
  const lossy: string[] = [];
  for (const [name, raw] of merged) {
    if (name in servers) {
      skipped.push(name);
      continue;
    }
    const mapped = mapAdapterEntry(raw);
    servers[name] = mapped.entry;
    migrated.push(name);
    if (mapped.lossy) lossy.push(name);
  }
  if (migrated.length > 0) {
    doc[layer.serverKey] = servers;
    writeMcpLayer(filePath, doc);
  }
  return { migrated, skipped, lossy };
}
