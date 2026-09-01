// ABOUTME: Opens or refreshes the file preview when the agent writes a file.
// ABOUTME: Maps write-tool arguments onto workspace-relative preview paths.

import { normalizeLocalPath } from "../../workspace/path-utils.js";

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
 * Turn a tool path into the workspace-relative path FilePreviewPanel.openFile
 * expects. Absolute paths outside the workspace are rejected.
 */
export function toPreviewPath(rawPath, workspaceRoot = "") {
  const normalized = normalizeLocalPath(rawPath);
  if (!normalized) return "";
  const root = normalizeLocalPath(workspaceRoot);
  if (root) {
    if (normalized === root) return "";
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.startsWith("//")
    ) {
      return "";
    }
    return normalized;
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

  async function resolveRelative(rawPath) {
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
      const previewPath = await resolveRelative(raw);
      if (!previewPath) return null;
      const tab = panel ? await panel.revealWrite(previewPath) : null;
      // Notify after the write is known to be inside the workspace, whether
      // or not a preview panel is attached (turn chips collect from this).
      if (typeof onWriteApplied === "function") onWriteApplied(raw, previewPath);
      return tab;
    },

    async openPath(rawPath) {
      if (!panel) return null;
      const relative = await resolveRelative(rawPath);
      if (!relative) return null;
      return panel.openFile(relative);
    },

    clear() {
      pending.clear();
    },
  };
}
