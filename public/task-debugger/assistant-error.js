/**
 * Extract provider/LLM failure text from Pi runtime events.
 *
 * A failed Groq/OpenAI call typically arrives as:
 *   { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content: [] } }
 * The transcript has no assistant text, so the UI must read errorMessage itself.
 */

function trimmedString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message.trim();
  }
  return "";
}

export function extractAssistantError(message, { fallback } = {}) {
  if (!message || (message.role && message.role !== "assistant")) return null;
  const stop = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stop === "aborted") return null;
  const text = trimmedString(message.errorMessage) || trimmedString(message.error);
  if (text) return text;
  if (stop === "error") return fallback || "The model request failed.";
  return null;
}

export function extractRuntimeEventError(event, { fallback } = {}) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "message_end") {
    return extractAssistantError(event.message, { fallback });
  }
  if (event.type !== "agent_end" && event.type !== "agent_settled") return null;
  const direct = trimmedString(event.errorMessage) || trimmedString(event.error);
  if (direct) return direct;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const err = extractAssistantError(messages[i], { fallback });
    if (err) return err;
  }
  return extractAssistantError(event.message, { fallback });
}
