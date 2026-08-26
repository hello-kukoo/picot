// ABOUTME: Builds stable workspace identities and merges Pi history with live instances.
// ABOUTME: Resolves ordered workspace groups for workspace Pins.

import { basenameLocalPath, normalizeLocalPath } from "./workspace/path-utils.js";

export function normalizeWorkspacePath(value) {
  const normalized = normalizeLocalPath(value);
  const isAbsolute =
    normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized);
  return isAbsolute ? normalized : "";
}

export function workspacePathKey(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return "";
  return normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}
export function historyWorkspaceId(project) {
  return typeof project?.dirName === "string" && project.dirName
    ? `history:${project.dirName}`
    : "";
}
export function provisionalWorkspaceId(path) {
  const normalized = workspacePathKey(path);
  return normalized ? `path:${normalized}` : "";
}
const time = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const sessionTime = (s) => {
  const modified = Number(s?.mtime);
  if (Number.isFinite(modified)) return modified;
  return Math.max(time(s?.timestamp), Number(s?.ctime) || 0);
};
function latestActivity(sessions, instances) {
  let latest = 0;
  for (const session of sessions) latest = Math.max(latest, sessionTime(session));
  for (const instance of instances) latest = Math.max(latest, time(instance?.startedAt));
  return latest;
}
function folderName(path) {
  return basenameLocalPath(path) || String(path || "");
}

export function mergeWorkspaceProjects(
  historyProjects = [],
  runningInstances = [],
  previousProjects = [],
) {
  const byPath = new Map();
  const liveByPath = new Map();
  for (const instance of Array.isArray(runningInstances) ? runningInstances : []) {
    const path = normalizeWorkspacePath(instance?.cwd);
    const key = workspacePathKey(path);
    if (!key) continue;
    const list = liveByPath.get(key) || [];
    list.push({ ...instance, cwd: path });
    liveByPath.set(key, list);
  }
  for (const project of Array.isArray(historyProjects) ? historyProjects : []) {
    const path = normalizeWorkspacePath(project?.path);
    const key = workspacePathKey(path);
    const workspaceId = historyWorkspaceId(project);
    if (!key || !workspaceId) continue;
    const sessions = Array.isArray(project.sessions) ? project.sessions : [];
    const instances = liveByPath.get(key) || [];
    const activityAt = latestActivity(sessions, instances);
    byPath.set(key, {
      workspaceId,
      path: project.path,
      folderName: folderName(project.path),
      dirName: project.dirName,
      sessions,
      runningInstances: instances,
      isProvisional: false,
      source: "history",
      activityAt,
      lastActivityAt: activityAt,
    });
  }
  for (const [path, instances] of liveByPath) {
    if (byPath.has(path)) continue;
    const activityAt = latestActivity([], instances);
    const displayPath = instances[0]?.cwd || path;
    byPath.set(path, {
      workspaceId: provisionalWorkspaceId(displayPath),
      path: displayPath,
      folderName: folderName(displayPath),
      dirName: "",
      sessions: [],
      runningInstances: instances,
      isProvisional: true,
      source: "live",
      activityAt,
      lastActivityAt: activityAt,
    });
  }
  const projects = [...byPath.values()].sort(
    (a, b) => b.activityAt - a.activityAt || a.workspaceId.localeCompare(b.workspaceId),
  );
  const previous = new Map(
    (Array.isArray(previousProjects) ? previousProjects : []).map((project) => [
      workspacePathKey(project.path),
      project,
    ]),
  );
  const reconciliations = [];
  for (const project of projects) {
    const old = previous.get(workspacePathKey(project.path));
    if (old?.isProvisional && !project.isProvisional && old.workspaceId !== project.workspaceId)
      reconciliations.push({
        fromId: old.workspaceId,
        toId: project.workspaceId,
        path: project.path,
      });
  }
  if (reconciliations.length) {
    const indexes = new Map(projects.map((p, i) => [p.workspaceId, i]));
    for (const reconciliation of reconciliations) {
      const old = previous.get(workspacePathKey(reconciliation.path));
      const targetIndex = indexes.get(reconciliation.toId);
      const priorIndex = [...(previousProjects || [])].findIndex(
        (p) => p.workspaceId === old.workspaceId,
      );
      if (targetIndex >= 0 && priorIndex >= 0) {
        const [row] = projects.splice(targetIndex, 1);
        projects.splice(Math.min(priorIndex, projects.length), 0, row);
      }
    }
  }
  return { projects, reconciliations };
}

export function workspaceModelSignature(projects = []) {
  return JSON.stringify(
    projects
      .map((p) => ({
        id: p.workspaceId,
        path: p.path,
        activityAt: p.activityAt,
        sessions: (p.sessions || []).map((s) => [s.filePath, s.name, s.timestamp]),
        instances: (p.runningInstances || []).map((i) => [i.port, i.sessionFile, i.startedAt]),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function resolvePinnedWorkspaceGroups({ pinState = {}, projects = [] } = {}) {
  const byId = new Map(projects.map((p) => [p.workspaceId, p]));
  const byPath = new Map(projects.map((p) => [workspacePathKey(p.path), p]));
  const groups = [];
  const owned = new Set();
  for (const pin of Array.isArray(pinState.workspaces) ? pinState.workspaces : []) {
    const project = byId.get(pin.id) || byPath.get(workspacePathKey(pin.path));
    if (!project) {
      groups.push({
        workspace: { workspaceId: pin.id, path: pin.path, sessions: [], unavailable: true },
        workspacePin: true,
        sessions: [],
        unavailable: true,
      });
      continue;
    }
    owned.add(project.workspaceId);
    groups.push({
      workspace: project,
      workspacePin: true,
      sessions: project.sessions || [],
      unavailable: false,
    });
  }
  return groups;
}
