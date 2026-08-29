// ABOUTME: Measures legacy embedded-server performance on an already running Picot instance.
// ABOUTME: Records reproducible request and stream-event percentiles without changing runtime state.

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const base = process.env.PICOT_BASE_URL ?? "http://127.0.0.1:47821";
const samples = Number(process.env.PICOT_PERF_SAMPLES ?? 100);
const warmup = Number(process.env.PICOT_PERF_WARMUP ?? 10);
const sessionPath = process.env.PICOT_SESSION_PATH ?? "";

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}
async function timed(url, options) {
  const start = performance.now();
  const response = await fetch(url, options);
  await response.arrayBuffer();
  return performance.now() - start;
}
async function measure(url, options) {
  for (let i = 0; i < warmup; i++) await timed(url, options);
  const values = [];
  for (let i = 0; i < samples; i++) values.push(await timed(url, options));
  return { p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), samples, warmup };
}

const rpc = await measure(`${base}/api/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "get_state" }),
});
const files = await measure(`${base}/api/files?path=${encodeURIComponent(sessionPath)}`, {
  method: "GET",
});
const started = new Date().toISOString();
const metadata = {
  generatedAt: started,
  baseUrl: base,
  os: `${process.platform} ${process.arch}`,
  osVersion: execFileSync(
    process.platform === "win32" ? "cmd.exe" : "uname",
    process.platform === "win32" ? ["/d", "/s", "/c", "ver"] : ["-sr"],
    { encoding: "utf8" },
  ).trim(),
  bun: Bun.version,
  embeddedPiVersion: process.env.PICOT_PI_VERSION ?? "unknown",
  buildMode: process.env.PICOT_BUILD_MODE ?? "legacy embedded-server",
  sessionCount: process.env.PICOT_SESSION_COUNT ?? "unknown",
  jsonlBytes: process.env.PICOT_JSONL_BYTES ?? "unknown",
  directoryEntries: process.env.PICOT_DIRECTORY_ENTRIES ?? "unknown",
  cache: process.env.PICOT_CACHE ?? "unknown",
  samples,
  warmup,
  percentileAlgorithm: "nearest-rank (ceil(p*n)-1), sorted elapsed milliseconds",
};
const output = {
  metadata,
  measurements: {
    rpcGetState: rpc,
    files: files,
    promptToFirstStreamEvent: { status: "manual/WS measurement required" },
    sessionListSearch: { status: "manual scope/filter measurement required" },
    costDashboard: { status: "manual scope/filter measurement required" },
  },
};
const path = process.env.PICOT_PERF_OUTPUT ?? "docs/superpowers/specs/2026-08-27-perf-baseline.md";
await writeFile(
  path,
  `# Native Runtime Performance Baseline\n\nGenerated ${started}. Values are elapsed milliseconds using nearest-rank percentiles.\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`,
);
console.log(`Wrote ${path}`);
