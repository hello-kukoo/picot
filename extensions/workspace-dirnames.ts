// ABOUTME: Maps a canonical workspace path to its historical session
// directory names under ~/.pi/agent/sessions using Pi's own encoding formula
// (--<path with / \ : -> --->), falling back to header-cwd sampling for
// directories written before that formula existed.
// ABOUTME: Injection-friendly so Node and Bun adapters share one resolution policy.

import * as path from "node:path";

/**
 * Pi's own session-directory encoding (coding-agent session-manager.ts):
 * `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`.
 *
 * Pi applies it to path.resolve(cwd) — NOT realpath — so symlinked roots
 * (/tmp, /var on macOS) encode differently from their canonicalized forms.
 */
export function encodeSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Best-effort display decode for directories that predate strict matching.
 * Lossy by design (original `-`/`:` chars are indistinguishable); header
 * sampling below is the authoritative fallback identity.
 */
export function decodeLossyDirName(dirName: string): string {
  return dirName.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
}

/**
 * Most frequent non-empty value; deterministic on ties (first seen wins),
 * mirroring the historical inference order inside serveSessionsList.
 */
export function pickMajorityValue(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export interface WorkspaceDirNameResolver {
  /** All historical directory names holding sessions for this path. */
  dirNamesForPath(canonicalPath: string): Promise<string[]>;
}

interface ResolverEntry {
  signature: string;
  /**
   * Sampling is expensive (bounded header reads per directory), so it runs
   * lazily: encode matches answer immediately; the full cwd-sample map is
   * built once in the background (or synchronously when encode misses).
   */
  sampled: boolean;
  pending?: Promise<void>;
  byPath: Map<string, string[]>;
}

// Module-level store survives repeated resolve calls and adapter choice;
// keyed by sessions dir so tests/instances never cross-pollute.
const cacheStore = new Map<string, ResolverEntry>();

/**
 * Candidate absolute spellings whose encodings may exist on disk: the
 * canonical form plus its resolve() re-spelling (differs when symlinks such
 * as /tmp→/private/tmp were collapsed by the canonicalizer).
 */
function candidateSpellings(
  canonicalPath: string,
  alternates?: (canonicalPath: string) => string[],
): string[] {
  const candidates = [canonicalPath];
  const resolved = path.resolve(canonicalPath);
  if (resolved !== canonicalPath) candidates.push(resolved);
  if (alternates) {
    for (const alternate of alternates(canonicalPath)) {
      if (alternate && !candidates.includes(alternate)) candidates.push(alternate);
    }
  }
  return candidates;
}

export function createWorkspaceDirNameResolver(options: {
  /** Stable cache namespace (usually SESSIONS_DIR). */
  sessionsDirKey: string;
  /** Current directory-name inventory under the sessions root. */
  listDirNames(): string[];
  /**
   * Bounded header sampling for one project directory: return the majority
   * recorded cwd (or null when nothing readable). Only consulted for
   * directories the encoding formula did not claim.
   */
  sampleProjectPath(dirName: string): Promise<string | null>;
  /**
   * Alternative absolute spellings whose encodings may exist on disk — e.g.
   * de-canonicalized symlink ancestors (/private/tmp → /tmp). Pi encodes
   * path.resolve(cwd), so a canonicalized registry path can drift from the
   * directory name Pi actually created.
   */
  alternateSpellings?(canonicalPath: string): string[];
}): WorkspaceDirNameResolver {
  const { sessionsDirKey, listDirNames, sampleProjectPath, alternateSpellings } = options;

  async function dirNamesForPath(canonicalPath: string): Promise<string[]> {
    let entry = cacheStore.get(sessionsDirKey);
    const names = listDirNames();
    const signature = [...names].sort((a, b) => a.localeCompare(b)).join("\u0000");
    if (!entry || entry.signature !== signature) {
      entry = { signature, sampled: false, byPath: new Map() };
      cacheStore.set(sessionsDirKey, entry);
    }

    // 1) Deterministic and instant: Pi's own encoding, tried for every
    //    spelling of the canonical path.
    const encodedMatches = new Set<string>();
    const spellings = candidateSpellings(canonicalPath, alternateSpellings);
    for (const candidate of spellings) {
      const encoded = encodeSessionDirName(candidate);
      if (names.includes(encoded)) encodedMatches.add(encoded);
    }

    const backfill = (): Promise<void> => {
      entry.pending ??= (async () => {
        const resolutions = await Promise.all(
          names.map(async (dirName) => ({
            dirName,
            resolved: (await sampleProjectPath(dirName)) ?? decodeLossyDirName(dirName),
          })),
        );
        for (const { dirName, resolved } of resolutions) {
          const bucket = entry.byPath.get(resolved);
          if (bucket) {
            bucket.push(dirName);
          } else {
            entry.byPath.set(resolved, [dirName]);
          }
        }
        entry.sampled = true;
      })();
      return entry.pending;
    };

    if (encodedMatches.size > 0) {
      // Fast path answered; refresh the sample map in the background so
      // pre-formula/renamed buckets show up without blocking this call.
      if (!entry.sampled && !entry.pending) void backfill();
      const matches = new Set(encodedMatches);
      // Once sampling has landed, fold in the background-discovered buckets
      // (pre-formula/renamed directories) alongside the encoded matches.
      if (entry.sampled) {
        for (const candidate of spellings) {
          for (const dirName of entry.byPath.get(candidate) ?? []) {
            matches.add(dirName);
          }
        }
      }
      return [...matches].sort((a, b) => a.localeCompare(b));
    }

    // 2) Fallback for pre-formula/renamed directories: wait for the sample
    //    map (built once per directory-set signature).
    await backfill();
    const matches = new Set<string>();
    for (const candidate of spellings) {
      for (const dirName of entry.byPath.get(candidate) ?? []) {
        matches.add(dirName);
      }
    }
    return [...matches].sort((a, b) => a.localeCompare(b));
  }

  return { dirNamesForPath };
}
