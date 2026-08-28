// @vitest-environment node

import { describe, expect, it, test } from "vitest";
import {
  buildProjectSearchMatch,
  parseSearchScopePaths,
  projectSearchText,
  SEARCH_SCOPE_MAX_PATH_LENGTH,
  SEARCH_SCOPE_MAX_PATHS,
} from "./session-search.ts";

describe("session search project matching", () => {
  it("matches project name from a workspace path", () => {
    expect(projectSearchText("/Users/me/work/alpha-dashboard")).toContain("alpha-dashboard");
    expect(buildProjectSearchMatch("alpha-dashboard", "/Users/me/work/alpha-dashboard")).toEqual({
      role: "project",
      snippet: "Project: alpha-dashboard",
    });
  });

  it("does not match unrelated project names", () => {
    expect(buildProjectSearchMatch("billing", "/Users/me/work/alpha-dashboard")).toBeNull();
  });
});

describe("search scope paths parsing", () => {
  test("absent parameter keeps transitional global scanning", () => {
    expect(parseSearchScopePaths(null)).toEqual({ error: null, paths: null });
    expect(parseSearchScopePaths(undefined)).toEqual({ error: null, paths: null });
    expect(parseSearchScopePaths("")).toEqual({ error: null, paths: null });
  });

  test("empty array scopes to nothing so callers answer empty results", () => {
    expect(parseSearchScopePaths("[]")).toEqual({ error: null, paths: [] });
  });

  test("valid JSON string arrays pass through", () => {
    expect(parseSearchScopePaths(JSON.stringify(["/a/b", "/c/d"]))).toEqual({
      error: null,
      paths: ["/a/b", "/c/d"],
    });
  });

  test("malformed payloads reject with stable errors", () => {
    const notJson = parseSearchScopePaths("{nope");
    expect(notJson.error).toBe("paths must be a JSON string array");
    const notArray = parseSearchScopePaths('"/a"');
    expect(notArray.error).toBe("paths must be a JSON string array");
    const notStrings = parseSearchScopePaths(JSON.stringify(["/ok", 7]));
    expect(notStrings.error).toBe("paths must be a JSON string array");
    const emptyString = parseSearchScopePaths(JSON.stringify([""]));
    expect(emptyString.error).toBe("paths must be a JSON string array");
    const blankString = parseSearchScopePaths(JSON.stringify(["   "]));
    expect(blankString.error).toBe("paths must be a JSON string array");
  });

  test("array and item caps produce deterministic rejections", () => {
    const tooMany = parseSearchScopePaths(
      JSON.stringify(Array.from({ length: SEARCH_SCOPE_MAX_PATHS + 1 }, (_, i) => `/${i}`)),
    );
    expect(tooMany.error).toBe(`too many paths; max ${SEARCH_SCOPE_MAX_PATHS}`);

    const tooLong = parseSearchScopePaths(
      JSON.stringify([`/${"x".repeat(SEARCH_SCOPE_MAX_PATH_LENGTH)}`]),
    );
    expect(tooLong.error).toBe(`path too long; max ${SEARCH_SCOPE_MAX_PATH_LENGTH}`);
  });

  test("identical input yields identical output across repeat parses (adapter parity)", () => {
    const input = JSON.stringify(["/only"]);
    expect(parseSearchScopePaths(input)).toEqual(parseSearchScopePaths(input));
  });
});
