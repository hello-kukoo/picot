// ABOUTME: Browser/office annotation attachments (spec 2026-09-22): two
// ABOUTME: formatted prompt blocks plus the comment dialog that feeds them.

import { t } from "../i18n.js";

const KEY_STYLE_KEYS = ["display", "position", "font-size", "color", "background-color"];

function truncateText(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function keyStyles(computedStyles) {
  return Object.entries(computedStyles || {})
    .filter(([key]) => KEY_STYLE_KEYS.includes(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

/** Paseo's proven generic-web format: identity, geometry, key styles,
 * ancestry, the user's comment, and truncated HTML for final disambiguation. */
export function formatBrowserElementAttachment(selection, comment) {
  const parts = [];
  if (selection.reactSource?.fileName) {
    const loc = [
      selection.reactSource.fileName,
      selection.reactSource.lineNumber != null ? `:${selection.reactSource.lineNumber}` : "",
      selection.reactSource.columnNumber != null ? `:${selection.reactSource.columnNumber}` : "",
    ].join("");
    parts.push(`source: ${selection.reactSource.componentName ?? selection.tag} @ ${loc}`);
  }
  parts.push(`selector: ${selection.selector}`);
  const textPreview = (selection.text || "").trim().split("\n")[0];
  if (textPreview) parts.push(`text: ${JSON.stringify(truncateText(textPreview, 200))}`);
  parts.push(`size: ${selection.boundingRect.width}x${selection.boundingRect.height}`);
  const styles = keyStyles(selection.computedStyles);
  if (styles) parts.push(`styles: ${styles}`);
  if (selection.parentChain?.length) {
    parts.push(`parents: ${selection.parentChain.slice(0, 3).join(" > ")}`);
  }
  const trimmedComment = (comment || "").trim();
  if (trimmedComment) parts.push(`feedback: ${trimmedComment}`);
  return [
    `<browser-element url="${selection.url}">`,
    ...parts.map((part) => `  ${part}`),
    `  html: ${truncateText(selection.outerHTML || "", 1200)}`,
    `</browser-element>`,
  ].join("\n");
}

/** Office format: the docPath is an executable officecli coordinate, so the
 * agent can edit the document directly instead of guessing from DOM shape.
 * `suggested` is a hint; the agent picks the actual command. */
export function formatOfficeElementAttachment(selection, comment, file) {
  const parts = [`path: ${selection.docPath}`, `selector: [data-path="${selection.docPath}"]`];
  const textPreview = (selection.text || "").trim().split("\n")[0];
  if (textPreview) parts.push(`text: ${JSON.stringify(truncateText(textPreview, 200))}`);
  const styles = keyStyles(selection.computedStyles);
  if (styles) parts.push(`styles: ${styles}`);
  const trimmedComment = (comment || "").trim();
  if (trimmedComment) parts.push(`feedback: ${trimmedComment}`);
  parts.push(`suggested: officecli set ${file} ${selection.docPath} --prop <prop>=<value>`);
  return [
    `<office-element file="${file}">`,
    ...parts.map((part) => `  ${part}`),
    `</office-element>`,
  ].join("\n");
}

/** The comment card injected INTO the pane page. The native child webview
 * always paints above host DOM, so a host-side dialog can only ever sit in a
 * reserved strip outside the page (ugly) — Paseo instead floats a centered
 * card over the page bottom, and inside the page is the only place Picot
 * can do the same. Marker protocol with the host: `__picotAnnotationResult`
 * starts undefined (pending), `{comment}` once settled, and a reloaded page
 * (watch refresh) drops `__picotAnnotationAlive` so the host can cancel. */
export function buildPageAnnotationScript({
  title,
  meta,
  placeholder,
  cancelLabel,
  submitLabel,
  accent,
}) {
  const args = JSON.stringify({
    title,
    meta,
    placeholder,
    cancelLabel,
    submitLabel,
    accent: accent || "#18181b",
  });
  return `(() => {
  const L = ${args};
  document.getElementById("picot-annotation-card")?.remove();
  window.__picotAnnotationResult = undefined;
  window.__picotAnnotationAlive = true;
  const card = document.createElement("div");
  card.id = "picot-annotation-card";
  card.setAttribute("role", "dialog");
  card.style.cssText = [
    "position:fixed", "left:50%", "transform:translateX(-50%)", "bottom:12px",
    "z-index:2147483647", "width:min(420px, calc(100vw - 24px))", "box-sizing:border-box",
    "padding:12px", "border:1px solid #d4d4d8", "border-radius:12px", "background:#fff",
    "color:#18181b", "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 6px 16px rgba(0,0,0,0.18)",
  ].join(";");
  const cssText = (extra) => extra.join(";");
  const head = document.createElement("div");
  head.style.cssText = cssText(["display:flex", "align-items:center", "gap:8px"]);
  const h = document.createElement("div");
  h.textContent = L.title;
  h.style.cssText = cssText(["flex:1", "font-weight:600"]);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\\u00d7";
  close.style.cssText = cssText([
    "border:none", "background:none", "font-size:16px", "cursor:pointer", "color:#71717a",
  ]);
  head.append(h, close);
  const metaEl = document.createElement("div");
  metaEl.textContent = L.meta;
  metaEl.style.cssText = cssText([
    "margin:6px 0", "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
    "color:#71717a", "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
  ]);
  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = L.placeholder;
  input.style.cssText = cssText([
    "width:100%", "box-sizing:border-box", "margin:0 0 10px", "padding:8px",
    "border:1px solid #d4d4d8", "border-radius:8px", "font:13px/1.45 inherit",
    "color:inherit", "background:#fff", "resize:vertical",
  ]);
  const actions = document.createElement("div");
  actions.style.cssText = cssText(["display:flex", "justify-content:flex-end", "gap:8px"]);
  const btn = (text, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = cssText([
      // Mirrors Picot's .file-preview-dialog-button geometry, with the
      // live theme accent the host reads and injects (the page cannot see
      // the app's CSS variables).
      "padding:6px 12px", "border-radius:6px", "cursor:pointer", "font:inherit",
      primary
        ? "border:1px solid " + L.accent + ";background:" + L.accent + ";color:#fff"
        : "border:1px solid rgba(0,0,0,0.14);background:rgba(0,0,0,0.03);color:rgba(0,0,0,0.88)",
    ]);
    return b;
  };
  const cancel = btn(L.cancelLabel, false);
  const submit = btn(L.submitLabel, true);
  actions.append(cancel, submit);
  card.append(head, metaEl, input, actions);
  const finish = (comment) => {
    window.__picotAnnotationResult = { comment };
    document.removeEventListener("keydown", onKey, true);
    card.remove();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      finish(input.value);
    }
  };
  document.addEventListener("keydown", onKey, true);
  close.addEventListener("click", () => finish(null));
  cancel.addEventListener("click", () => finish(null));
  submit.addEventListener("click", () => finish(input.value));
  document.body.appendChild(card);
  input.focus();
  return "ok";
})()`;
}

/** Run the page-injected card and poll its marker. Resolves with the comment
 * or null (cancel / pane gone / page reloaded). */
export async function openPageAnnotationDialog({ paneId, evaluate, docPath, url } = {}) {
  // The page cannot read the app's CSS variables; carry the live accent over
  // so the card's primary button always matches the active Picot theme.
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const labels = {
    title: t("files.browser.dialogTitle"),
    meta: docPath ? `${docPath} — ${url || ""}` : url || "",
    placeholder: t("files.browser.dialogPlaceholder"),
    cancelLabel: t("files.browser.cancel"),
    submitLabel: t("files.browser.addToComposer"),
    accent,
  };
  try {
    await evaluate(paneId, buildPageAnnotationScript(labels));
  } catch {
    return null; // the pane is gone or refusing evals; nothing to annotate over
  }
  const pollExpr =
    "(() => { if (window.__picotAnnotationAlive !== true) return 'gone'; " +
    "const r = window.__picotAnnotationResult; return r === undefined ? 'pending' : r.comment; })()";
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    let state;
    try {
      state = await evaluate(paneId, pollExpr);
    } catch {
      return null;
    }
    if (state === "gone") return null;
    if (state !== "pending") return state ?? null;
  }
  return null;
}

/** Append the formatted block into the composer so the user can review and
 * edit it before sending — same channel as typed prompts, zero new plumbing. */
export function appendAttachmentToComposer(block) {
  const input = document.getElementById("message-input");
  if (!input) return false;
  const prefix = input.value && !input.value.endsWith("\n\n") ? "\n\n" : "";
  input.value = `${input.value}${prefix}${block}\n`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  return true;
}
