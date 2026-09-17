// ABOUTME: Bridge ops for advisor's config (XDG-aware rpiv-advisor/advisor.json); pi-fff moved to
// ABOUTME: the host control plane (src-tauri/src/fff_config.rs) so landing pages can configure it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

/** Advisor's GradedEffort ordinal (messages.ts) — excludes "off", which the
 * advisor stores as an absent key, never a value. */
const ADVISOR_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface CatalogModelLike {
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, unknown>;
}

interface RegistryLike {
  getAll: () => CatalogModelLike[];
  getAvailable: () => CatalogModelLike[] | Promise<CatalogModelLike[]>;
}

function homeDir(): string {
  // Mirrors picot-config.ts's resolveHomeDir precedence so tests can hermetically
  // redirect via HOME (os.homedir() on macOS ignores the env override).
  const fromEnv = process.env.HOME ?? process.env.USERPROFILE;
  if (fromEnv?.trim()) return fromEnv;
  return os.homedir();
}

/** Default config directory: `~/.config` — the legacy, pre-XDG location and
 * the base when XDG_CONFIG_HOME doesn't qualify. */
function defaultConfigDir(): string {
  return path.join(homeDir(), ".config");
}

/** Expand a leading `~` / `~/…` to home. `~user` forms are NOT expanded
 * (XDG defines no `~user`), so they fail the absolute check and route to the
 * default config dir. Mirrors rpiv-config's expandTilde. */
function expandTilde(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return path.join(homeDir(), p.slice(2));
  return p;
}

/** rpiv-config's resolveConfigDir: XDG_CONFIG_HOME (trimmed) wins only when
 * it expands (tilde) to an absolute path; unset / empty / whitespace-only /
 * relative values all route to the default `~/.config`. */
function resolveConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (!xdg) return defaultConfigDir();
  const expanded = expandTilde(xdg);
  return path.isAbsolute(expanded) ? expanded : defaultConfigDir();
}

/** rpiv-config's configPath("rpiv-advisor", "advisor.json") — the advisor's
 * own write path (ADVISOR_CONFIG_PATH); Picot must write the exact same file. */
export function advisorConfigPath(): string {
  return path.join(resolveConfigDir(), "rpiv-advisor", "advisor.json");
}

/** Always-legacy path under `~/.config`, deliberately ignoring
 * XDG_CONFIG_HOME — the read-fallback target so a pre-XDG config file is
 * still discovered after an operator sets XDG_CONFIG_HOME. */
function legacyAdvisorConfigPath(): string {
  return path.join(defaultConfigDir(), "rpiv-advisor", "advisor.json");
}

/** rpiv-config's loadJsonConfigWithLegacyFallback semantics: the XDG path
 * wins when present (malformed there → {}, never silently masked by legacy);
 * only when it is missing does the legacy path serve. Both missing/malformed → {}. */
function readAdvisorConfigFile(): Record<string, unknown> {
  const xdgPath = advisorConfigPath();
  const filePath = fs.existsSync(xdgPath) ? xdgPath : legacyAdvisorConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Atomic write with the same format as rpiv-config's saveJsonConfig
 * (2-space JSON + trailing newline), but tmp+rename so an interrupted write
 * can never truncate the file. chmod 0600 rides on the tmp file. */
function writeConfigAtomic(filePath: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Best-effort — same posture as saveJsonConfig; some filesystems ignore chmod.
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Advisor config + the model catalog the renderer needs, in one round trip.
 * The TUI's effort list (command.ts buildEffortItems) intersects
 * getSupportedThinkingLevels with the GradedEffort ordinal; the same
 * intersection is computed here so the GUI can never offer an effort the
 * advisor would refuse to rank.
 */
export async function advisorConfigGet(registry: RegistryLike): Promise<{
  modelKey?: string;
  effort?: string;
  models: Array<{ key: string; name: string; levels: string[]; available: boolean }>;
}> {
  const config = readAdvisorConfigFile();
  const all = registry.getAll();
  const available = new Set((await registry.getAvailable()).map((m) => `${m.provider}/${m.id}`));
  const models = all
    .filter((m): m is CatalogModelLike & { provider: string; id: string } =>
      Boolean(m.provider && m.id),
    )
    .map((m) => ({
      key: `${m.provider}/${m.id}`,
      name: typeof m.name === "string" ? m.name : (m.id as string),
      levels: getSupportedThinkingLevels(m as never).filter((level) =>
        (ADVISOR_EFFORTS as readonly string[]).includes(level),
      ),
      available: available.has(`${m.provider}/${m.id}`),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    modelKey: typeof config.modelKey === "string" ? config.modelKey : undefined,
    effort: typeof config.effort === "string" ? config.effort : undefined,
    models,
  };
}

/**
 * Read-modify-write mirroring the advisor's own saveAdvisorConfig spread:
 * guidance / disabledForModels / unknown keys survive untouched. Each field
 * is absent = leave unchanged, null = clear, string = set.
 */
export function advisorConfigSet(params: Record<string, unknown>): {
  config: Record<string, unknown>;
} {
  const doc = readAdvisorConfigFile();

  if ("modelKey" in params) {
    if (params.modelKey === null || params.modelKey === "") delete doc.modelKey;
    else if (typeof params.modelKey === "string") doc.modelKey = params.modelKey;
    else throw new Error("modelKey must be a string or null");
  }
  if ("effort" in params) {
    if (params.effort === null || params.effort === "") delete doc.effort;
    else if (typeof params.effort === "string") {
      if (!(ADVISOR_EFFORTS as readonly string[]).includes(params.effort)) {
        throw new Error(`effort must be one of ${ADVISOR_EFFORTS.join(", ")}`);
      }
      doc.effort = params.effort;
    } else throw new Error("effort must be a string or null");
  }

  writeConfigAtomic(advisorConfigPath(), doc);
  return { config: doc };
}
