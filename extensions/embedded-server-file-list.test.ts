// ABOUTME: Verifies File Browser filtering for normal and show-hidden directory listings.
// ABOUTME: Ensures the showHidden query contract disables every existing list exclusion.
import { describe, expect, test } from "vitest";
import { filterFileListEntries } from "./embedded-server.ts";

const entries: Array<{ name: string }> = [
  { name: "README.md" },
  { name: ".env" },
  { name: ".git" },
  { name: ".tool-versions" },
  { name: "node_modules" },
  { name: "dist" },
];

describe("filterFileListEntries", () => {
  test("keeps .env but hides other dotfiles and ignored names by default", () => {
    expect(filterFileListEntries(entries, false).map((entry) => entry.name)).toEqual([
      "README.md",
      ".env",
    ]);
  });

  test("returns every entry when showHidden is enabled", () => {
    expect(filterFileListEntries(entries, true)).toEqual(entries);
  });
});
