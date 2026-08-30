#!/usr/bin/env node
// ABOUTME: Runs P3 rollback component checks against local Rust and embedded-Pi implementations.
// ABOUTME: Records exact command outcomes; missing release-artifact evidence stays explicitly blocked.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cargoManifest = resolve(root, "src-tauri/Cargo.toml");
const evidencePath = resolve(root, "docs/superpowers/specs/2026-08-30-p3-rollback-evidence.md");

const checks = [
  {
    id: "flag-off-on",
    scenario: "rollout flag off/on and authorization boundary",
    args: ["test", "runtime_preference", "--manifest-path", cargoManifest, "--", "--nocapture"],
  },
  {
    id: "running-child-cleanup",
    scenario: "real embedded-Pi child cleanup after RPC round trip",
    args: [
      "test",
      "native_smoke_quick_chat",
      "--manifest-path",
      cargoManifest,
      "--",
      "--ignored",
      "--nocapture",
    ],
  },
  {
    id: "ordered-cleanup",
    scenario: "ordered, idempotent cleanup and stale identity rejection",
    args: [
      "test",
      "stop_is_ordered_idempotent_and_rejects_stale_identity",
      "--manifest-path",
      cargoManifest,
      "--",
      "--nocapture",
    ],
  },
  {
    id: "static-cache-invalidation",
    scenario: "content-fingerprinted static path and cache-control policy",
    args: [
      "test",
      "serves_static_assets_under_a_content_fingerprinted_path",
      "--manifest-path",
      cargoManifest,
      "--",
      "--nocapture",
    ],
  },
  {
    id: "db-integrity",
    scenario: "SQLite corruption quarantine/recreate and valid reopen",
    args: [
      "test",
      "metadata_store::tests::corrupt_database_is_quarantined_and_recreated",
      "--manifest-path",
      cargoManifest,
      "--",
      "--nocapture",
    ],
  },
  {
    id: "db-valid-reopen",
    scenario: "SQLite valid database remains unquarantined",
    args: [
      "test",
      "metadata_store::tests::fresh_and_valid_reopens_create_no_quarantine_files",
      "--manifest-path",
      cargoManifest,
      "--",
      "--nocapture",
    ],
  },
];

if (process.argv.includes("--check")) {
  if (checks.length !== 6 || checks.some((check) => !check.id || !check.scenario)) {
    throw new Error("P3 rollback rehearsal matrix is incomplete");
  }
  process.stdout.write(`validated ${checks.length} rollback component checks\n`);
  process.exit(0);
}

function runCheck(check) {
  const startedAt = Date.now();
  const result = spawnSync("cargo", check.args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    ...check,
    command: `cargo ${check.args.join(" ")}`,
    passed: result.status === 0,
    exit: result.status ?? `signal:${result.signal ?? "unknown"}`,
    durationMs: Date.now() - startedAt,
    outputTail: output.split("\n").filter(Boolean).slice(-12),
  };
}

const results = checks.map((check) => {
  process.stdout.write(`▶ ${check.id}: ${check.scenario}\n`);
  const result = runCheck(check);
  process.stdout.write(`  ${result.passed ? "✓ pass" : "✗ FAIL"} (${result.durationMs}ms)\n`);
  if (!result.passed) {
    for (const line of result.outputTail) process.stdout.write(`    ${line}\n`);
  }
  return result;
});

const failures = results.filter((result) => !result.passed);
const report = [
  "# P3 rollback rehearsal evidence",
  "",
  `- Run time: ${new Date().toISOString()}`,
  "- Harness: `scripts/rollback-rehearsal-p3.mjs`",
  "- Scope: local component rehearsal only; no release artifact, N-1 binary, or user DB is mutated.",
  `- Component result: **${failures.length ? "FAIL" : "PASS"}** (${results.length - failures.length}/${results.length})`,
  "",
  "## Executed checks",
  "",
  "| ID | Scenario | Result | Duration | Exit |",
  "| --- | --- | --- | ---: | --- |",
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.scenario} | ${result.passed ? "✅ pass" : "❌ fail"} | ${result.durationMs}ms | ${result.exit} |`,
  ),
  "",
  "## Raw command tails",
  "",
  ...results.flatMap((result) => [
    `### ${result.id}`,
    "",
    `Command: \`${result.command}\``,
    "",
    "```text",
    ...(result.outputTail.length ? result.outputTail : ["(no output)"]),
    "```",
    "",
  ]),
  "## Rollback boundary",
  "",
  "- Flag off/on: exercised through protected `runtime_preference` tests; invalid or unauthorized preference access must fail closed.",
  "- Running child cleanup: exercised through real embedded Pi quick-chat lifecycle plus ordered in-memory cleanup contract.",
  "- Static cache invalidation: exercised through content fingerprint path and no-store cache headers in HostServer test.",
  "- DB integrity: exercised through SQLite corruption quarantine/recreate and valid reopen tests; original corrupt bytes remain retained by component contract.",
  "",
  "## Blockers",
  "",
  "- **Real N-1 → N → N-1 release rollback remains unexecuted.** This harness does not download, install, downgrade, or launch a versioned release artifact.",
  "- **Platform coverage remains unexecuted.** Results below are only for current host; Windows/macOS packaged-artifact evidence requires authorized release runs.",
  ...(failures.length
    ? [
        `- Component failures require investigation: ${failures.map((result) => result.id).join(", ")}.`,
      ]
    : ["- No component failure observed in this run."]),
  "",
  "Gate R/P3 rollback exit: **BLOCKED** until authorized release-artifact rehearsal records version-matched restore, child disposition, cache behavior, DB/session preservation, hashes, and user remediation.",
  "",
].join("\n");

mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, report);
process.stdout.write(`evidence → ${evidencePath.replace(root, ".")}\n`);
process.exitCode = failures.length ? 1 : 0;
