// ABOUTME: Accumulates Pi assistant message deltas for the native runtime UI.
// ABOUTME: It tolerates delta-only events and resets at message completion or navigation.

function emptyMessage() {
  return { role: "assistant", content: [] };
}

export function getAssistantMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function ensureBlock(content, index, type) {
  const existing = content[index];
  if (existing?.type === type) return existing;

  const block = type === "thinking" ? { type, thinking: "" } : { type: "text", text: "" };
  content[index] = block;
  return block;
}

function applyDelta(message, event) {
  const delta = event?.assistantMessageEvent;
  if (!delta || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0) return message;

  switch (delta.type) {
    case "thinking_start":
      ensureBlock(message.content, delta.contentIndex, "thinking");
      break;
    case "thinking_delta": {
      const block = ensureBlock(message.content, delta.contentIndex, "thinking");
      block.thinking += delta.delta ?? "";
      break;
    }
    case "thinking_end": {
      const block = ensureBlock(message.content, delta.contentIndex, "thinking");
      if (typeof delta.content === "string") block.thinking = delta.content;
      break;
    }
    case "text_start":
      ensureBlock(message.content, delta.contentIndex, "text");
      break;
    case "text_delta": {
      const block = ensureBlock(message.content, delta.contentIndex, "text");
      block.text += delta.delta ?? "";
      break;
    }
    case "text_end": {
      const block = ensureBlock(message.content, delta.contentIndex, "text");
      if (typeof delta.content === "string") block.text = delta.content;
      break;
    }
  }

  if (event.usage) message.usage = structuredClone(event.usage);
  return message;
}

export function createAssistantMessageStream() {
  let message = null;

  return {
    start(initialMessage) {
      message =
        initialMessage?.role === "assistant"
          ? {
              ...initialMessage,
              content: Array.isArray(initialMessage.content)
                ? structuredClone(initialMessage.content)
                : [],
            }
          : emptyMessage();
      return structuredClone(message);
    },
    update(event) {
      message = applyDelta(message ?? emptyMessage(), event);
      return structuredClone(message);
    },
    finish(finalMessage) {
      const completed = structuredClone(finalMessage ?? message ?? emptyMessage());
      message = null;
      return completed;
    },
    reset() {
      message = null;
    },
  };
}
