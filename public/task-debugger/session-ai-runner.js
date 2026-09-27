// ABOUTME: Sends a session's turn/step data to the model itself so it can
// ABOUTME: call out risks, blockers and failures -- not just timing stats.

const MAX_STEPS_PER_TURN = 40;
const MAX_TRANSCRIPT_CHARS = 24_000;
const SETTLE_TIMEOUT_MS = 5 * 60_000;

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ai-analysis-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function formatStep(step) {
  const bits = [`[${step.kind}] ${step.label}`];
  if (step.detail) bits.push(`(${step.detail})`);
  bits.push(`- ${step.status}`);
  if (step.error) bits.push(`ERROR: ${step.error}`);
  return bits.join(" ");
}

/** Render turns (turn-trace.js / turn-history.js shape) into a plain-text transcript for an LLM prompt. */
export function buildTranscript(turns, { maxChars = MAX_TRANSCRIPT_CHARS } = {}) {
  const lines = [];
  for (const turn of turns) {
    lines.push(`### Turn ${turn.index} - ${turn.status}${turn.error ? ` (${turn.error})` : ""}`);
    if (turn.prompt) lines.push(`User: ${turn.prompt}`);
    for (const step of turn.steps.slice(0, MAX_STEPS_PER_TURN)) lines.push(formatStep(step));
    lines.push("");
  }
  let text = lines.join("\n").trim();
  if (text.length > maxChars) {
    // Keep the tail: the failure the user came to see is usually near the end.
    text = `...[${text.length - maxChars} earlier characters truncated]...\n${text.slice(-maxChars)}`;
  }
  return text;
}

/** Build the prompt asking the model to read its own run log for risk/blocker/failure signal. */
export function buildAnalysisPrompt(turns) {
  const transcript = buildTranscript(turns);
  return [
    "You are reviewing a coding agent's own run log, not writing code. Read the transcript below and answer with exactly these sections (omit a section entirely if the transcript has nothing for it -- never pad with generic advice):",
    "",
    "## 风险点 (Risk points)",
    "## 卡点 (Blockers / stuck points)",
    "## 失败点 (Failure points)",
    "",
    "For every item: name the concrete turn/step it came from, quote the relevant error or detail, and say briefly why it matters. Do not restate timing statistics (duration, percentage) -- a separate mechanical report already covers those; focus on what went wrong or is fragile. If none of the three sections has anything real to report, do not omit all of them silently -- reply with one line saying so instead of leaving the answer empty. Reply in Chinese.",
    "",
    "--- TRANSCRIPT START ---",
    transcript,
    "--- TRANSCRIPT END ---",
  ].join("\n");
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

/**
 * Wait for the given runtime instance's agent run to fully settle. The
 * `prompt` RPC response only confirms pi accepted/queued the message --
 * per pi's own RPC contract the reply streams in asynchronously afterwards
 * as `runtime_event` frames -- so reading a snapshot right after `prompt`
 * resolves races the actual generation and usually finds no assistant
 * reply yet. `agent_settled` (also used elsewhere as the "background
 * session done" signal) is the point at which pi is done retrying,
 * compacting and running queued continuations for this turn.
 */
function waitForAgentSettled(runtime, instanceId, { timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  if (typeof runtime.subscribe !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the analysis session to settle"));
    }, timeoutMs);
    const unsubscribe = runtime.subscribe((frame) => {
      if (frame?.type !== "runtime_event") return;
      if (frame.target?.instanceId !== instanceId) return;
      if (frame.event?.type !== "agent_settled") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * Run `prompt` against a throwaway background session in `workspaceId` so the
 * user's own conversation is never touched, then discard that session.
 *
 * @param {{
 *   runtime: { request: Function, snapshot: Function, subscribe?: Function },
 *   control: { deleteSessions: Function },
 *   spawnSession: (workspaceId: string) => Promise<{workspaceId, sessionId, instanceId}>,
 *   workspaceId: string,
 *   model?: { provider: string, id: string } | null,
 *   prompt: string,
 * }} options
 * @returns {Promise<string>} the model's reply text
 */
export async function runAiAnalysis({
  runtime,
  control,
  spawnSession,
  workspaceId,
  model,
  prompt,
}) {
  const target = await spawnSession(workspaceId);
  // A fresh runtime trades its temporary session id for a persisted one at
  // least once (the snapshot below), and can do so again afterwards (e.g.
  // once the host finishes naming the session). Deleting every id this run
  // ever saw is the only reliable way to not leave a throwaway session
  // behind, since deleting an id with no matching file on disk is a no-op.
  const sessionIdsToDelete = new Set([target.sessionId]);
  try {
    if (model?.provider && model?.id) {
      await runtime.request(
        { type: "set_model", provider: model.provider, modelId: model.id },
        target,
        { idempotencyKey: randomId() },
      );
    }
    const settled = waitForAgentSettled(runtime, target.instanceId);
    await runtime.request({ type: "prompt", message: prompt }, target, {
      idempotencyKey: randomId(),
    });
    await settled;
    // Read the reply from the runtime's own in-memory state rather than the
    // on-disk log: a session this fresh can still be mid-write right after
    // the prompt resolves, which makes a disk re-read a real race.
    const snapshot = await runtime.snapshot(target.sessionId);
    if (snapshot?.target?.sessionId) sessionIdsToDelete.add(snapshot.target.sessionId);
    const messages = Array.isArray(snapshot?.state?.messages) ? snapshot.state.messages : [];
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const text = textFromContent(lastAssistant?.content);
    if (!text) throw new Error("The model returned no analysis text");
    return text;
  } finally {
    control.deleteSessions([...sessionIdsToDelete]).catch(() => {});
  }
}
