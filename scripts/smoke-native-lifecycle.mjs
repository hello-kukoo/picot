// ABOUTME: P1.11 real-Pi lifecycle smoke across native runtime types.
// ABOUTME: Runs the #[ignore] cargo smoke tests and writes evidence to docs.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const allTypes = ["primary", "dedicated", "side_chat", "quick_chat", "standby"];
const only = process.argv[2];
const types = only ? allTypes.filter((type) => type === only) : allTypes;
if (types.length === 0) {
  console.error(`unknown runtime type: ${only} (expected one of ${allTypes.join(", ")})`);
  process.exit(2);
}

const results = [];
for (const type of types) {
  const test = `native_smoke_${type}`;
  process.stdout.write(`▶ ${test}\n`);
  const startedAt = Date.now();
  const run = spawnSync(
    "cargo",
    // libtest-level --ignored: the cargo-level flag was removed in newer
    // cargo releases, while the libtest flag works across versions.
    ["test", test, "--", "--ignored", "--nocapture"],
    {
      cwd: resolve(root, "src-tauri"),
      encoding: "utf8",
      env: process.env,
    },
  );
  const ok = run.status === 0;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const tail = output.split("\n").filter(Boolean).slice(-4);
  results.push({ type, ok, durationMs: Date.now() - startedAt, tail });
  process.stdout.write(`  ${ok ? "✓ pass" : "✗ FAIL"} (${results.at(-1).durationMs}ms)\n`);
  if (!ok) {
    for (const line of tail) process.stdout.write(`    ${line}\n`);
  }
}

const failed = results.filter((result) => !result.ok);
const stamp = new Date().toISOString();
const table = results
  .map(
    (result) =>
      `| ${result.type} | ${result.ok ? "✅ pass" : "❌ fail"} | ${result.durationMs}ms |`,
  )
  .join("\n");
const evidence = [
  "# P1.11 真 Pi 生命周期 smoke 证据",
  "",
  `- 运行时间：${stamp}`,
  "- 命令：`bun run scripts/smoke-native-lifecycle.mjs`（逐类执行 `cargo test --ignored native_smoke_<type>`）",
  "- 被测路径：`pi_launch::native_launch_spec_for` → `NativePiManager::spawn`（真 embedded Pi + picot-bridge.mjs）→ 事件泵首帧 → `get_state` RPC 往返 → `stop` → Stopped",
  "",
  "| runtime type | 结果 | 耗时 |",
  "| --- | --- | --- |",
  table,
  "",
  failed.length === 0
    ? "- 结论：五类全部通过。"
    : `- 结论：${failed.length} 类失败：${failed.map((r) => r.type).join(", ")}`,
  "",
].join("\n");
const evidencePath = resolve(root, "docs/superpowers/specs/2026-08-29-p111-smoke-evidence.md");
writeFileSync(evidencePath, evidence);
process.stdout.write(`\nevidence → ${evidencePath.replace(root, ".")}\n`);

process.exit(failed.length === 0 ? 0 : 1);
