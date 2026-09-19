// ABOUTME: Composer session identity: one stable key per authoring target.
// ABOUTME: Shared by the prompt-delivery records and the per-session draft store.

/**
 * Resolve the composer's current session identity.
 *
 * Precedence mirrors the send path: the persisted UI session file (the
 * authoritative session record) wins; a live runtime target identifies a
 * fresh session that has not persisted yet; anything else is the
 * not-yet-materialised authoring target (landing/global draft) and gets a
 * distinct key so it can never leak into a registered session.
 */
export function resolveComposerSessionIdentity({
  activeUiSessionFile,
  runtimeTarget,
  authoringKey = "authoring:new",
} = {}) {
  if (typeof activeUiSessionFile === "string" && activeUiSessionFile.trim()) {
    return `file:${activeUiSessionFile}`;
  }
  if (runtimeTarget?.workspaceId && runtimeTarget?.sessionId) {
    return `runtime:${runtimeTarget.workspaceId}/${runtimeTarget.sessionId}`;
  }
  return authoringKey;
}
