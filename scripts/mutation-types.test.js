// ABOUTME: Locks shared mutation command manifest against current browser and Rust validation lists.
// ABOUTME: Prevents Foundation changes from altering production mutation classification implicitly.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("shared/mutation-types.json", "utf8"));
const browser = readFileSync("public/native/runtime-gateway.js", "utf8");
const router = readFileSync("src-tauri/src/host_router.rs", "utf8");
const manager = readFileSync("src-tauri/src/native_pi_manager.rs", "utf8");

function listed(source) {
  const block = source.match(/const MUTATION_TYPES = new Set\(\[(.*?)\]\);/s);
  if (!block) throw new Error("MUTATION_TYPES list not found");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("shared mutation types", () => {
  it("contains exactly 14 unique command names", () => {
    expect(manifest).toHaveLength(14);
    expect(new Set(manifest).size).toBe(14);
  });

  it("matches browser and both Rust production lists", () => {
    const expected = [...manifest].sort();
    expect(listed(browser).sort()).toEqual(expected);
    expect(router).toContain("use crate::mutation_types::is_mutation;");
    expect(manager).toContain("use crate::mutation_types::is_mutation;");
    expect(router).not.toMatch(/fn is_mutation\s*\(/);
    expect(manager).not.toMatch(/fn is_mutation\s*\(/);
  });
});
