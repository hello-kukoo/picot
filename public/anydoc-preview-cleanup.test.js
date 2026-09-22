// ABOUTME: Cleanup contract — zero MarkItDown occurrences in active code,
// ABOUTME: tests, and locales after the anydoc preview migration (spec 2026-09-17).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(process.cwd(), "public");
const EXT_ROOT = join(process.cwd(), "extensions");

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "vendor" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(js|ts|json)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test("active code, tests, and locales carry zero markitdown references", () => {
  const offenders = [];
  const files = [...collectFiles(ROOT), ...collectFiles(EXT_ROOT)].filter(
    // This test's own filename and wording are exempt from the scan.
    (file) => !file.endsWith("anydoc-preview-cleanup.test.js"),
  );
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/markitdown/i.test(text)) offenders.push(file);
  }
  expect(offenders, `files still referencing MarkItDown: ${offenders.join(", ")}`).toEqual([]);
});
