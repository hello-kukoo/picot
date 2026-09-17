// ABOUTME: Verifies the sidebar's cross-file session tree projection.
// ABOUTME: The model links JSONL files by parentSession, not entry id/parentId.

import { describe, expect, test } from "vitest";
import {
  buildFlattenedSessionTree,
  buildSessionTree,
  flattenSessionTree,
  formatTreePrefix,
} from "./session-tree-model.js";

function session(filePath, mtime, parentSession = null) {
  return {
    filePath,
    mtime,
    name: filePath.split("/").pop(),
    ...(parentSession ? { parentSession } : {}),
  };
}

describe("sidebar session tree model", () => {
  test("renders every parent and child linearly with Pi tree metadata", () => {
    const parent = session("/sessions/parent.jsonl", 100);
    const child = session("/sessions/child.jsonl", 200, "/sessions/parent.jsonl");
    const other = session("/sessions/other.jsonl", 150);

    const rows = flattenSessionTree(buildSessionTree([child, other, parent]));

    expect(rows.map((row) => row.session.filePath)).toEqual([
      "/sessions/parent.jsonl",
      "/sessions/child.jsonl",
      "/sessions/other.jsonl",
    ]);
    expect(rows[0]).toMatchObject({ depth: 0, isLast: false, ancestorKey: 0 });
    expect(rows[1]).toMatchObject({ depth: 1, isLast: true });
    expect(rows[2]).toMatchObject({ depth: 0, isLast: true, ancestorKey: 0 });
    expect(formatTreePrefix(rows[1].ancestorChain, rows[1].isLast)).toBe("   └─ ");
  });

  test("treats a missing parent as a root without dropping the session", () => {
    const orphan = session("/sessions/orphan.jsonl", 300, "/sessions/missing.jsonl");

    const rows = flattenSessionTree(buildSessionTree([orphan]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0, session: orphan });
  });

  test("sorts each subtree by latest activity like Pi threaded resume", () => {
    const oldParent = session("/sessions/old.jsonl", 500);
    const recentChild = session("/sessions/recent-child.jsonl", 900, "/sessions/old.jsonl");
    const recentRoot = session("/sessions/recent.jsonl", 800);

    const rows = flattenSessionTree(buildSessionTree([oldParent, recentRoot, recentChild]));

    expect(rows.map((row) => row.session.filePath)).toEqual([
      "/sessions/old.jsonl",
      "/sessions/recent-child.jsonl",
      "/sessions/recent.jsonl",
    ]);
  });

  test("uses file mtime before the immutable session header timestamp", () => {
    const oldSession = {
      filePath: "/sessions/old.jsonl",
      timestamp: "2026-01-02T00:00:00.000Z",
      mtime: Date.parse("2026-01-01T00:00:00.000Z"),
    };
    const recentSession = {
      filePath: "/sessions/recent.jsonl",
      timestamp: "2026-01-01T00:00:00.000Z",
      mtime: Date.parse("2026-01-03T00:00:00.000Z"),
    };

    const rows = flattenSessionTree(buildSessionTree([oldSession, recentSession]));

    expect(rows.map((row) => row.session.filePath)).toEqual([
      "/sessions/recent.jsonl",
      "/sessions/old.jsonl",
    ]);
  });

  test("does not mutate the input session records", () => {
    const input = [
      session("/sessions/parent.jsonl", 100),
      session("/sessions/child.jsonl", 200, "/sessions/parent.jsonl"),
    ];
    const snapshot = structuredClone(input);

    buildSessionTree(input);

    expect(input).toEqual(snapshot);
  });

  test("handles a deeply chained lineage without using the call stack", () => {
    const sessions = [];
    for (let index = 0; index < 10000; index += 1) {
      sessions.push(
        session(
          `/sessions/${index}.jsonl`,
          index,
          index === 0 ? null : `/sessions/${index - 1}.jsonl`,
        ),
      );
    }
    const rows = buildFlattenedSessionTree(sessions);
    expect(rows).toHaveLength(sessions.length);
    expect(rows.at(-1).depth).toBe(9999);
    expect(rows.at(-1).ancestorChain).toBeTruthy();
    expect(rows.at(-1).ancestorChain.parent).toBe(rows.at(-2).ancestorChain);
  });

  test("does not copy the full ancestry array for each deep row", () => {
    const input = [];
    for (let index = 0; index < 1000; index += 1) {
      input.push(
        session(
          `/sessions/${index}.jsonl`,
          index,
          index === 0 ? null : `/sessions/${index - 1}.jsonl`,
        ),
      );
    }
    const rows = buildFlattenedSessionTree(input);
    expect(rows.every((row) => !("ancestorContinues" in row))).toBe(true);
    expect(rows.at(-1).ancestorChain.parent).toBe(rows.at(-2).ancestorChain);
  });

  test("reuses flattened rows until a tree-relevant session field changes", () => {
    const input = [
      session("/sessions/parent.jsonl", 100),
      session("/sessions/child.jsonl", 200, "/sessions/parent.jsonl"),
    ];

    const first = buildFlattenedSessionTree(input);
    expect(buildFlattenedSessionTree(input)).toBe(first);

    input[1].mtime = 300;
    expect(buildFlattenedSessionTree(input)).not.toBe(first);
  });
});
