// ABOUTME: One composer trigger router: exactly one active slash/mention token.
// ABOUTME: Pure token resolution plus a single keydown/input dispatcher shared by pickers.
import { resolveAtMentionToken } from "./at-file-mention.js";

/**
 * Slash token at the caret. The token starts with `/` at a token boundary
 * (input start or after whitespace), contains no whitespace up to the caret,
 * and may include `:` and `@` (so `/skill:foo` stays one token). `a/b` never
 * matches: the token must START with `/`. Slash tokens are purely
 * whitespace-delimited — unlike mention tokens they carry no path syntax, so
 * quote-awareness here only let prose like `say \"/deploy` open the picker.
 */
export function resolveSlashToken(value, caret) {
  if (typeof value !== "string" || typeof caret !== "number" || caret < 1) return null;
  const before = value.slice(0, caret);
  // Walk to the token start: a `/` not preceded by another word character.
  let start = -1;
  for (let i = 0; i < before.length; i += 1) {
    const ch = before[i];
    if (/\s/.test(ch)) {
      start = -1;
      continue;
    }
    if (ch === "/" && start === -1) start = i;
  }
  if (start === -1) return null;
  // The `/` must sit at a true boundary: input start or right after whitespace.
  const prev = start === 0 ? "" : before[start - 1];
  if (prev && !/\s/.test(prev)) return null;
  const query = before.slice(start + 1);
  return { start, end: caret, query };
}

/**
 * Resolve the single active trigger at the caret. Exactly one trigger may be
 * active; when the caret sits inside both a valid slash and mention token,
 * slash wins (fixed precedence). Mention semantics are the existing
 * rightmost-`@` quote-aware parser, unchanged.
 */
export function resolveActiveTrigger(value, caret) {
  const slash = resolveSlashToken(value, caret);
  if (slash) return { kind: "slash", ...slash };
  const mention = resolveAtMentionToken(value, caret);
  if (mention)
    return { kind: "mention", start: mention.start, end: mention.end, query: mention.prefix };
  return null;
}

/**
 * Install the router on a composer textarea. `pickers` entries carry a
 * `kind` plus the controller contract:
 *   update(trigger) — re-evaluate against a resolved trigger object
 *   close()         — hide unconditionally
 *   isOpen()        — report the open state
 *   handleKeydown(event) -> boolean — consume Escape/Arrow/Enter/Tab when open
 * The router owns the ONLY input/click/keyup/keydown listeners; when no
 * picker reports itself open, keys fall through untouched (Enter still sends).
 */
export function createTriggerRouter({ input, pickers }) {
  if (!input) throw new Error("createTriggerRouter requires an input element");
  const byKind = new Map();
  for (const picker of pickers || []) {
    if (!picker?.kind) throw new Error("router pickers must carry a kind");
    byKind.set(picker.kind, picker);
  }

  const currentTrigger = () =>
    resolveActiveTrigger(input.value, input.selectionStart ?? input.value.length);

  // A key the picker consumed (Escape closing it, arrows moving the highlight)
  // sends no further input event, so the keyup that follows would re-resolve the
  // still-present token and reopen the menu the key just dismissed. Swallow
  // exactly that one keyup.
  let swallowNextKeyup = false;

  const refresh = () => {
    const trigger = currentTrigger();
    for (const [kind, picker] of byKind) {
      if (trigger?.kind === kind) {
        picker.update(trigger);
      } else {
        picker.close();
      }
    }
  };

  const onKeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const trigger = currentTrigger();
    const picker = trigger ? byKind.get(trigger.kind) : null;
    if (!picker || typeof picker.isOpen !== "function" || !picker.isOpen()) return;
    swallowNextKeyup = picker.handleKeydown(event) === true;
  };

  const onKeyup = (event) => {
    if (swallowNextKeyup) {
      swallowNextKeyup = false;
      return;
    }
    refresh(event);
  };

  input.addEventListener("input", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("keyup", onKeyup);
  input.addEventListener("keydown", onKeydown);

  return {
    refresh,
    destroy() {
      input.removeEventListener("input", refresh);
      input.removeEventListener("click", refresh);
      input.removeEventListener("keyup", onKeyup);
      input.removeEventListener("keydown", onKeydown);
      for (const picker of byKind.values()) picker.close?.();
      byKind.clear();
    },
  };
}
