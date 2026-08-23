import { selectSuperAgentSessionToLaunch } from "./autolaunch.js";
import { isSuperAgentSessionSummary } from "./session.js";

export function hasSuperAgentSession(sessions = []) {
  return (sessions ?? []).some((session) => isSuperAgentSessionSummary(session));
}

export function selectSuperAgentStartupAction({
  enabled = false,
  sessions = [],
  currentSessionId = "",
  alreadyLaunched = false,
} = {}) {
  if (!enabled) return { type: "none" };
  if (!hasSuperAgentSession(sessions)) return { type: "ensure" };

  const session = selectSuperAgentSessionToLaunch({
    alreadyLaunched,
    enabled,
    sessions,
    currentSessionId,
  });
  return session ? { type: "launch", session } : { type: "none" };
}
