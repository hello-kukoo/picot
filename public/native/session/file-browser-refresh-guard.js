// ABOUTME: Pure gating predicates for deferred cross-workspace UI updates.
// ABOUTME: Ported from v3 e2567dd — prevents stale-path loads during switches.

/**
 * Whether a debounced or background file browser refresh should be
 * suppressed. Refreshing with an old relative path during a workspace switch
 * resolves against the wrong workspace and fails (403 outsideWorkspace).
 * Suppress when:
 * 1. A cross-workspace switch is still pending (`pendingWorkspaceId` set)
 * 2. The loaded listing belongs to a different workspace than the current one
 *
 * A missing side (`null`) means "not loaded yet" and never suppresses on its
 * own; an explicit empty string means "transition in flight" and does.
 */
export function shouldSuppressFileBrowserRefresh({
  pendingWorkspaceId = null,
  currentWorkspaceId,
  fileBrowserWorkspaceId,
} = {}) {
  if (pendingWorkspaceId != null) return true;
  const currentNormalized = typeof currentWorkspaceId === "string" ? currentWorkspaceId.trim() : "";
  const loadedNormalized =
    typeof fileBrowserWorkspaceId === "string" ? fileBrowserWorkspaceId.trim() : "";
  if (loadedNormalized && currentNormalized && loadedNormalized !== currentNormalized) {
    return true;
  }
  return false;
}
