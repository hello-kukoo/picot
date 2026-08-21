// ABOUTME: Opens or refreshes the file preview when the agent writes a file.
// ABOUTME: Maps write-tool arguments onto workspace-relative preview paths.

import { normalizeLocalPath } from "./workspace/path-utils.js";

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "str_replace", "search_replace"]);

export function isWriteTool(toolName) {
  return WRITE_TOOLS.has(String(toolName || "").toLowerCase());
}

export function pathFromToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file_path", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Turn a tool path into the workspace-absolute normalized path that
 * FilePreviewPanel.openFile expects. Returning the absolute form (instead of
 * stripping the workspace root) keeps the follow/reveal path identical to the
 * id a workspace browser-open produces, so a write reloads the live preview
 * tab instead of creating a duplicate relative one. Absolute paths outside the
 * workspace are rejected; a bare relative path is joined to the workspace root.
 */
export function toPreviewPath(rawPath, workspaceRoot = "") {
  const normalized = normalizeLocalPath(rawPath);
  if (!normalized) return "";
  const root = normalizeLocalPath(workspaceRoot);
  if (root) {
    if (normalized === root) return "";
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (normalized.startsWith(prefix)) return normalized;
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.startsWith("//")
    ) {
      return "";
    }
    return `${root}/${normalized}`;
  }
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    return "";
  }
  return normalized;
}

export function shouldFollowWrite(event, pendingPath = "") {
  if (!event || event.isError) return false;
  const path = pathFromToolArgs(event.args) || pendingPath;
  if (!path) return false;
  if (event.toolName && !isWriteTool(event.toolName) && !pendingPath) return false;
  return true;
}

export function createFilePreviewFollow({ panel, getWorkspacePath, onWriteApplied } = {}) {
  const pending = new Map();

  async function resolvePreviewPath(rawPath) {
    const root =
      (typeof getWorkspacePath === "function" ? await getWorkspacePath() : "") ||
      panel?.workspaceRoot ||
      "";
    return toPreviewPath(rawPath, root);
  }

  return {
    onToolStart(event) {
      if (!isWriteTool(event?.toolName)) return;
      const path = pathFromToolArgs(event.args);
      if (path && event.toolCallId) pending.set(event.toolCallId, path);
    },

    async onToolEnd(event) {
      const remembered = event?.toolCallId ? pending.get(event.toolCallId) : "";
      if (event?.toolCallId) pending.delete(event.toolCallId);
      if (!shouldFollowWrite(event, remembered)) return null;
      const raw = pathFromToolArgs(event.args) || remembered;
      const previewPath = await resolvePreviewPath(raw);
      if (!previewPath) return null;
      const tab = panel ? await panel.revealWrite(previewPath) : null;
      // Notify after the write is known to be inside the workspace, whether or
      // not a preview panel is attached (e.g. the file browser refreshes from
      // the same signal).
      if (typeof onWriteApplied === "function") onWriteApplied(raw, previewPath);
      return tab;
    },

    async openPath(rawPath) {
      if (!panel) return null;
      const previewPath = await resolvePreviewPath(rawPath);
      if (!previewPath) return null;
      return panel.openFile(previewPath);
    },

    clear() {
      pending.clear();
    },
  };
}
