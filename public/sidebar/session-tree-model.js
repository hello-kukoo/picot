// ABOUTME: Projects Pi session files into a linear cross-file tree for the sidebar.
// ABOUTME: Links are derived only from each JSONL header's parentSession path.

import { normalizeLocalPath } from "../workspace/path-utils.js";

function canonicalPath(value) {
  return normalizeLocalPath(value);
}

export function sessionPath(session) {
  return canonicalPath(session?.filePath || session?.path);
}

function sessionActivity(session) {
  const mtime = Number(session?.mtime);
  if (Number.isFinite(mtime) && mtime > 0) return mtime;
  const rawActivity = session?.lastActivityAt;
  const activity = typeof rawActivity === "number" ? rawActivity : Date.parse(rawActivity || "");
  if (Number.isFinite(activity)) return activity;
  const timestamp = Date.parse(session?.timestamp || "");
  if (Number.isFinite(timestamp)) return timestamp;
  const ctime = Number(session?.ctime);
  return Number.isFinite(ctime) ? ctime : 0;
}

function compareActivity(left, right) {
  return right.latestActivity - left.latestActivity || left.order - right.order;
}

const flattenedTreeCache = new WeakMap();

function treeSignature(sessions) {
  return sessions
    .map((session) => [
      sessionPath(session),
      session?.parentSession || null,
      sessionActivity(session),
    ])
    .join("\u0001");
}

/**
 * Build a tree from a flat Pi session list.
 *
 * Missing parents and malformed parent cycles are promoted to roots rather than
 * dropped. The returned nodes contain no UI expansion state: the sidebar always
 * renders the whole tree in one linear list.
 */
export function buildSessionTree(sessions = []) {
  const nodes = new Map();
  for (const [order, session] of (Array.isArray(sessions) ? sessions : []).entries()) {
    const path = sessionPath(session);
    if (!path) continue;
    nodes.set(path, { session, children: [], latestActivity: sessionActivity(session), order });
  }

  const parentOf = new Map();
  for (const [path, node] of nodes) {
    const parentPath = canonicalPath(node.session?.parentSession);
    if (parentPath && parentPath !== path && nodes.has(parentPath)) {
      parentOf.set(path, parentPath);
    }
  }

  // A malformed cycle has no natural root. Break one edge per cycle so every
  // scanned file remains visible, matching Pi's tolerant discovery behavior.
  // The three-state walk avoids restarting a full parent chain for every node.
  const visitState = new Map();
  for (const start of nodes.keys()) {
    if (visitState.get(start) === 2) continue;
    const path = [];
    let current = start;
    while (parentOf.has(current) && visitState.get(current) !== 2) {
      if (visitState.get(current) === 1) {
        parentOf.delete(current);
        break;
      }
      visitState.set(current, 1);
      path.push(current);
      current = parentOf.get(current);
    }
    for (const pathNode of path) visitState.set(pathNode, 2);
  }

  const roots = [];
  for (const [path, node] of nodes) {
    const parentPath = parentOf.get(path);
    if (parentPath) nodes.get(parentPath).children.push(node);
    else roots.push(node);
  }

  // Use an explicit post-order stack so a deeply forked session lineage cannot
  // exhaust the JavaScript call stack while calculating subtree activity.
  const stack = roots.map((node) => ({ node, visited: false }));
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      for (const child of frame.node.children) {
        stack.push({ node: child, visited: false });
      }
      continue;
    }
    frame.node.latestActivity = frame.node.children.reduce(
      (latest, child) => Math.max(latest, child.latestActivity),
      frame.node.latestActivity,
    );
    frame.node.children.sort(compareActivity);
  }
  roots.sort(compareActivity);
  return roots;
}

let nextAncestorKey = 1;

/** Flatten the tree using shared branch-prefix links like Pi's TUI. */
export function flattenSessionTree(roots = []) {
  const rows = [];
  const stack = roots
    .map((node, index) => ({
      node,
      depth: 0,
      ancestorChain: null,
      isLast: index === roots.length - 1,
    }))
    .reverse();
  while (stack.length > 0) {
    const frame = stack.pop();
    rows.push({
      session: frame.node.session,
      depth: frame.depth,
      isLast: frame.isLast,
      ancestorChain: frame.ancestorChain,
      ancestorKey: frame.ancestorChain?.key || 0,
    });
    const continues = frame.depth > 0 ? !frame.isLast : false;
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      const child = frame.node.children[index];
      const ancestorChain = {
        parent: frame.ancestorChain,
        continues,
        key: nextAncestorKey++,
      };
      stack.push({
        node: child,
        depth: frame.depth + 1,
        ancestorChain,
        isLast: index === frame.node.children.length - 1,
      });
    }
  }
  return rows;
}

/** Expand one shared ancestry chain only when a DOM prefix is needed. */
export function formatTreePrefix(ancestorChain, isLast) {
  const parts = [];
  for (let link = ancestorChain; link; link = link.parent) {
    parts.push(link.continues ? "│  " : "   ");
  }
  parts.reverse();
  return `${parts.join("")}${isLast ? "└─ " : "├─ "}`;
}

/** Return a cached flattened tree while the array's tree-relevant fields match. */
export function buildFlattenedSessionTree(sessions = []) {
  if (!Array.isArray(sessions)) return [];
  const signature = treeSignature(sessions);
  const cached = flattenedTreeCache.get(sessions);
  if (cached?.signature === signature) return cached.rows;
  const rows = flattenSessionTree(buildSessionTree(sessions));
  flattenedTreeCache.set(sessions, { signature, rows });
  return rows;
}
