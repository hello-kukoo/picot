// ABOUTME: Pure helpers for session-port routing, mirror-sync scoping, and workspace transitions.
// ABOUTME: Gating predicates determine when cross-workspace file loads and UI updates must be deferred.

export function deferFileBrowserWorkspace(sessionFile, projectPath, currentWorkspacePath) {
  if (typeof projectPath !== "string" || !projectPath || projectPath === currentWorkspacePath) {
    return null;
  }
  // sessionFile may be null for a brand-new session whose file isn't assigned
  // until pi's first session_start; in that case confirmation matches any
  // foreground mirror_sync (the caller already gates on foreground port).
  return {
    sessionFile: typeof sessionFile === "string" && sessionFile ? sessionFile : null,
    path: projectPath,
  };
}

export function confirmDeferredFileBrowserWorkspace(pendingWorkspace, sessionFile) {
  if (!pendingWorkspace) return null;
  // A deferred token with a specific sessionFile must match the incoming
  // snapshot's sessionFile. A null sessionFile (new-session activation) matches
  // any foreground mirror_sync — handleMirrorSync only reaches here after the
  // foreground-port gate, so the snapshot belongs to the activation's process.
  if (pendingWorkspace.sessionFile !== null) {
    if (typeof sessionFile !== "string" || pendingWorkspace.sessionFile !== sessionFile) {
      return null;
    }
  }
  return pendingWorkspace;
}

/**
 * Whether a workspace-scoped file browser load should be deferred right now.
 * During a cross-workspace session switch the host is still scoped to the
 * previous workspace until its replacement runtime emits the mirror snapshot
 * that confirms the new session. Any workspace file request in that window
 * could resolve against the stale root and return 403. `pendingFileBrowserWorkspace`
 * marks that window; while it is set, callers (poll, toggle, select, activate)
 * must defer — the authoritative load fires from the mirror-sync handler.
 */
export function shouldSuppressFileBrowserLoad(pendingWorkspace) {
  return pendingWorkspace != null;
}

/**
 * Whether a debounced or background file browser refresh should be suppressed.
 * Refreshing with an absolute path during a cross-workspace switch or port
 * transition causes 403 outsideWorkspace against the wrong server. Suppress if:
 * 1. A cross-workspace switch is pending (pendingWorkspace is active)
 * 2. Current workspace path does not match the loaded file browser workspace
 * 3. Current workspace path does not match loaded file browser path
 */
export function shouldSuppressFileBrowserRefresh({
  pendingWorkspace,
  currentWorkspacePath,
  fileBrowserWorkspacePath,
} = {}) {
  if (shouldSuppressFileBrowserLoad(pendingWorkspace)) return true;
  const currentNormalized =
    typeof currentWorkspacePath === "string" ? currentWorkspacePath.trim() : "";
  const loadedNormalized =
    typeof fileBrowserWorkspacePath === "string" ? fileBrowserWorkspacePath.trim() : "";
  if (loadedNormalized && currentNormalized && loadedNormalized !== currentNormalized) {
    return true;
  }
  return false;
}
