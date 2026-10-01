// ABOUTME: Validates and normalizes pi-subagents async-status-snapshot widget JSON.
// ABOUTME: Pure parsing only — no DOM, no registry state, no timers.

export const MAX_ROWS = 4;
export const SNAPSHOT_STATES = [
  "queued",
  "running",
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
];

const LINE_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const SNAPSHOT_VERSION = 1;
// Picot's own pre-parse limit; the sender also caps serialized JSON at 32 KiB.
const MAX_SERIALIZED_BYTES = 32 * 1024;
const STATE_SET = new Set(SNAPSHOT_STATES);
const ATTENTION_STATE = "needs_attention";

/**
 * Parses one setWidget payload. Returns `{ runs, omittedRuns }` with only
 * displayable roots, or `null` for any shape Picot refuses to render.
 */
export function parseSubagentAsyncLines(lines) {
  if (!Array.isArray(lines) || lines.length !== 1) return null;
  const line = lines[0];
  if (typeof line !== "string" || !line.startsWith(LINE_PREFIX)) return null;
  const json = line.slice(LINE_PREFIX.length);
  if (utf8Bytes(json) > MAX_SERIALIZED_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isSnapshotEnvelope(parsed)) return null;
  return {
    runs: parsed.runs.map(normalizeRun).filter((item) => item !== null),
    omittedRuns: nonNegativeInteger(parsed.omitted?.runs) ?? 0,
  };
}

/** Elapsed task time for one root row, or `null` when it cannot be trusted. */
export function rowElapsedMs(run, nowMs) {
  if (run.startedAt === null) return null;
  let elapsed = null;
  if (run.state === "running") elapsed = nowMs - run.startedAt;
  else if (run.endedAt !== null) elapsed = run.endedAt - run.startedAt;
  else if (run.updatedAt !== null) elapsed = run.updatedAt - run.startedAt;
  return isNonNegativeFinite(elapsed) ? elapsed : null;
}

/** Runtime of the current tool for a running row, or `null`. */
export function toolElapsedMs(run, nowMs) {
  if (run.currentTool === null || run.currentToolStartedAt === null) return null;
  if (run.state !== "running") return null;
  const elapsed = nowMs - run.currentToolStartedAt;
  return isNonNegativeFinite(elapsed) ? elapsed : null;
}

/**
 * `+N`: unshown valid roots plus the sender's own omitted root count, saturated
 * at `MAX_SAFE_INTEGER` — the sender may legitimately report that many omitted
 * roots, and an overflowing sum would render as a non-integer-looking count.
 */
export function omittedRowCount(snapshot) {
  const unshown = Math.max(0, snapshot.runs.length - MAX_ROWS) + snapshot.omittedRuns;
  return Math.min(Number.MAX_SAFE_INTEGER, unshown);
}

function isSnapshotEnvelope(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === SNAPSHOT_KIND &&
    value.version === SNAPSHOT_VERSION &&
    Array.isArray(value.runs)
  );
}

function normalizeRun(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.label !== "string" || !STATE_SET.has(value.state)) return null;
  const activity = plainObject(value.activity);
  return {
    label: value.label,
    state: value.state,
    startedAt: nonNegativeFinite(value.startedAt),
    updatedAt: nonNegativeFinite(value.updatedAt),
    endedAt: nonNegativeFinite(value.endedAt),
    currentTool: nonEmptyString(activity.currentTool),
    currentToolStartedAt: nonNegativeFinite(activity.currentToolStartedAt),
    turnCount: nonNegativeFinite(activity.turnCount),
    toolCount: nonNegativeFinite(activity.toolCount),
    needsAttention: activity.state === ATTENTION_STATE,
  };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeFinite(value) {
  return isNonNegativeFinite(value) ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function utf8Bytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) index += 1;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
