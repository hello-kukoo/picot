// ABOUTME: Verifies checked-in migration inventory matches current runtime surfaces and callers.
// ABOUTME: Rebuilds inventory in a temporary workspace, then exits nonzero on any drift.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const inventoryPath = join(root, "scripts/gen/inventory.json");
const expected = JSON.parse(await readFile(inventoryPath, "utf8"));
const temp = await mkdtemp(join(tmpdir(), "picot-inventory-"));
try {
  const env = {
    ...process.env,
    MIGRATION_INVENTORY_OUTPUT: join(temp, "inventory.json"),
    MIGRATION_INVENTORY_DOC: join(temp, "inventory.md"),
  };
  const result = Bun.spawnSync(
    [process.execPath, new URL("./migration-inventory.mjs", import.meta.url).pathname],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  const actual = JSON.parse(await readFile(join(temp, "inventory.json"), "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error("Migration inventory drift detected. Run: bun run migration:inventory");
    process.exitCode = 1;
  } else {
    console.log("Migration inventory is up to date.");
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
