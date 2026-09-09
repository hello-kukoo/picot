// ABOUTME: Locks the production browser entry to the canonical main application.
// ABOUTME: Prevents retired native entry selection from returning during cleanup.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const bootstrapEntry = readFileSync("public/bootstrap-entry.js", "utf8");

test("always loads the canonical app entry", () => {
  expect(bootstrapEntry).toContain('const entry = "./app.js";');
  expect(bootstrapEntry).not.toContain("./native/app.js");
});
