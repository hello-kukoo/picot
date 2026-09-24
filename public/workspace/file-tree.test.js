// ABOUTME: Verifies the pure Files-panel tree model: path keys, preorder
// ABOUTME: flattening, hidden filtering, and the persisted-expansion rules.
import { describe, expect, it } from "vitest";
import {
  depthOf,
  flattenFileTree,
  isHiddenEntryName,
  isWithinPath,
  MAX_RESTORED_DEPTH,
  normalizeListingEntries,
  normalizeRelativePath,
  parentOf,
  parseExpandedStorage,
  ROOT_PATH,
  trimExpandedForStorage,
} from "./file-tree.js";

function dir(name, parent = "") {
  return { name, path: parent ? `${parent}/${name}` : name, isDirectory: true };
}

function file(name, parent = "") {
  return { name, path: parent ? `${parent}/${name}` : name, isDirectory: false };
}

function listings(entriesByPath) {
  const map = new Map();
  for (const [path, entries] of Object.entries(entriesByPath)) {
    map.set(path, { entries, loadedAtMs: 1, failed: false, transient: false });
  }
  return map;
}

describe("relative path keys", () => {
  it("folds separators, dots, and traversal", () => {
    expect(normalizeRelativePath("./src//ui/")).toBe("src/ui");
    expect(normalizeRelativePath("src\\ui")).toBe("src/ui");
    expect(normalizeRelativePath("..")).toBe("");
    expect(normalizeRelativePath("src/../../escape")).toBe("");
    expect(normalizeRelativePath(null)).toBe("");
  });

  it("counts depth from the root", () => {
    expect(depthOf(ROOT_PATH)).toBe(0);
    expect(depthOf("src")).toBe(1);
    expect(depthOf("src/ui/panel")).toBe(3);
  });

  it("resolves parents, with the root as the floor", () => {
    expect(parentOf("src")).toBe(ROOT_PATH);
    expect(parentOf("src/ui")).toBe("src");
    expect(parentOf(ROOT_PATH)).toBe(null);
  });

  it("treats the root as an ancestor of everything", () => {
    expect(isWithinPath("src", ROOT_PATH)).toBe(true);
    expect(isWithinPath("src/ui", "src")).toBe(true);
    expect(isWithinPath("src/ui", "src/ui")).toBe(true);
    expect(isWithinPath("src-other", "src")).toBe(false);
  });
});

describe("hidden entries", () => {
  it("recognizes dotfiles and dot-directories", () => {
    expect(isHiddenEntryName(".git")).toBe(true);
    expect(isHiddenEntryName(".env")).toBe(true);
    expect(isHiddenEntryName("git")).toBe(false);
    expect(isHiddenEntryName(undefined)).toBe(false);
  });
});

describe("normalizeListingEntries", () => {
  it("reads the native data-plane shape", () => {
    expect(
      normalizeListingEntries({
        entries: [
          { name: "src", relativePath: "src", kind: "directory" },
          { name: "a.ts", relativePath: "a.ts", kind: "file" },
        ],
      }),
    ).toEqual([
      { name: "src", path: "src", isDirectory: true },
      { name: "a.ts", path: "a.ts", isDirectory: false },
    ]);
  });

  it("still reads the older absolute-path shape", () => {
    expect(
      normalizeListingEntries(
        { items: [{ name: "a.ts", path: "/work/app/a.ts", isDirectory: false }] },
        "/work/app",
      ),
    ).toEqual([{ name: "a.ts", path: "a.ts", isDirectory: false }]);
  });

  it("drops entries with no usable name or path", () => {
    expect(
      normalizeListingEntries({
        entries: [{ name: "ok.ts", relativePath: "ok.ts", kind: "file" }, { relativePath: "x" }],
      }),
    ).toHaveLength(1);
    expect(normalizeListingEntries({})).toEqual([]);
  });
});

describe("flattenFileTree", () => {
  const tree = () =>
    listings({
      [ROOT_PATH]: [dir("src"), dir("docs"), file("README.md")],
      src: [dir("ui", "src"), file("main.ts", "src")],
      "src/ui": [file("panel.ts", "src/ui")],
    });

  it("walks preorder with the listing's own order", () => {
    const rows = flattenFileTree(tree(), new Set(["src", "src/ui"]));
    expect(rows.map((row) => `${row.depth}:${row.entry.path}`)).toEqual([
      "0:src",
      "1:src/ui",
      "2:src/ui/panel.ts",
      "1:src/main.ts",
      "0:docs",
      "0:README.md",
    ]);
  });

  it("marks expansion and hides the children of a collapsed directory", () => {
    const rows = flattenFileTree(tree(), new Set());
    expect(rows.map((row) => row.entry.path)).toEqual(["src", "docs", "README.md"]);
    expect(rows[0].expanded).toBe(false);
    expect(rows[0].loading).toBe(false);
  });

  it("reports an expanded directory with no listing as loading", () => {
    const map = listings({ [ROOT_PATH]: [dir("src")] });
    const rows = flattenFileTree(map, new Set(["src"]));
    expect(rows[0].expanded).toBe(true);
    expect(rows[0].loading).toBe(true);
  });

  it("reports a failed listing on the row instead of loading forever", () => {
    const map = listings({ [ROOT_PATH]: [dir("src")] });
    map.set("src", { entries: [], loadedAtMs: 0, failed: true, transient: true });
    const rows = flattenFileTree(map, new Set(["src"]));
    expect(rows[0].loading).toBe(false);
    expect(rows[0].failed).toBe(true);
    expect(rows[0].transient).toBe(true);
  });

  it("filters hidden entries only when asked", () => {
    const map = listings({ [ROOT_PATH]: [dir(".git"), dir("src"), file(".env")] });
    expect(flattenFileTree(map, new Set()).map((row) => row.entry.name)).toEqual(["src"]);
    expect(flattenFileTree(map, new Set(), true).map((row) => row.entry.name)).toEqual([
      ".git",
      "src",
      ".env",
    ]);
  });

  it("never descends into a collapsed hidden directory", () => {
    const map = listings({ [ROOT_PATH]: [dir(".git")], ".git": [file("config")] });
    expect(flattenFileTree(map, new Set([".git"]), false)).toEqual([]);
  });

  it("returns nothing before the root listing arrives", () => {
    expect(flattenFileTree(new Map(), new Set())).toEqual([]);
  });
});

describe("trimExpandedForStorage", () => {
  it("deduplicates, sorts, and keeps the root out", () => {
    expect(trimExpandedForStorage(["src", "src", ROOT_PATH, "./docs"])).toEqual(["docs", "src"]);
  });

  it("drops anything deeper than the restore limit", () => {
    const atLimit = Array.from({ length: MAX_RESTORED_DEPTH }, (_, i) => `d${i}`).join("/");
    const pastLimit = `${atLimit}/deep`;
    expect(depthOf(atLimit)).toBe(MAX_RESTORED_DEPTH);
    expect(trimExpandedForStorage([atLimit, pastLimit])).toEqual([atLimit]);
  });

  it("ignores unusable values", () => {
    expect(trimExpandedForStorage([null, 7, "", "../escape", "ok"])).toEqual(["ok"]);
    expect(trimExpandedForStorage(undefined)).toEqual([]);
  });
});

describe("parseExpandedStorage", () => {
  it("reads a stored list", () => {
    expect(parseExpandedStorage('["src","src/ui"]')).toEqual(["src", "src/ui"]);
  });

  it("treats anything unparseable as empty rather than throwing", () => {
    expect(parseExpandedStorage("{not json")).toEqual([]);
    expect(parseExpandedStorage('{"src":true}')).toEqual([]);
    expect(parseExpandedStorage("")).toEqual([]);
    expect(parseExpandedStorage(null)).toEqual([]);
  });

  it("applies the same depth trim on read as on write", () => {
    const deep = "a/b/c/d/e/f";
    expect(parseExpandedStorage(JSON.stringify(["src", deep]))).toEqual(["src"]);
  });
});
