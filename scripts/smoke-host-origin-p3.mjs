// ABOUTME: Runs real host-origin P3 smoke against native Rust HostServer and embedded Pi.
// ABOUTME: Exercises shell, bootstrap, v2 WebSocket hello, subscription, state RPC, and route isolation.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const test = "native_smoke_host_origin_p3";
process.stdout.write(`▶ ${test} (real HostServer + embedded Pi)\n`);
const startedAt = Date.now();
const result = spawnSync("cargo", ["test", test, "--", "--ignored", "--nocapture"], {
  cwd: resolve(root, "src-tauri"),
  encoding: "utf8",
  env: process.env,
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
const durationMs = Date.now() - startedAt;
const passed = result.status === 0;
const stamp = new Date().toISOString();
const evidencePath = resolve(
  root,
  "docs/superpowers/specs/2026-08-30-p3-host-origin-smoke-evidence.md",
);
const evidence = [
  "# P3 host-origin runtime smoke evidence",
  "",
  `- Run time: ${stamp}`,
  `- Command: \`bun run smoke:host-origin-p3\` → \`cargo test ${test} -- --ignored --nocapture\``,
  `- Result: ${passed ? "✅ pass" : "❌ fail"} (${durationMs}ms; exit=${result.status ?? "signal"})`,
  "- Runtime: real Rust `HostServer` + real embedded Pi resolved by `native_launch_spec_for`.",
  "",
  "## Command output",
  "",
  "```text",
  output.trimEnd(),
  "```",
  "",
  "## Covered path",
  "",
  "1. Create registered workspace owner/capability through `WindowOwnerRegistry`.",
  "2. Spawn native primary runtime with embedded Pi and bind `RuntimeTarget` to workspace/session.",
  "3. Fetch `/workspaces/:workspaceId/sessions/:sessionId`; assert shell success and `<base href=`.",
  "4. Fetch `/v2/bootstrap` with desktop capability; assert returned target matches registered runtime.",
  "5. Assert `/ws` is absent, wrong-workspace bootstrap is `403`, missing capability is `401`.",
  "6. Connect `/v2/ws`; send protocol v2 `hello` with desktop capability; assert `hello_ack`.",
  "7. Subscribe target; assert `runtime_subscribed`.",
  "8. Send read-only `runtime_snapshot_request` (`get_state`/messages/stats through real bridge); assert `runtime_snapshot`.",
  "9. Send real `runtime_request` prompt; assert accepted response plus runtime event/turn identity.",
  "10. Send turn-bound abort through same host path; assert exact turn is not treated as stale.",
  "11. Close/reconnect WebSocket, re-hello, re-subscribe, request authoritative snapshot; assert sequence watermark is retained.",
  "12. Stop real runtime and host; remove temporary workspace.",
  "",
  passed
    ? "## Conclusion\n\nReal host-origin P3 smoke passed."
    : `## Failure\n\nSmoke failed. Inspect cargo output above; exit=${result.status ?? "signal"}.`,
  "",
].join("\n");
writeFileSync(evidencePath, evidence);
process.stdout.write(`evidence → ${evidencePath.replace(root, ".")}\n`);
if (passed) {
  process.stdout.write(`✓ ${test} PASS (${durationMs}ms)\n`);
} else {
  process.stderr.write(`✗ ${test} FAIL (${durationMs}ms, exit=${result.status ?? "signal"})\n`);
}
process.exit(result.status ?? 1);
