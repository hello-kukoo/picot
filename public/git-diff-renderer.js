// ABOUTME: Renders bounded Git patches as read-only side-by-side rows.
// ABOUTME: Uses separate scroll columns, block alignment, fixed gutters, and explicit raw fallback reasons.

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { currentEditorHighlightStyle } from "./code-editor.js";
import { languageExtensionForPath } from "./file-language.js";
import { t } from "./i18n.js";

const MAX_ALIGNED_ROWS = 600;

function parsePatch(patch) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  const lines = String(patch || "").split("\n");
  while (index < lines.length) {
    const line = lines[index++];
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }
    if (/^(---|\+\+\+|diff |index |\\ No newline)/.test(line)) continue;
    if (line.startsWith(" ")) {
      rows.push({
        original: { line: oldLine++, text: line.slice(1), kind: "unchanged" },
        current: { line: newLine++, text: line.slice(1), kind: "unchanged" },
      });
      continue;
    }
    if (!line.startsWith("-")) {
      if (line.startsWith("+"))
        rows.push({
          original: null,
          current: { line: newLine++, text: line.slice(1), kind: "added" },
        });
      continue;
    }
    const removed = [];
    while (index - 1 < lines.length && lines[index - 1].startsWith("-")) {
      removed.push({ line: oldLine++, text: lines[index - 1].slice(1), kind: "removed" });
      if (index >= lines.length || !lines[index].startsWith("-")) break;
      index += 1;
    }
    const added = [];
    while (index < lines.length && lines[index].startsWith("+")) {
      added.push({ line: newLine++, text: lines[index].slice(1), kind: "added" });
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1)
      rows.push({ original: removed[offset] || null, current: added[offset] || null });
  }
  return rows.slice(0, MAX_ALIGNED_ROWS);
}

function parseUnifiedPatch(patch) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(patch || "").split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (/^(---|\+\+\+|diff |index |\\ No newline)/.test(line)) continue;
    if (line.startsWith(" "))
      rows.push({ kind: "unchanged", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else if (line.startsWith("-"))
      rows.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++ });
    else if (line.startsWith("+"))
      rows.push({ kind: "added", text: line.slice(1), newLine: newLine++ });
    if (rows.length >= MAX_ALIGNED_ROWS) break;
  }
  return rows;
}

const mountedHighlightStyles = new WeakSet();

function appendHighlightedText(target, text, filePath) {
  const language = languageExtensionForPath(filePath);
  if (!language || !text) {
    target.appendChild(document.createTextNode(text || ""));
    return;
  }
  const style = currentEditorHighlightStyle();
  if (style?.module && !mountedHighlightStyles.has(style.module)) {
    const css = document.createElement("style");
    css.dataset.diffHighlightStyle = "true";
    css.textContent = style.module.getRules();
    document.head.appendChild(css);
    mountedHighlightStyles.add(style.module);
  }
  const state = EditorState.create({ doc: text, extensions: [language] });
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (!tree) {
    target.appendChild(document.createTextNode(text));
    return;
  }
  let cursor = 0;
  highlightTree(tree, style, (from, to, classes) => {
    if (from > cursor) target.appendChild(document.createTextNode(text.slice(cursor, from)));
    const span = document.createElement("span");
    span.className = classes;
    span.textContent = text.slice(from, to);
    target.appendChild(span);
    cursor = to;
  });
  if (cursor < text.length) target.appendChild(document.createTextNode(text.slice(cursor)));
}

function createDiffCell(cell, filePath) {
  const el = document.createElement("div");
  el.className = `git-diff-cell ${cell?.kind || "blank"}`;
  const gutter = document.createElement("span");
  gutter.className = "git-diff-gutter";
  gutter.textContent = cell?.line === null || cell?.line === undefined ? "" : String(cell.line);
  const text = document.createElement("span");
  text.className = "git-diff-source";
  appendHighlightedText(text, cell?.text || "", filePath);
  el.append(gutter, text);
  return el;
}

function createUnifiedLine(cell) {
  const line = document.createElement("div");
  line.className = `git-diff-unified-line ${cell.kind}`;
  line.dataset.kind = cell.kind;
  const sign = document.createElement("span");
  sign.className = "git-diff-sign";
  sign.textContent = cell.kind === "added" ? "+" : cell.kind === "removed" ? "-" : " ";
  const number = document.createElement("span");
  number.className = "git-diff-line-number";
  number.textContent = cell.line == null ? "" : String(cell.line);
  const text = document.createElement("span");
  text.className = "git-diff-source";
  appendHighlightedText(text, cell.text || "", cell.filePath);
  line.append(sign, number, text);
  return line;
}

export function createGitDiffRenderer(initialDescriptor = {}) {
  let descriptor = initialDescriptor;
  let root;
  const onThemeChange = () => {
    if (root) render(root);
  };
  const render = (container) => {
    root = container;
    container.replaceChildren();
    container.className = `git-diff-renderer${descriptor.wrapLines ? " wrap-lines" : ""}`;
    const toolbar = document.createElement("header");
    toolbar.className = "git-diff-toolbar";
    const path = document.createElement("span");
    path.className = "git-diff-path";
    path.textContent = descriptor.displayPath || "Diff";
    path.title = descriptor.displayPath || "Diff";
    const comparison = document.createElement("span");
    comparison.className = "git-diff-comparison";
    const comparisonKey = descriptor.comparison || "changes";
    const comparisonLabel = t(`git.comparison.${comparisonKey}`);
    comparison.textContent = comparisonLabel;
    // The pill styling reads as a control, but this is a label: say what the
    // diff compares against instead of leaving the bare word to guesswork.
    const comparisonHint = t("git.comparisonHint", { kind: comparisonLabel });
    comparison.title = comparisonHint;
    comparison.setAttribute("aria-label", comparisonHint);
    toolbar.append(path, comparison);
    container.append(toolbar);

    const fallbackReason = descriptor.fallbackReason;
    if (fallbackReason || descriptor.truncated || descriptor.binary) {
      const fallback = document.createElement("section");
      fallback.className = "git-diff-fallback";
      const reason = document.createElement("p");
      reason.className = "git-diff-fallback-reason";
      reason.textContent =
        fallbackReason === "rename"
          ? t("git.fallback.rename")
          : fallbackReason === "copy"
            ? t("git.fallback.copy")
            : fallbackReason === "binary"
              ? t("git.fallback.binary")
              : fallbackReason || (descriptor.truncated ? "Diff is truncated" : "Raw patch");
      const pre = document.createElement("pre");
      pre.textContent = descriptor.rawPatch || "";
      fallback.append(reason, pre);
      container.append(fallback);
      return;
    }
    const rows = descriptor.rows || parsePatch(descriptor.patch || descriptor.rawPatch || "");
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "git-diff-empty";
      empty.textContent = t("git.diffEmpty");
      container.append(empty);
      return;
    }
    if (descriptor.unified !== false) {
      const unified = document.createElement("div");
      unified.className = `git-diff-unified${descriptor.wrapLines ? " wrap-lines" : ""}`;
      const patch = descriptor.patch || descriptor.rawPatch;
      if (patch) {
        for (const row of parseUnifiedPatch(patch)) {
          if (row.kind === "hunk") {
            const hunk = document.createElement("div");
            hunk.className = "git-diff-hunk";
            hunk.textContent = row.text;
            unified.append(hunk);
          } else {
            unified.append(
              createUnifiedLine({
                ...row,
                line: row.kind === "added" ? row.newLine : row.oldLine,
                filePath: descriptor.displayPath,
              }),
            );
          }
        }
      } else {
        for (const row of rows) {
          if (row.original?.kind === "unchanged" && row.current?.kind === "unchanged") {
            unified.append(createUnifiedLine({ ...row.current, filePath: descriptor.displayPath }));
            continue;
          }
          if (row.original?.kind === "removed")
            unified.append(
              createUnifiedLine({ ...row.original, filePath: descriptor.displayPath }),
            );
          if (row.current?.kind === "added")
            unified.append(createUnifiedLine({ ...row.current, filePath: descriptor.displayPath }));
        }
      }
      container.append(unified);
      return;
    }
    const columns = document.createElement("div");
    columns.className = `git-diff-columns${descriptor.wrapLines ? " wrap-lines" : ""}`;
    if (descriptor.wrapLines) {
      const headers = document.createElement("div");
      headers.className = "git-diff-column-headers";
      for (const label of ["Original", "Modified"]) {
        const header = document.createElement("div");
        header.className = "git-diff-column-header";
        header.textContent = label === "Original" ? t("git.diffOriginal") : t("git.diffModified");
        headers.append(header);
      }
      columns.append(headers);
      for (const row of rows) {
        const rowEl = document.createElement("div");
        rowEl.className = "git-diff-row";
        for (const cell of [row.original, row.current]) {
          rowEl.append(createDiffCell(cell, descriptor.displayPath));
        }
        columns.append(rowEl);
      }
      container.append(columns);
      return;
    }

    const original = document.createElement("div");
    const current = document.createElement("div");
    original.className = "git-diff-column git-diff-original";
    current.className = "git-diff-column git-diff-current";
    for (const [column, label] of [
      [original, "Original"],
      [current, "Modified"],
    ]) {
      const header = document.createElement("div");
      header.className = "git-diff-column-header";
      header.textContent = label === "Original" ? t("git.diffOriginal") : t("git.diffModified");
      column.append(header);
    }
    for (const row of rows) {
      original.append(createDiffCell(row.original, descriptor.displayPath));
      current.append(createDiffCell(row.current, descriptor.displayPath));
    }
    let syncing = false;
    let syncFrame = null;
    const syncScroll = (source, target) => {
      if (syncing || syncFrame !== null) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = null;
        syncing = true;
        target.scrollTop = source.scrollTop;
        syncing = false;
      });
    };
    original.addEventListener("scroll", () => syncScroll(original, current));
    current.addEventListener("scroll", () => syncScroll(current, original));
    columns.append(original, current);
    container.append(columns);
  };
  return {
    mount(container) {
      window.addEventListener("picot-preview-editor-theme-change", onThemeChange);
      render(container);
    },
    update(next) {
      descriptor = { ...descriptor, ...(next || {}) };
      if (root) render(root);
    },
    destroy() {
      window.removeEventListener("picot-preview-editor-theme-change", onThemeChange);
      root?.replaceChildren();
      root = null;
    },
  };
}
