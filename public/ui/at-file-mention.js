// ABOUTME: Shared @-file-mention textarea listbox controller for Main, Side, and Quick Chat.
// ABOUTME: Owns parsing, popup, caret replacement, IME-safe keys, teardown, host mention search.
import { t } from "../i18n.js";

const TOKEN_DELIMITERS = new Set([" ", "\t", "=", "'", '"']);

/**
 * Extract the active `@` mention prefix at the textarea cursor, or null when the
 * cursor is not inside a mention token. A token starts only at a supported
 * boundary (line start, or after a delimiter) and never crosses a newline.
 */
export function activeAtMention(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
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

  return { prefix: line.slice(atIdx), start: lineStart + atIdx, end: cursor };
}

/**
 * Install @-file-mention completion on a textarea. Mirrors the lifecycle of
 * `setupSkillSlashCommand()` but is independent from skills. Returns an
 * idempotent controller whose keydown listener must be registered before any
 * composer send handler.
 */
/**
 * Build a mention candidate from a resolved workspace path. Mirrors the Pi TUI
 * `@<absolute-path>` semantics: directories keep the trailing slash and paths
 * containing spaces are quoted, so the inserted token parses as one mention.
 */
export function buildMentionCandidate(displayPath, isDirectory) {
  const valuePath = isDirectory ? `${displayPath}/` : displayPath;
  const name = displayPath.split("/").filter(Boolean).pop() || displayPath;
  const needsQuotes = valuePath.includes(" ");
  return {
    value: needsQuotes ? `@"${valuePath}"` : `@${valuePath}`,
    label: `${name}${isDirectory ? "/" : ""}`,
    description: displayPath,
    isDirectory,
  };
}

/**
 * `searchFiles` implementation over the host v2 data plane. The host answers
 * with workspace-relative entries, so the absolute display path is rebuilt
 * here from the caller's live workspace root.
 */
/**
 * `searchFiles` implementation over the host v2 data plane. The host answers
 * with workspace-relative entries, so the absolute display path is rebuilt
 * here from the caller's live workspace root. `getTransport` is resolved per
 * call because ephemeral runtimes swap or drop their transport on teardown.
 */
export function createHostFileMentionSearch(getTransport) {
  return async (workspaceRoot, query) => {
    const transport = typeof getTransport === "function" ? getTransport() : getTransport;
    if (!transport?.fileMentions || !workspaceRoot) return { items: [] };
    const response = await transport.fileMentions(query);
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const root = String(workspaceRoot).replace(/\/+$/, "");
    return {
      items: entries.map((entry) =>
        buildMentionCandidate(`${root}/${entry.relativePath ?? ""}`, entry.kind === "directory"),
      ),
    };
  };
}

export function setupAtFileMention(options) {
  const { input, container, getWorkspaceRoot, searchFiles } = options;
  const doc = options.document ?? document;

  let destroyed = false;
  let generation = 0;
  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let abortController = null;
  let timer = null;
  let snapshot = null;

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
    snapshot = {
      generation: requestGeneration,
      value: input.value,
      cursor: input.selectionStart ?? 0,
    };

    if (abortController) abortController.abort();
    abortController = new (
      options.AbortController ??
      doc.defaultView?.AbortController ??
      AbortController
    )();

    let result;
    try {
      result = await searchFiles(workspaceRoot, active.prefix, abortController.signal);
    } catch {
      if (!destroyed) close();
      return;
    }

    if (
      destroyed ||
      requestGeneration !== generation ||
      snapshot.value !== input.value ||
      snapshot.cursor !== (input.selectionStart ?? 0)
    ) {
      return;
    }
    render(result.items ?? []);
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const active = activeAtMention(input);
      if (!active) {
        close();
        return;
      }
      runRequest(active);
    }, 20);
  }

  function onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && (open || activeAtMention(input))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (matches.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
      updateSelection();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      select(selectedIndex);
    }
  }

  const onBlur = () => queueMicrotask(close);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", schedule);
  input.addEventListener("click", schedule);
  input.addEventListener("keyup", schedule);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (abortController) abortController.abort();
    if (timer) clearTimeout(timer);
    input.removeEventListener("input", schedule);
    input.removeEventListener("click", schedule);
    input.removeEventListener("keyup", schedule);
    input.removeEventListener("keydown", onKeyDown);
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

  return { close, destroy, update, select };
}
