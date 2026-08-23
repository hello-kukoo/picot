const SUPER_AGENT_KIND = "super-agent";
const SUPER_AGENT_NAME = "Agent Inbox";
const SUPER_AGENT_PATH_SUFFIX = "/.pi/agent/super-agent";

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function sessionTime(session) {
  const time = Date.parse(session?.timestamp || "");
  return Number.isFinite(time) ? time : 0;
}

function sessionPriority(session) {
  if (session?.chatConnected === true) return 2;
  if (session?.isRunning === true) return 1;
  return 0;
}

export function isSuperAgentProjectPath(projectPath, superAgentPath) {
  if (!projectPath) return false;
  const normalizedProjectPath = normalizePath(projectPath);
  if (!superAgentPath) return normalizedProjectPath.endsWith(SUPER_AGENT_PATH_SUFFIX);
  return normalizedProjectPath === normalizePath(superAgentPath);
}

export function normalizeSuperAgentSession(project) {
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  if (sessions.length === 0) return null;

  const latest = [...sessions].sort((a, b) => {
    const priorityDelta = sessionPriority(b) - sessionPriority(a);
    if (priorityDelta !== 0) return priorityDelta;
    return sessionTime(b) - sessionTime(a);
  })[0];
  if (!latest?.filePath) return null;

  return {
    ...latest,
    kind: SUPER_AGENT_KIND,
    name: SUPER_AGENT_NAME,
  };
}

export function getSuperAgentProject(projects, superAgentPath) {
  const project = (Array.isArray(projects) ? projects : []).find((candidate) =>
    isSuperAgentProjectPath(candidate?.path, superAgentPath),
  );
  if (!project) return null;

  const session = normalizeSuperAgentSession(project);
  if (!session) return null;

  return {
    project: {
      ...project,
      kind: SUPER_AGENT_KIND,
      dirName: SUPER_AGENT_NAME,
    },
    session,
  };
}

function addPort(ports, value) {
  const port = Number(value);
  if (Number.isFinite(port) && port > 0) ports.add(port);
}

export function getRunningSuperAgentPorts({ projects, instances, superAgentPath } = {}) {
  const ports = new Set();
  const superAgent = getSuperAgentProject(projects, superAgentPath);
  if (superAgent?.session?.isRunning === true) {
    addPort(ports, superAgent.session.port);
  }

  for (const instance of Array.isArray(instances) ? instances : []) {
    if (isSuperAgentProjectPath(instance?.cwd, superAgentPath)) {
      addPort(ports, instance?.port);
    }
  }

  return [...ports];
}

export function isSuperAgentSessionSummary(session, superAgentPath) {
  if (!session) return false;
  return (
    session.kind === SUPER_AGENT_KIND ||
    isSuperAgentProjectPath(session.projectPath || session.cwd, superAgentPath)
  );
}

export function isSuperAgentSession(session, project, superAgentPath) {
  return (
    isSuperAgentSessionSummary(session, superAgentPath) ||
    project?.kind === SUPER_AGENT_KIND ||
    isSuperAgentProjectPath(project?.path, superAgentPath)
  );
}

/**
 * Session that should drive the Agent Inbox chrome (sidebar entry + chat
 * header) for this window.
 *
 * Saved inbox sessions are matched by id. Temporary runtimes in the inbox
 * workspace are not in the saved list, so fall back to an inbox session
 * tagged as the current workspace — otherwise the window header stays on
 * the regular project chrome after enable/refresh.
 */
export function resolveSuperAgentActiveSession(sessions = [], sessionId = "") {
  const list = Array.isArray(sessions) ? sessions : [];
  const current = list.find((session) => session?.id === sessionId) ?? null;
  if (isSuperAgentSessionSummary(current)) return current;
  if (current) return current;
  return (
    list.find(
      (session) => isSuperAgentSessionSummary(session) && session.isCurrentWorkspace === true,
    ) ?? null
  );
}
