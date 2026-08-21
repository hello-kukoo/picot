// ABOUTME: Pure helpers for session-port routing, mirror-sync scoping, and workspace transitions.
// ABOUTME: Gating predicates determine when cross-workspace file loads and UI updates must be deferred.

export function findPortForSession(instances, sessionFile, fallbackPort) {
  const match = Array.isArray(instances)
    ? instances.find((instance) => instance?.sessionFile === sessionFile)
    : null;
  return typeof match?.port === "number" ? match.port : fallbackPort;
}

export function getWorkspacePathForPort(instances, port) {
  const match = Array.isArray(instances)
    ? instances.find((instance) => instance?.port === port)
    : null;
  return match?.cwd || "";
}

export function shouldSpawnForCrossWorkspaceSelection(
  instances,
  foregroundPort,
  selectedProjectPath,
) {
  if (!selectedProjectPath) return false;
  const foregroundCwd = getWorkspacePathForPort(instances, foregroundPort);
  return Boolean(foregroundCwd && foregroundCwd !== selectedProjectPath);
}

export function isForegroundMirrorSync(syncPort, foregroundPort) {
  return !(
    typeof syncPort === "number" &&
    typeof foregroundPort === "number" &&
    syncPort !== foregroundPort
  );
}

export function isExpectedMirrorSession(expectedSessionFile, receivedSessionFile) {
  return (
    typeof expectedSessionFile !== "string" ||
    !expectedSessionFile ||
    expectedSessionFile === receivedSessionFile
  );
}

export function applyForegroundMirrorSession({
  syncPort,
  foregroundPort,
  sessionFile,
  expectedSessionFile = null,
  setMirrorActiveSessionFile,
  setSidebarActive,
}) {
  if (
    !isForegroundMirrorSync(syncPort, foregroundPort) ||
    !isExpectedMirrorSession(expectedSessionFile, sessionFile)
  ) {
    return false;
  }

  const activeSessionFile = sessionFile || null;
  setMirrorActiveSessionFile(activeSessionFile);
  if (activeSessionFile) setSidebarActive(activeSessionFile);
  return true;
}

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
 * During a cross-workspace session switch the embedded server is still scoped
 * to the previous workspace until its replacement extension emits the mirror
 * snapshot that confirms the new session. Any `/api/files?scope=workspace`
 * request in that window resolves the requested path against the stale root
 * and returns 403. `pendingFileBrowserWorkspace` marks that window; while it is
 * set, callers (poll, toggle, select, activate) must defer — the authoritative
 * load fires from the mirror-sync handler.
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
 * 3. Current port does not match the loaded file browser port
 */
export function shouldSuppressFileBrowserRefresh({
  pendingWorkspace,
  currentWorkspacePath,
  fileBrowserWorkspacePath,
  currentPort,
  fileBrowserWorkspacePort,
} = {}) {
  if (shouldSuppressFileBrowserLoad(pendingWorkspace)) return true;
  const currentNormalized =
    typeof currentWorkspacePath === "string" ? currentWorkspacePath.trim() : "";
  const loadedNormalized =
    typeof fileBrowserWorkspacePath === "string" ? fileBrowserWorkspacePath.trim() : "";
  if (loadedNormalized && currentNormalized && loadedNormalized !== currentNormalized) {
    return true;
  }
  if (
    fileBrowserWorkspacePort != null &&
    currentPort != null &&
    fileBrowserWorkspacePort !== currentPort
  ) {
    return true;
  }
  return false;
}
