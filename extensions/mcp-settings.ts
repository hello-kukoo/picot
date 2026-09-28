// ABOUTME: MCP server inventory and mutation ops over pi-mcp-adapter's layered config files.
// ABOUTME: Reads four adapter sources (shared-global, pi-global, shared-project, pi-project); writes only pi-owned mcp-adapter.json layers.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type McpWriteScope = "piGlobal" | "project";

export interface McpListEntry {
  name: string;
  entry: Record<string, unknown>;
  /** Absolute path of the file this entry was last defined in. */
  sourceFile: string;
  /** True only for pi-owned sources: the pi-global and pi-project mcp-adapter.json files. */
  editable: boolean;
  /** The entry's own `disabled` flag in its source file. */
  ownDisabled: boolean;
  /** Disabled state after the adapter's full later-wins merge across all sources. */
  effectiveDisabled: boolean;
}

interface McpLayerRead {
  doc: Record<string, unknown> | null;
  serverKey: string;
  error?: string;
}

const SHARED_GLOBAL_FILENAMES = [
  path.join(".config", "mcp", "mcp.json"),
  path.join(".agents", "mcp.json"),
  path.join(".agents", "mcp", "mcp.json"),
] as const;

const SERVER_NAME_RE = /^[\w.-]+$/;
const ENTRY_STRING_KEYS = new Set(["url", "cwd", "lifecycle"]);
const ENTRY_OBJECT_KEYS = new Set(["env", "headers"]);
const ENTRY_BOOL_KEYS = new Set(["directTools", "inheritEnv", "disabled"]);

function homeDir(): string {
  // Mirrors picot-config.ts's resolveHomeDir precedence: env override first,
  // passwd fallback second. Keeps temp-dir tests hermetic on macOS where
  // os.homedir() ignores process.env.HOME.
  const fromEnv = process.env.HOME ?? process.env.USERPROFILE;
  if (fromEnv?.trim()) return fromEnv;
  return os.homedir();
}

/**
 * Port of the adapter's parseJsonWithComments tolerance: strips // and
 * block comments plus trailing commas, string-aware so `//` inside a value
 * survives.
 */
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
  // Trailing commas: a comma followed only by whitespace and a closer.
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
    // Adapter compatibility: read either key, write back under the same one.
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

/** Adapter write format: 2-space JSON + trailing newline, atomic tmp+rename. */
function writeMcpLayer(filePath: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  // 0600 on create: MCP configs can carry env secrets, and the rename keeps
  // the temp file's permissions (same contract as advisor.json).
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function sharedGlobalPaths(): string[] {
  return SHARED_GLOBAL_FILENAMES.map((rel) => path.join(homeDir(), rel));
}

function piGlobalPath(agentDir: string): string {
  // pi-mcp-adapter 3.x owns mcp-adapter.json; mcp.json now belongs to Pi's
  // built-in MCP support and is ignored by the adapter (see its CHANGELOG 3.0.0).
  return path.join(agentDir, "mcp-adapter.json");
}

/** Pre-3.0 adapter config location. Read-only migration source, never written. */
function legacyPiGlobalPath(agentDir: string): string {
  return path.join(agentDir, "mcp.json");
}

/**
 * Detection for the settings page: a pre-3.0 `<agent dir>/mcp.json` exists
 * that the adapter no longer reads. Read-only — the copy itself runs only
 * through the explicit `mcp_migrate_legacy_config` op after the user confirms.
 */
function legacyMigrationStatus(
  agentDir: string,
  installed: boolean,
): { available: boolean; error?: string } {
  const target = piGlobalPath(agentDir);
  if (fs.existsSync(target)) return { available: false };
  const source = legacyPiGlobalPath(agentDir);
  const legacy = readMcpLayer(source);
  if (!legacy.doc) {
    if (!legacy.error || !installed) return { available: false };
    return {
      available: false,
      error: `${source} could not be migrated to ${target}: ${legacy.error}`,
    };
  }
  return { available: installed && Object.keys(serversOf(legacy)).length > 0 };
}

/**
 * The user-confirmed copy: pre-3.0 `<agent dir>/mcp.json` → `mcp-adapter.json`.
 * Runs only when the adapter is installed, the target is absent, and the
 * source parses with at least one server; the source file always stays.
 */
export function migrateLegacyPiGlobalConfig(agentDir: string): {
  migrated: boolean;
  error?: string;
} {
  const status = legacyMigrationStatus(agentDir, isAdapterInstalled(agentDir));
  if (status.error) return { migrated: false, error: status.error };
  if (!status.available) return { migrated: false };
  const legacy = readMcpLayer(legacyPiGlobalPath(agentDir));
  // The availability check above just parsed this file; a failure here means
  // it changed between the two reads, and refusing is the safe answer.
  if (!legacy.doc) return { migrated: false, error: "legacy config changed while migrating" };
  // Same race on the target: the check saw it absent, but the adapter or the
  // user may have created mcp-adapter.json since — a migration must never
  // overwrite config that appeared after the user confirmed.
  if (fs.existsSync(piGlobalPath(agentDir))) {
    return {
      migrated: false,
      error: "mcp-adapter.json appeared during migration; not overwritten",
    };
  }
  try {
    writeMcpLayer(piGlobalPath(agentDir), legacy.doc);
  } catch (error) {
    return {
      migrated: false,
      error: `${legacyPiGlobalPath(agentDir)} could not be migrated to ${piGlobalPath(agentDir)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { migrated: true };
}

function sharedProjectPath(cwd: string): string {
  return path.join(cwd, ".mcp.json");
}

function piProjectPath(cwd: string): string {
  return path.join(cwd, ".pi", "mcp-adapter.json");
}

function serversOf(layer: McpLayerRead): Record<string, Record<string, unknown>> {
  if (!layer.doc) return {};
  const servers = layer.doc[layer.serverKey];
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, Record<string, unknown>>)
    : {};
}

interface MergedEntry {
  entry: Record<string, unknown>;
  sourceFile: string;
}

/** Later-wins merge that remembers which file each surviving entry came from. */
function mergeLayers(
  layers: { filePath: string; layer: McpLayerRead }[],
): Map<string, MergedEntry> {
  const merged = new Map<string, MergedEntry>();
  for (const { filePath, layer } of layers) {
    for (const [name, entry] of Object.entries(serversOf(layer))) {
      merged.set(name, { entry, sourceFile: filePath });
    }
  }
  return merged;
}

function isAdapterInstalled(agentDir: string): boolean {
  const { doc } = readMcpLayer(path.join(agentDir, "settings.json"));
  if (!doc || !Array.isArray(doc.packages)) return false;

  return doc.packages.some((spec) => {
    const source =
      typeof spec === "string"
        ? spec
        : spec && typeof spec === "object" && typeof spec.source === "string"
          ? spec.source
          : undefined;
    if (!source) return false;

    const isAdapterSource =
      source === "npm:pi-mcp-adapter" ||
      source.startsWith("npm:pi-mcp-adapter@") ||
      source.replace(/\.git$/, "").endsWith("/pi-mcp-adapter");
    if (!isAdapterSource) return false;

    // An empty resource filter keeps the package installed but disables this
    // extension, so the MCP settings page has no runtime adapter to manage.
    return !(
      spec &&
      typeof spec === "object" &&
      Array.isArray(spec.extensions) &&
      spec.extensions.length === 0
    );
  });
}

function toListEntries(
  merged: Map<string, MergedEntry>,
  effective: Map<string, Record<string, unknown>>,
  editableFile: (filePath: string) => boolean,
): McpListEntry[] {
  const entries: McpListEntry[] = [];
  for (const [name, { entry, sourceFile }] of merged) {
    entries.push({
      name,
      entry,
      sourceFile,
      editable: editableFile(sourceFile),
      ownDisabled: entry.disabled === true,
      effectiveDisabled: effective.get(name)?.disabled === true,
    });
  }
  return entries;
}

/**
 * Inventory across the adapter's non-exclusive layer order:
 * shared-global (3 files) → pi-global → shared-project (.mcp.json) → pi-project (.pi/mcp-adapter.json).
 * Same-name entries: later layers win; the project group shows the winning
 * entry only (a shadowed .mcp.json definition is not listed separately).
 */
export function listMcpServers(
  agentDir: string,
  cwd: string,
): {
  installed: boolean;
  legacyMigration: { available: boolean };
  groups: { sharedGlobal: McpListEntry[]; piGlobal: McpListEntry[]; project: McpListEntry[] };
  groupErrors: { sharedGlobal?: string; piGlobal?: string; project?: string };
} {
  const sharedLayers = sharedGlobalPaths().map((filePath) => ({
    filePath,
    layer: readMcpLayer(filePath),
  }));
  // The page exists only to manage the adapter, so a missing adapter means no
  // migration: never create adapter config for a package the user does not run.
  const installed = isAdapterInstalled(agentDir);
  const legacy = legacyMigrationStatus(agentDir, installed);
  const piLayer = { filePath: piGlobalPath(agentDir), layer: readMcpLayer(piGlobalPath(agentDir)) };
  const projectLayers =
    cwd && cwd !== homeDir()
      ? [
          { filePath: sharedProjectPath(cwd), layer: readMcpLayer(sharedProjectPath(cwd)) },
          { filePath: piProjectPath(cwd), layer: readMcpLayer(piProjectPath(cwd)) },
        ]
      : [];

  const sharedMerged = mergeLayers(sharedLayers);
  const piMerged = mergeLayers([piLayer]);
  const projectMerged = mergeLayers(projectLayers);

  const effective = new Map<string, Record<string, unknown>>();
  for (const source of [sharedMerged, piMerged, projectMerged]) {
    for (const [name, { entry }] of source) effective.set(name, entry);
  }

  return {
    installed,
    legacyMigration: { available: legacy.available },
    groups: {
      sharedGlobal: toListEntries(sharedMerged, effective, () => false),
      piGlobal: toListEntries(piMerged, effective, () => true),
      project: toListEntries(
        projectMerged,
        effective,
        (filePath) => filePath === (cwd ? piProjectPath(cwd) : ""),
      ),
    },
    groupErrors: {
      sharedGlobal: sharedLayers.map((l) => l.layer.error).find(Boolean),
      piGlobal: piLayer.layer.error ?? legacy.error,
      project: projectLayers.map((l) => l.layer.error).find(Boolean),
    },
  };
}

function writeScopeTarget(scope: McpWriteScope, agentDir: string, cwd: string): string {
  if (scope === "piGlobal") return piGlobalPath(agentDir);
  if (!cwd) throw new Error("No active project for project-scoped MCP writes");
  return piProjectPath(cwd);
}

function parseWriteScope(value: unknown): McpWriteScope {
  if (value === "piGlobal" || value === "project") return value;
  throw new Error("scope must be piGlobal or project");
}

function validateServerName(name: unknown): string {
  if (typeof name !== "string" || !SERVER_NAME_RE.test(name)) {
    throw new Error("Server name must match [A-Za-z0-9_.-]");
  }
  return name;
}

/**
 * Keeps only known-good entry fields from `entry`, preserving unknown keys
 * already present in `existing` (adapter may grow fields Picot doesn't know).
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
    if (source[key] === null || source[key] === undefined) continue;
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
    if (typeof value !== "object" || Array.isArray(value))
      throw new Error(`${key} must be an object`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== "string") throw new Error(`${key}.${k} must be a string`);
    }
    merged[key] = value;
  }
  for (const key of ENTRY_BOOL_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    merged[key] = source[key];
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
  const name = validateServerName(params.name);
  const filePath = writeScopeTarget(scope, agentDir, cwd);
  const layer = readMcpLayer(filePath);
  const doc: Record<string, unknown> = layer.doc ?? {};
  const servers = serversOf(layer);
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
  const name = validateServerName(params.name);
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
 * TUI-aligned disable (writeProjectServerDisabledOverride): persists only
 * the `disabled` field into the pi-project layer, under the file's original
 * server key. Enable consults every lower source (shared-global, pi-global,
 * shared-project) to decide between writing `disabled: false` and removing
 * the flag; empty results delete the entry; no-op changes skip the write.
 *
 * ponytail: adapter's expandImports (host-config imports declared in
 * pi-owned files) is not expanded here — a server imported that way with
 * disabled:true will read as enabled after an enable click until imports
 * support lands. Update lowerLayers with expandImports when needed.
 */
export function toggleMcpServer(
  params: Record<string, unknown>,
  agentDir: string,
  cwd: string,
): { name: string; disabled: boolean | null; changed: boolean } {
  const name = validateServerName(params.name);
  const disable = params.disable === true;
  if (!cwd) throw new Error("No active project for MCP enable/disable");
  const filePath = piProjectPath(cwd);
  const layer = readMcpLayer(filePath);
  const doc: Record<string, unknown> = layer.doc ?? {};
  const servers = serversOf(layer);
  const existing = servers[name] as Record<string, unknown> | undefined;

  let next: Record<string, unknown>;
  if (disable) {
    next = { ...(existing ?? {}), disabled: true };
  } else {
    next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
    const lowerLayers = mergeLayers([
      ...sharedGlobalPaths().map((p) => ({ filePath: p, layer: readMcpLayer(p) })),
      { filePath: piGlobalPath(agentDir), layer: readMcpLayer(piGlobalPath(agentDir)) },
      { filePath: sharedProjectPath(cwd), layer: readMcpLayer(sharedProjectPath(cwd)) },
    ]);
    if (lowerLayers.get(name)?.entry.disabled === true) next.disabled = false;
  }

  const unchanged =
    (!existing && Object.keys(next).length === 0) ||
    JSON.stringify(existing) === JSON.stringify(next);
  const nextDisabled = next.disabled === true ? true : next.disabled === false ? false : null;
  if (unchanged) return { name, disabled: disable ? true : nextDisabled, changed: false };

  if (Object.keys(next).length === 0) delete servers[name];
  else servers[name] = next;
  doc[layer.serverKey] = servers;
  writeMcpLayer(filePath, doc);
  return { name, disabled: disable ? true : nextDisabled, changed: true };
}
