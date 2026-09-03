// ABOUTME: Resolves the exact native runtime selected by a prepared session transition.
// ABOUTME: Keeps same-workspace session switches in the current WebView.

export function resolvePreparedRuntimeTarget(instances, prepared) {
  const workspaceId = prepared?.targetWorkspaceId;
  const sessionId = prepared?.targetSessionId;
  if (!workspaceId || !sessionId) return null;
  return (
    instances?.find(
      (instance) =>
        instance?.workspaceId === workspaceId &&
        instance?.sessionId === sessionId &&
        typeof instance?.instanceId === "string" &&
        instance.instanceId,
    ) ?? null
  );
}
