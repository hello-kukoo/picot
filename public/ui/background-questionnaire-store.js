// ABOUTME: Parks ask_user_question state while its session runtime runs in the background.
// ABOUTME: Flushed on foreground snapshot: card state rebuilds and queued walker requests replay.

const TOOL_NAME = "ask_user_question";

const BLOCKING_UI_METHODS = new Set(["select", "input", "confirm", "editor"]);

function keyFor(sessionFile, runtimeId) {
  return sessionFile || runtimeId || "unknown";
}

function entryFor(entries, sessionFile, runtimeId) {
  const key = keyFor(sessionFile, runtimeId);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      sessionFile: sessionFile || null,
      runtimeId: runtimeId || null,
      toolCallId: null,
      questions: null,
      queuedRequests: [],
      cardState: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

/**
 * Per-session parking lot for blocking questionnaire UI. A backgrounded pi
 * runtime waits on `extension_ui_response` forever; parking its card state
 * and walker requests here keeps the wait answerable after the user returns
 * to that session. Entries are dropped when the parked tool ends, or handed
 * out once via `take()` when the session returns to the foreground.
 */
export class BackgroundQuestionnaireStore {
  constructor() {
    this.entries = new Map();
  }

  /** Park a background `tool_execution_start` for ask_user_question. */
  parkToolStart(sessionFile, runtimeId, event) {
    const args = event?.args && typeof event.args === "object" ? event.args : null;
    const questions = Array.isArray(args?.questions) ? args.questions : null;
    if (event?.toolName !== TOOL_NAME || !questions || questions.length === 0) return false;
    const entry = entryFor(this.entries, sessionFile, runtimeId);
    entry.toolCallId = event.toolCallId || null;
    entry.questions = questions;
    return true;
  }

  /** Queue a blocking walker request. Returns true when the caller should badge the session. */
  queueRequest(sessionFile, runtimeId, request) {
    if (!BLOCKING_UI_METHODS.has(request?.method)) return false;
    entryFor(this.entries, sessionFile, runtimeId).queuedRequests.push(request);
    return true;
  }

  /** Park the visible card's captured state (e.g. the user switched sessions mid-questionnaire). */
  parkActive(sessionFile, runtimeId, cardState) {
    if (!cardState || !Array.isArray(cardState.questions) || cardState.questions.length === 0) {
      return false;
    }
    const entry = entryFor(this.entries, sessionFile, runtimeId);
    entry.cardState = cardState;
    if (cardState.toolCallId) entry.toolCallId = cardState.toolCallId;
    if (!entry.questions) entry.questions = cardState.questions;
    return true;
  }

  /** Drop the entry when the parked tool call ends (answered elsewhere, aborted, or errored). */
  handleToolEnd(sessionFile, runtimeId, toolCallId) {
    if (!toolCallId) return;
    const key = keyFor(sessionFile, runtimeId);
    if (this.entries.get(key)?.toolCallId === toolCallId) {
      this.entries.delete(key);
    }
  }

  /** Hand out and delete the session's parked entry. Matched by session file or runtime id. */
  take(sessionFile, runtimeId) {
    for (const [key, entry] of this.entries) {
      const fileMatch = sessionFile && entry.sessionFile === sessionFile;
      const runtimeMatch = runtimeId && entry.runtimeId === runtimeId;
      if (fileMatch || runtimeMatch) {
        this.entries.delete(key);
        return entry;
      }
    }
    return null;
  }
}
