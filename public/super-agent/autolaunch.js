import { isSuperAgentSessionSummary } from "./session.js";

export function selectSuperAgentSessionToLaunch({
  alreadyLaunched = false,
  enabled = false,
  sessions = [],
  currentSessionId = "",
} = {}) {
  if (alreadyLaunched || !enabled) return null;

  const currentSession = sessions.find((session) => session.id === currentSessionId);
  if (currentSession && isSuperAgentSessionSummary(currentSession)) return null;

  const superAgentSessions = sessions.filter((session) => isSuperAgentSessionSummary(session));
  if (superAgentSessions.length === 0) return null;

  return superAgentSessions.reduce((a, b) => ((a.timestamp ?? 0) >= (b.timestamp ?? 0) ? a : b));
}
