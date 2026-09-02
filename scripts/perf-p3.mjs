// ABOUTME: Runs deterministic P3 native performance sampling against one real embedded-Pi fixture.
// ABOUTME: Reports measured host-origin snapshot and prompt-to-first-event percentiles; never fabricates legacy data.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const samples = Number(process.env.PICOT_P3_PERF_SAMPLES ?? 20);
const warmup = Number(process.env.PICOT_P3_PERF_WARMUP ?? 3);
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmup) || warmup < 0) {
  throw new Error(
    "PICOT_P3_PERF_SAMPLES must be a positive integer; warmup must be a non-negative integer",
  );
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}

const temp = mkdtempSync(join(tmpdir(), "picot-p3-perf-"));
const rawPath = join(temp, "native.json");
const result = spawnSync(
  "cargo",
  [
    "test",
    "native_smoke_host_origin_p3",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--",
    "--ignored",
    "--nocapture",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PICOT_P3_PERF_OUTPUT: rawPath,
      PICOT_P3_PERF_SAMPLES: String(samples),
      PICOT_P3_PERF_WARMUP: String(warmup),
    },
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0) {
  process.stdout.write(output);
  rmSync(temp, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

let native;
try {
  native = JSON.parse(readFileSync(rawPath, "utf8"));
} catch (error) {
  rmSync(temp, { recursive: true, force: true });
  throw new Error(`Native performance output is invalid: ${error.message}`, { cause: error });
}
const summary = {
  generatedAt: new Date().toISOString(),
  command: `cargo test native_smoke_host_origin_p3 --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture`,
  os: `${process.platform} ${process.arch}`,
  osVersion: execFileSync(
    process.platform === "win32" ? "cmd.exe" : "uname",
    process.platform === "win32" ? ["/d", "/s", "/c", "ver"] : ["-sr"],
    { encoding: "utf8" },
  ).trim(),
  bun: Bun.version,
  samples: native.samples,
  warmup: native.warmup,
  percentileAlgorithm: "nearest-rank (ceil(p*n)-1), sorted elapsed milliseconds",
  fixture:
    "one temporary registered workspace, one primary native runtime, one session, real embedded Pi",
  native: {
    hostOriginSnapshot: {
      p50Ms: percentile(native.snapshotMs, 50),
      p95Ms: percentile(native.snapshotMs, 95),
      valuesMs: native.snapshotMs,
    },
    promptToFirstEvent: {
      p50Ms: percentile(native.promptToFirstEventMs, 50),
      p95Ms: percentile(native.promptToFirstEventMs, 95),
      valuesMs: native.promptToFirstEventMs,
    },
    shellMs: native.shellMs,
    bootstrapMs: native.bootstrapMs,
  },
  comparison: {
    status: "not-run",
    note: "This harness records native host-origin timings only; no legacy transport comparison is generated.",
  },
};
const evidencePath = resolve(root, "docs/superpowers/specs/2026-08-30-p3-perf-evidence.md");
writeFileSync(
  evidencePath,
  `# P3 performance evidence\n\nReal measurements only. Legacy comparison is recorded only when an equivalent runner exists.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
);
rmSync(temp, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`evidence → ${evidencePath.replace(root, ".")}\n`);
