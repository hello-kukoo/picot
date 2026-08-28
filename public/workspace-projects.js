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

/**
 * Merge DB-registered workspaces (workspace.list rows) with live Pi
 * instances. Registry order (pinned DESC, last_opened_at DESC from SQL) is
 * preserved verbatim; live-only instances become provisional rows appended
 * after registered ones. Sessions arrive lazily per expanded row.
 */
// Bucket directory name for a session file path (the `--work-live--` segment
// under ~/.pi/agent/sessions). Handles POSIX and Windows separators; returns
// "" when no parent segment exists.
function sessionFileBucketName(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile) return "";
  const normalized = sessionFile.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  const parent = normalized.slice(0, slash);
  const parentSlash = parent.lastIndexOf("/");
  return parentSlash >= 0 ? parent.slice(parentSlash + 1) : parent;
}

// Running instances rendered as clickable session rows (the client-side
// counterpart of the retired server-wide mergeLiveInstanceSessions).
function runningInstanceSessions(instances) {
  const sessions = [];
  for (const instance of Array.isArray(instances) ? instances : []) {
    const sessionFile = instance?.sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) continue;
    const normalized = sessionFile.replace(/\\/g, "/");
    const file = normalized.slice(normalized.lastIndexOf("/") + 1);
    const startedMs = instance.startedAt ? new Date(instance.startedAt).getTime() : Date.now();
    const stamp = Number.isFinite(startedMs) ? startedMs : Date.now();
    sessions.push({
      file,
      filePath: sessionFile,
      cwd: instance.cwd || "",
      timestamp: instance.startedAt || new Date().toISOString(),
      mtime: stamp,
      ctime: stamp,
      port: instance.port ?? null,
      pid: instance.pid ?? null,
      isRunning: true,
      startedAt: instance.startedAt,
    });
  }
  return sessions;
}

// Give a workspace row its running instances as visible session items so
// unregistered live windows are never rendered as empty 0-count zombies,
// and derive the sessions bucket name for click navigation before the lazy
// endpoint load stamps the authoritative value.
function attachLiveSessions(row) {
  if (!row || !Array.isArray(row.runningInstances)) return;
  const live = runningInstanceSessions(row.runningInstances);
  if (live.length === 0) return;
  const known = new Set(
    (Array.isArray(row.sessions) ? row.sessions : [])
      .map((session) => session?.filePath)
      .filter(Boolean),
  );
  row.sessions = [...live.filter((session) => !known.has(session.filePath)), ...row.sessions];
  if (!row.dirName) row.dirName = sessionFileBucketName(live[0].filePath) || row.dirName;
}

export function mergeRegistryWorkspaces(
  registryRows = [],
  runningInstances = [],
  previousProjects = [],
) {
  const byKey = new Map();
  const pathKeys = [];
  const liveByPath = new Map();
  for (const instance of Array.isArray(runningInstances) ? runningInstances : []) {
    const path = normalizeWorkspacePath(instance?.cwd);
    const key = workspacePathKey(path);
    if (!key) continue;
    const list = liveByPath.get(key) || [];
    list.push({ ...instance, cwd: path });
    liveByPath.set(key, list);
  }

  for (const row of Array.isArray(registryRows) ? registryRows : []) {
    // The Rust layer serializes with rename_all = "camelCase"; no snake_case
    // fallback exists on the wire.
    const path = normalizeWorkspacePath(row?.canonicalPath);
    if (!path) continue;
    const key = workspacePathKey(path);
    if (byKey.has(key)) continue;
    const instances = liveByPath.get(key) || [];
    const lastOpenedMs = Number(row.lastOpenedAt ?? 0) * 1000;
    const activityAt = Math.max(
      Number.isFinite(lastOpenedMs) ? lastOpenedMs : 0,
      latestActivity([], instances),
    );
    byKey.set(key, {
      // Registry identity is the DB UUID; stable across machines/renames.
      workspaceId: `ws:${row.workspaceId}`,
      registryId: String(row.workspaceId),
      pinned: Boolean(row.pinned),
      path,
      folderName: row.displayName || folderName(path),
      dirName: null,
      sessions: [],
      runningInstances: instances,
      isProvisional: false,
      source: "registry",
      activityAt,
      lastActivityAt: activityAt,
    });
    attachLiveSessions(byKey.get(key));
    pathKeys.push(key);
  }

  const projects = [];
  for (const key of pathKeys) {
    if (byKey.has(key)) projects.push(byKey.get(key));
  }
  // Unregistered live-only windows sort among themselves by activity.
  const provisional = [...liveByPath.keys()]
    .filter((key) => !byKey.has(key))
    .map((key) => {
      const instances = liveByPath.get(key) || [];
      const displayPath = instances[0]?.cwd || key;
      const activityAt = latestActivity([], instances);
      const row = {
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
      };
      attachLiveSessions(row);
      return row;
    })
    .sort((a, b) => b.activityAt - a.activityAt || a.workspaceId.localeCompare(b.workspaceId));
  projects.push(...provisional);

  // A provisional `path:` id resolves to its stable `ws:` id on this load;
  // the sidebar carries over expansion so rows do not snap back collapsed.
  const previous = new Map(
    (Array.isArray(previousProjects) ? previousProjects : []).map((project) => [
      workspacePathKey(project.path),
      project,
    ]),
  );
  const reconciliations = [];
  for (const project of projects) {
    if (project.source !== "registry") continue;
    const old = previous.get(workspacePathKey(project.path));
    if (old?.isProvisional && old.workspaceId !== project.workspaceId) {
      reconciliations.push({
        fromId: old.workspaceId,
        toId: project.workspaceId,
        path: project.path,
      });
    }
  }

  return { projects, reconciliations };
}

export function registryPinsFromProjects(projects = []) {
  return projects
    .filter((project) => project.source === "registry" && project.pinned)
    .map((project) => ({ id: project.workspaceId, path: project.path }));
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
