// ABOUTME: P4 cost parity harness — legacy TS payload vs native Rust payload on identical JSONL fixtures.
// Usage: bun scripts/p4-cost-parity.mjs <sessionsRoot> <currentRoot> <paramsJson> <nowIso>
// Prints the legacy buildCostDashboardPayload JSON for the fixture tree; the
// Rust test compares it field-by-field against cost_compat::scan_compat_cost_dashboard.

import { createReadStream, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildCostDashboardPayload } from "../extensions/cost-dashboard-data.ts";

const [sessionsRoot, currentRootRaw, paramsJson, nowIso] = process.argv.slice(2);
if (!sessionsRoot || !currentRootRaw || !paramsJson || !nowIso) {
  console.error("usage: p4-cost-parity.mjs <sessionsRoot> <currentRoot> <paramsJson> <nowIso>");
  process.exit(2);
}
const currentRoot = realpathSync(currentRootRaw);
let params;
try {
  params = JSON.parse(paramsJson);
} catch (error) {
  console.error(`invalid paramsJson: ${error.message}`);
  process.exit(2);
}
params.from = new Date(params.from);
params.to = new Date(params.to);
// Legacy serveCostDashboard consumes models as a Set.
params.models = new Set(Array.isArray(params.models) ? params.models : []);

async function parseSessionMetrics(filePath) {
  // Mirrors embedded-server parseSessionMetrics (cost-relevant fields only).
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const data = {
    id: "",
    title: "",
    cwd: "",
    timestamp: null,
    lastActive: null,
    model: "unknown",
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolCostByName: {},
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp);
      if (!Number.isNaN(ts.getTime())) data.lastActive = ts;
    }
    if (entry.type === "session") {
      data.id = entry.id || data.id;
      data.cwd = entry.cwd || data.cwd;
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp);
        if (!Number.isNaN(ts.getTime())) data.timestamp = ts;
      }
      continue;
    }
    if (entry.type === "session_info" && entry.name) {
      data.title = entry.name;
      continue;
    }
    if (entry.type === "model_change" && entry.model) {
      data.model = entry.model;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "user") {
      data.userMessages += 1;
      continue;
    }
    if (msg.role !== "assistant") continue;
    data.assistantMessages += 1;
    if (typeof msg.model === "string" && msg.model) data.model = msg.model;
    const usage = msg.usage || {};
    const cost = Number(usage?.cost?.total || 0);
    data.totalCost += cost;
    data.inputTokens += Number(usage?.input || 0);
    data.outputTokens += Number(usage?.output || 0);
    data.cacheRead += Number(usage?.cacheRead || 0);
    data.cacheWrite += Number(usage?.cacheWrite || 0);
    const toolCalls = Array.isArray(msg.content)
      ? msg.content.filter((b) => b?.type === "toolCall" && typeof b?.name === "string")
      : [];
    data.toolCalls += toolCalls.length;
    if (toolCalls.length > 0 && cost > 0) {
      const perToolCost = cost / toolCalls.length;
      for (const toolCall of toolCalls) {
        data.toolCostByName[toolCall.name] =
          (data.toolCostByName[toolCall.name] || 0) + perToolCost;
      }
    }
  }
  return data;
}

const sessions = [];
for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const projectDir = path.join(sessionsRoot, dir.name);
  for (const file of readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"))) {
    const filePath = path.join(projectDir, file);
    const parsed = await parseSessionMetrics(filePath);
    if (!parsed) continue;
    const sessionCwdResolved = (() => {
      try {
        return parsed.cwd ? realpathSync(parsed.cwd) : "";
      } catch {
        return parsed.cwd ? path.resolve(parsed.cwd) : "";
      }
    })();
    if (params.scope === "current" && sessionCwdResolved && sessionCwdResolved !== currentRoot) {
      continue;
    }
    if (params.models.size > 0 && !params.models.has(parsed.model)) continue;
    const time = parsed.lastActive || parsed.timestamp;
    if (!time || time < params.from || time > params.to) continue;
    sessions.push({
      id: parsed.id,
      title: parsed.title || "Untitled",
      workspace: parsed.cwd || "",
      model: parsed.model || "unknown",
      time: time.toISOString(),
      totalCost: parsed.totalCost,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cacheRead: parsed.cacheRead,
      cacheWrite: parsed.cacheWrite,
      totalTokens: parsed.inputTokens + parsed.outputTokens + parsed.cacheRead,
      toolCalls: parsed.toolCalls,
      userMessages: parsed.userMessages,
      assistantMessages: parsed.assistantMessages,
      costPerUserMessage:
        parsed.userMessages > 0 ? parsed.totalCost / parsed.userMessages : parsed.totalCost,
      toolCostByName: parsed.toolCostByName || {},
    });
  }
}

const payload = buildCostDashboardPayload(sessions, params, new Date(nowIso));
process.stdout.write(JSON.stringify(payload));
