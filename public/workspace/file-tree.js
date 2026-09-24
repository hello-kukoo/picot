// ABOUTME: Pure model for the Files panel tree — keys, flattening, and the
// ABOUTME: persisted-expansion rules. No DOM, no storage, no host calls.

import { relativeLocalPath } from "./path-utils.js";

/**
 * The workspace root, spelled the way the host spells it. `list_files`,
 * `file_create`'s `parentPath` and this module all agree that `.` is the root,
 * so a relative path never has to be special-cased at a call boundary.
 */
export const ROOT_PATH = ".";

/**
 * Deepest directory level that survives a restart. Counted from the root: the
 * root is depth 0, a direct child is depth 1. Writing and restoring share this
 * one limit, so a directory is never stored that could not come back.
 */
export const MAX_RESTORED_DEPTH = 5;

/** Dotfiles and dot-directories. The Files panel hides these until asked. */
export function isHiddenEntryName(name) {
  return typeof name === "string" && name.startsWith(".");
}

/** Fold a relative path to its canonical `a/b` form, or `""` when unusable. */
export function normalizeRelativePath(value) {
  if (typeof value !== "string") return "";
  const parts = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return "";
  return parts.join("/");
}

/** Depth from the root: `.` is 0, `src` is 1, `src/ui` is 2. */
export function depthOf(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return 0;
  return normalized.split("/").length;
}

/** Parent directory of a relative path, or `null` for the root itself. */
export function parentOf(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return null;
  const index = normalized.lastIndexOf("/");
  return index === -1 ? ROOT_PATH : normalized.slice(0, index);
}

/** True when `path` is `ancestor` itself or lives underneath it. */
export function isWithinPath(path, ancestor) {
  if (ancestor === ROOT_PATH) return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Keep only what may be restored: deduplicated, root-free (the root is always
 * expanded), and no deeper than `maxDepth`. Trimming on write is what makes the
 * stored set and the restored set the same set — otherwise a deep expansion is
 * written and silently dropped on the way back.
 */
export function trimExpandedForStorage(paths, maxDepth = MAX_RESTORED_DEPTH) {
  const kept = new Set();
  for (const path of paths ?? []) {
    const normalized = normalizeRelativePath(path);
    if (!normalized) continue;
    if (depthOf(normalized) > maxDepth) continue;
    kept.add(normalized);
  }
  return [...kept].sort();
}

/**
 * Read a persisted expansion list. Anything unparseable or misshapen yields an
 * empty list: this value lives in localStorage, so it is input, not state.
 */
export function parseExpandedStorage(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return trimExpandedForStorage(parsed);
}

/**
 * Normalize a `list_files` reply into tree entries. The native data plane
 * answers with `{ entries: [{ name, relativePath, kind }] }`; the older
 * `{ items: [{ name, path, isDirectory }] }` shape is still accepted so a
 * non-native consumer cannot turn a valid reply into an empty tree.
 */
export function normalizeListingEntries(data, workspaceRoot = "") {
  let raw = [];
  if (Array.isArray(data?.entries)) raw = data.entries;
  else if (Array.isArray(data?.items)) raw = data.items;
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry.name !== "string") continue;
    const relative =
      typeof entry.relativePath === "string"
        ? normalizeRelativePath(entry.relativePath)
        : relativeLocalPath(entry.path, workspaceRoot);
    if (!relative) continue;
    const isDirectory =
      typeof entry.kind === "string" ? entry.kind === "directory" : Boolean(entry.isDirectory);
    entries.push({ name: entry.name, path: relative, isDirectory });
  }
  return entries;
}

/**
 * Flatten the loaded listings into preorder rows.
 *
 * The host already sorts directories first then by name, so this never
 * re-sorts: the tree shows the order the filesystem listing reported. A row's
 * `loading` flag is derived, not stored — an expanded directory with no listing
 * yet is exactly a directory that is being fetched.
 */
export function flattenFileTree(directoryListings, expandedPaths, showHidden = false) {
  const rows = [];
  const walk = (path, depth) => {
    const listing = directoryListings.get(path);
    if (!listing) return;
    for (const entry of listing.entries) {
      if (!showHidden && isHiddenEntryName(entry.name)) continue;
      const childListing = entry.isDirectory ? directoryListings.get(entry.path) : undefined;
      const expanded = entry.isDirectory && expandedPaths.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded,
        loading: expanded && childListing === undefined,
        failed: Boolean(childListing?.failed),
        transient: Boolean(childListing?.transient),
      });
      if (expanded) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_PATH, 0);
  return rows;
}
