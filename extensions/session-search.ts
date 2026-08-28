import * as path from "node:path";

type SearchMatch = {
  role: string;
  snippet: string;
};

export function projectSearchText(workspacePath: string): string {
  const trimmed = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!trimmed) return "";
  return [path.basename(trimmed), trimmed].join(" ").toLowerCase();
}

export function buildProjectSearchMatch(query: string, workspacePath: string): SearchMatch | null {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q || !projectSearchText(workspacePath).includes(q)) return null;

  const projectName = path.basename(workspacePath) || workspacePath;
  return {
    role: "project",
    snippet: `Project: ${projectName}`,
  };
}

/** Parser result for the registry-scoped `paths` search parameter. */
export type SearchScopeResult =
  | { error: string; paths: null }
  | { error: null; paths: string[] | null };

export const SEARCH_SCOPE_MAX_PATHS = 100;
export const SEARCH_SCOPE_MAX_PATH_LENGTH = 4096;

/**
 * Parse the optional `paths` query parameter of /api/search.
 *
 * - absent → global scan (transitional default), `paths: null`
 * - "[]"   → scoped to nothing, `paths: []` (caller returns empty results)
 * - valid JSON array of non-empty strings ≤ caps → `paths: [..]`
 *
 * Any malformed input yields a stable machine-readable rejection so both the
 * Node and Bun adapters answer identically. This scope is a product-surface
 * filter, never an authorization boundary.
 */
export function parseSearchScopePaths(raw: string | null | undefined): SearchScopeResult {
  if (raw === null || raw === undefined || raw === "") {
    return { error: null, paths: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "paths must be a JSON string array", paths: null };
  }
  if (!Array.isArray(parsed)) {
    return { error: "paths must be a JSON string array", paths: null };
  }
  if (parsed.length > SEARCH_SCOPE_MAX_PATHS) {
    return { error: `too many paths; max ${SEARCH_SCOPE_MAX_PATHS}`, paths: null };
  }
  const paths: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || item.trim() === "") {
      return { error: "paths must be a JSON string array", paths: null };
    }
    // Measured in UTF-8 bytes to honor the documented 4 KiB byte budget.
    if (Buffer.byteLength(item, "utf8") > SEARCH_SCOPE_MAX_PATH_LENGTH) {
      return { error: `path too long; max ${SEARCH_SCOPE_MAX_PATH_LENGTH}`, paths: null };
    }
    paths.push(item);
  }
  return { error: null, paths };
}
