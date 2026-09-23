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

/** Comment box: plain textarea over the shared file-preview dialog styling.
 * Resolves with the comment (possibly empty) or null on cancel.
 *
 * It mounts inline in `container` (the pane's content area) rather than as a
 * window-wide modal: the page is hidden while the box is up, so the comment
 * takes the page's place instead of dimming everything else. */
export function openAnnotationDialog({ docPath, url, container, onMount } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("div");
    dialog.className = "file-preview-dialog browser-annotation-card";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", t("files.browser.dialogTitle"));

    const heading = document.createElement("h3");
    heading.textContent = t("files.browser.dialogTitle");
    const meta = document.createElement("p");
    meta.className = "browser-annotation-meta";
    meta.textContent = docPath ? `${docPath} — ${url || ""}` : url || "";
    const textarea = document.createElement("textarea");
    textarea.className = "browser-annotation-input";
    textarea.rows = 3;
    textarea.placeholder = t("files.browser.dialogPlaceholder");
    const actions = document.createElement("div");
    actions.className = "file-preview-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "file-preview-dialog-button";
    cancel.textContent = t("files.browser.cancel");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "file-preview-dialog-button primary";
    confirm.textContent = t("files.browser.addToComposer");
    actions.append(cancel, confirm);
    dialog.append(heading, meta, textarea, actions);
    (container ?? document.body).appendChild(dialog);
    // Hand the mounted card to the caller: the pane reserves space from the
    // card's measured height, so it must exist in the DOM first.
    onMount?.(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      dialog.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) finish(textarea.value);
    };
    document.addEventListener("keydown", onKeyDown);
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => finish(textarea.value));
    textarea.focus();
  });
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
