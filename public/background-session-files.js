// ABOUTME: Resolves background runtime events to the sidebar's jsonl session keys.
// ABOUTME: pi native events carry only the route sessionId; sidebar rows are keyed by sessionFile.

export function createBackgroundSessionFiles() {
  const bySessionId = new Map();

  return {
    remember(target, sessionFile) {
      const sessionId = typeof target?.sessionId === "string" ? target.sessionId : "";
      if (!sessionId || typeof sessionFile !== "string" || !sessionFile) return;
      bySessionId.set(sessionId, sessionFile);
    },
    rememberInstance(instance) {
      this.remember(instance, instance?.sessionFile);
    },
    resolve(target) {
      const sessionId = typeof target?.sessionId === "string" ? target.sessionId : "";
      if (!sessionId) return null;
      return bySessionId.get(sessionId) || null;
    },
  };
}
