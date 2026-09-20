// ABOUTME: Shared @-file-mention textarea listbox controller for Main, Side, and Quick Chat.
// ABOUTME: Owns parsing, popup, caret replacement, IME-safe keys, teardown, host mention search.
import { t } from "../i18n.js";

const TOKEN_DELIMITERS = new Set([" ", "\t", "=", "'", '"']);

/**
 * Resolve the active `@` mention token for a raw value and caret, or null when
 * the caret is not inside a mention token. A token starts only at a supported
 * boundary (line start, or after a delimiter) and never crosses a newline.
 * Pure so the composer trigger router can share the exact same semantics.
 */
export function resolveAtMentionToken(value, caret) {
  if (typeof value !== "string" || typeof caret !== "number" || caret < 1) return null;
  const before = value.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);

  let atIdx = -1;
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (line[i] !== "@") continue;
    const prev = i === 0 ? "" : line[i - 1];
    if (i === 0 || TOKEN_DELIMITERS.has(prev)) atIdx = i;
    // The rightmost @ is the only candidate; an embedded @ (email-like) is inactive.
    break;
  }
  if (atIdx === -1) return null;

  // The token stays active only while it contains no unquoted whitespace.
  let inQuote = false;
  for (let j = atIdx; j < line.length; j += 1) {
    const ch = line[j];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && (ch === " " || ch === "\t")) {
      return null;
    }
  }

  return { prefix: line.slice(atIdx), start: lineStart + atIdx, end: caret };
}

/**
 * Extract the active `@` mention prefix at the textarea cursor, or null when the
 * cursor is not inside a mention token. Thin wrapper over the pure resolver.
 */
export function activeAtMention(input) {
  return resolveAtMentionToken(input.value, input.selectionStart ?? input.value.length);
}

/**
 * Classify a mention query's search root (2026-09-19 spec, contract D audit
 * field). Mirrors the Rust `classify_mention_body` — the host re-parses
 * authoritatively and rejects any declaration that disagrees. Returns
 * `{ kind, value }` or null for syntactically invalid tokens (the caller
 * skips the round-trip; the host would reject them anyway).
 * `~` is NEVER expanded here — the host owns home resolution.
 */
export function classifyMentionRoot(query, workspaceRoot) {
  if (typeof query !== "string" || !query.startsWith("@")) return null;
  let body = query.slice(1);
  if (body.startsWith('"')) body = body.slice(1).replace(/"$/, "");
  body = body.replace(/\\/g, "/");
  const dotDot = (scope) => scope.split("/").some((part) => part === "..");
  // Case-sensitive on purpose (repo precedent, appearance-preferences): a
  // case-insensitive /win/i would match macOS "darwin".
  const windows = /Windows/.test(globalThis.navigator?.userAgent || "");

  if (body === "~" || body.startsWith("~/")) {
    const scope = body === "~" ? "" : body.slice(2);
    return dotDot(scope) ? null : { kind: "home", value: "~" };
  }
  // Drive prefixes are a Windows-only form (mirrors the Rust cfg gate): on
  // other platforms `@c:/x` stays a workspace-relative token.
  if (windows && /^[A-Za-z]:($|\/)/.test(body)) {
    const scope = body.length > 2 ? body.slice(3) : "";
    return dotDot(scope) ? null : { kind: "drive", value: `${body[0].toUpperCase()}:/` };
  }
  if (body.startsWith("/")) {
    if (!windows) {
      return dotDot(body.slice(1)) ? null : { kind: "absolute", value: "/" };
    }
    if (!body.startsWith("//")) return null; // bare `@/` has no single root on Windows
    const parts = body.slice(2).split("/");
    if (!parts[0] || !parts[1]) return null;
    return dotDot(parts.slice(2).join("/"))
      ? null
      : { kind: "unc", value: `//${parts[0]}/${parts[1]}` };
  }
  let levels = 0;
  let rest = body;
  while (rest.startsWith("../")) {
    levels += 1;
    rest = rest.slice(3);
  }
  if (rest === "..") {
    levels += 1;
    rest = "";
  }
  if (levels > 0) {
    if (dotDot(rest)) return null;
    const ws = String(workspaceRoot || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    const comps = ws.split("/").filter(Boolean);
    const floor = windows ? 1 : 0;
    while (comps.length > floor && levels > 0) {
      comps.pop();
      levels -= 1;
    }
    const value = comps.length === 0 ? "/" : `/${comps.join("/")}`;
    return { kind: "absolute", value };
  }
  const scope = body.startsWith("./") ? body.slice(2) : body;
  return dotDot(scope) ? null : { kind: "workspace", value: "" };
}

// Mention candidates are constructed HOST-side (Rust
// `build_file_mention_candidate`, upstream parity): `value` is the insertable
// token in the user's input form — relative to the search scope, directories
// keep the trailing slash, spaces quote the token. The frontend passes them
// through verbatim and never re-roots them (2026-09-19 spec, contract A).
/**
 * `searchFiles` implementation over the host v2 data plane. The host answers
 * with fully-built candidates (`items` + `truncated`); the frontend maps them
 * 1:1. An unavailable transport or workspace degrades to an empty list.
 */
export function createHostFileMentionSearch(getTransport) {
  return async (workspaceRoot, query) => {
    const transport = typeof getTransport === "function" ? getTransport() : getTransport;
    if (!transport?.fileMentions || !workspaceRoot) return { items: [], truncated: false };
    // The declared root must mirror the host's own parse; an invalid token
    // skips the round-trip (the host would reject it).
    const root = classifyMentionRoot(query, workspaceRoot);
    if (!root) return { items: [], truncated: false };
    const response = await transport.fileMentions(query, root);
    const items = Array.isArray(response?.items) ? response.items : [];
    return {
      items: items.map((item) => ({
        value: item.value,
        label: item.label,
        description: item.description,
        isDirectory: Boolean(item.isDirectory),
      })),
      // Data-only for now; no UI (2026-09-19 decision ③).
      truncated: Boolean(response?.truncated),
    };
  };
}

/**
 * Install @-file-mention completion on a textarea. In the default standalone
 * mode the controller owns its input/click/keyup/keydown/blur listeners.
 * With `router: true` (main composer) the composer trigger router drives
 * `update(trigger)` / `handleKeydown(event)` and owns the only keydown
 * listener, so no two handlers contend for a key — but blur-close still
 * registers here in both modes (the router has no replacement for it).
 */
export function setupAtFileMention(options) {
  const { input, container, getWorkspaceRoot, searchFiles } = options;
  const doc = options.document ?? document;
  const routerMode = Boolean(options.router);

  let destroyed = false;
  let generation = 0;
  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let abortController = null;
  let timer = null;

  const baseOptionId = `${container.id || "at-file-mention"}-opt`;

  container.setAttribute("role", "listbox");
  container.setAttribute("aria-label", t("fileMention.listLabel"));

  function close() {
    generation += 1;
    open = false;
    matches = [];
    selectedIndex = 0;
    container.classList.add("hidden");
    container.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  // Contract E (decision ②): an invalid query or an unreachable search root
  // renders one error line in the menu's empty-state area — distinguishable
  // from a legitimate "no matches" (which stays a closed/empty menu).
  function renderError(message) {
    if (destroyed) return;
    matches = [];
    input.removeAttribute("aria-activedescendant");
    selectedIndex = 0;
    container.replaceChildren();
    const error = doc.createElement("div");
    error.className = "at-file-mention-error";
    error.setAttribute("role", "status");
    error.textContent = message;
    container.appendChild(error);
    open = true;
    container.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }

  function render(items) {
    matches = items;
    if (destroyed || items.length === 0) {
      close();
      return;
    }
    selectedIndex = Math.min(selectedIndex, items.length - 1);
    container.innerHTML = "";

    items.forEach((candidate, index) => {
      const option = doc.createElement("button");
      option.type = "button";
      option.id = `${baseOptionId}-${index}`;
      option.className = "at-file-mention-option";
      option.setAttribute("role", "option");
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));

      const label = doc.createElement("span");
      label.className = "at-file-mention-name";
      label.textContent = candidate.label;
      const description = doc.createElement("span");
      description.className = "at-file-mention-description";
      description.textContent = candidate.description;
      option.appendChild(label);
      option.appendChild(description);

      option.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelection();
      });
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => select(index));
      container.appendChild(option);
    });

    open = true;
    container.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    updateSelection();
  }

  function updateSelection() {
    const optionEls = container.querySelectorAll(".at-file-mention-option");
    optionEls.forEach((option, index) => {
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    if (matches.length > 0) {
      input.setAttribute("aria-activedescendant", `${baseOptionId}-${selectedIndex}`);
      optionEls[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }

  function select(index) {
    const candidate = matches[index];
    const active = activeAtMention(input);
    if (!candidate || !active) return;
    const suffix = candidate.isDirectory ? "" : " ";
    const value = candidate.value;
    let end = active.end;
    // If a closing quote already follows the cursor, consume it so we don't
    // produce @"dir/file\"\" — the candidate value already supplies its own.
    if (value.endsWith('"') && input.value[active.end] === '"') {
      end = active.end + 1;
    }
    try {
      input.setRangeText(value + suffix, active.start, end, "end");
    } catch {
      const before = input.value.slice(0, active.start);
      const after = input.value.slice(end);
      input.value = before + value + suffix + after;
      const caret = active.start + value.length + suffix.length;
      input.setSelectionRange(caret, caret);
    }
    // For a quoted directory, setRangeText(..., "end") lands the caret after the
    // closing quote; move it back inside so typing can continue the path.
    if (candidate.isDirectory && value.endsWith('"')) {
      const pos = (input.selectionStart ?? 0) - 1;
      input.setSelectionRange(pos, pos);
    }
    input.dispatchEvent(
      new (options.Event ?? doc.defaultView?.Event ?? Event)("input", { bubbles: true }),
    );
    close();
  }

  async function runRequest(active) {
    const requestGeneration = generation;
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      close();
      return;
    }
    // Keep this request's own copy: a shared snapshot would be reassigned by
    // every newer request, so comparing against it would let a slow, abandoned
    // response pass the staleness check and render candidates for a prefix the
    // user has already changed.
    const own = {
      generation: requestGeneration,
      value: input.value,
      cursor: input.selectionStart ?? 0,
    };

    const isCurrent = () =>
      !destroyed &&
      own.generation === generation &&
      own.value === input.value &&
      own.cursor === (input.selectionStart ?? 0);

    if (abortController) abortController.abort();
    abortController = new (
      options.AbortController ??
      doc.defaultView?.AbortController ??
      AbortController
    )();

    let result;
    try {
      result = await searchFiles(workspaceRoot, active.prefix, abortController.signal);
    } catch (error) {
      if (!isCurrent()) return;
      if (error?.code === "invalid_mention_query") {
        renderError(t("fileMention.invalidQuery"));
        return;
      }
      if (error?.code === "mention_root_unavailable") {
        renderError(t("fileMention.rootUnavailable"));
        return;
      }
      close();
      return;
    }

    if (!isCurrent()) return;
    render(result.items ?? []);
  }

  // The token passed here comes either from the router's resolver or from the
  // standalone listeners; either way it is the same pure parser's output.
  function schedule(token) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!token) {
        close();
        return;
      }
      runRequest(token);
    }, 20);
  }

  // Router-facing contract: consume a resolved trigger (or null → close).
  function updateFromTrigger(trigger) {
    schedule(
      trigger && trigger.kind === "mention" && typeof trigger.query === "string"
        ? { prefix: trigger.query, start: trigger.start, end: trigger.end }
        : null,
    );
    return Promise.resolve();
  }

  /**
   * Consume a keydown when the menu is open. Returns true when the key was
   * consumed (preventDefault + stopImmediatePropagation already applied).
   * The router only calls this while the picker reports itself open.
   */
  function handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return false;
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (matches.length === 0) return true;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
      updateSelection();
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      select(selectedIndex);
      return true;
    }
    return false;
  }

  // A consumed key sends no further input event, so the keyup that follows would
  // re-resolve the still-present token and reopen the menu the key dismissed.
  let swallowNextKeyup = false;

  function onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && (open || activeAtMention(input))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      swallowNextKeyup = true;
      close();
      return;
    }
    if (!open) return;
    swallowNextKeyup = handleKeydown(event) === true;
  }

  const onBlur = () => queueMicrotask(close);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");
  if (!routerMode) {
    input.addEventListener("input", () => schedule(activeAtMention(input)));
    input.addEventListener("click", () => schedule(activeAtMention(input)));
    input.addEventListener("keyup", () => {
      if (swallowNextKeyup) {
        swallowNextKeyup = false;
        return;
      }
      schedule(activeAtMention(input));
    });
    input.addEventListener("keydown", onKeyDown);
  }
  input.addEventListener("blur", onBlur);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (abortController) abortController.abort();
    if (timer) clearTimeout(timer);
    if (!routerMode) {
      input.removeEventListener("keydown", onKeyDown);
    }
    input.removeEventListener("blur", onBlur);
    close();
  }

  async function update() {
    const active = activeAtMention(input);
    if (!active) {
      close();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    await runRequest(active);
  }

  const controller = { close, destroy, update, select, isOpen: () => open, handleKeydown };
  if (routerMode) {
    controller.update = updateFromTrigger;
  }
  return controller;
}
