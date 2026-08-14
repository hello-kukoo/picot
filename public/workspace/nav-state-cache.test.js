import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheSidebarProjects,
  consumeNavState,
  isCompleteSidebarProject,
  readCachedSidebarProjects,
  snapshotNavState,
} from "./nav-state-cache.js";

function clearCookies() {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
}

const sampleProjects = [
  {
    workspaceId: "history:proj",
    path: "/work/proj",
    folderName: "proj",
    dirName: "proj",
    isProvisional: false,
    source: "history",
    activityAt: 1000,
    lastActivityAt: 1000,
    sessions: [
      {
        filePath: "/s1.jsonl",
        name: "Session 1",
        firstMessage: "hello",
        timestamp: 123,
        ctime: 100,
        tmux: false,
      },
    ],
  },
];

describe("nav-state-cache", () => {
  beforeEach(() => {
    clearCookies();
  });

  afterEach(() => {
    clearCookies();
  });

  describe("snapshotNavState / consumeNavState", () => {
    it("round-trips scroll, draft, and sidebar state", () => {
      snapshotNavState({
        messageScroll: 420,
        sidebarScroll: 80,
        inputDraft: "half-typed reply",
        expandedWorkspaces: new Set(["ws-1", "ws-2"]),
        searchQuery: "test",
      });

      const restored = consumeNavState();

      expect(restored).not.toBeNull();
      expect(restored.messageScroll).toBe(420);
      expect(restored.sidebarScroll).toBe(80);
      expect(restored.inputDraft).toBe("half-typed reply");
      expect(restored.expandedWorkspaces).toBeInstanceOf(Set);
      expect([...restored.expandedWorkspaces].sort()).toEqual(["ws-1", "ws-2"]);
      expect(restored.searchQuery).toBe("test");
    });

    it("consuming clears the snapshot so it is not reused", () => {
      snapshotNavState({ messageScroll: 100 });
      expect(consumeNavState()).not.toBeNull();
      expect(consumeNavState()).toBeNull();
    });

    it("returns null when no snapshot exists", () => {
      expect(consumeNavState()).toBeNull();
    });

    it("accepts arrays for expandedWorkspaces", () => {
      snapshotNavState({ expandedWorkspaces: ["a", "b"] });
      const restored = consumeNavState();
      expect(restored).not.toBeNull();
      expect([...restored.expandedWorkspaces].sort()).toEqual(["a", "b"]);
    });

    it("truncates long input drafts to the cookie-safe cap", () => {
      const long = "x".repeat(30000);
      snapshotNavState({ inputDraft: long });
      const restored = consumeNavState();
      expect(restored.inputDraft.length).toBeLessThanOrEqual(1500);
    });
  });

  describe("isCompleteSidebarProject", () => {
    it("accepts projects with identity + sessions array", () => {
      expect(isCompleteSidebarProject(sampleProjects[0])).toBe(true);
    });

    it("rejects projects missing workspaceId, path, or sessions", () => {
      expect(isCompleteSidebarProject({ ...sampleProjects[0], workspaceId: "" })).toBe(false);
      expect(isCompleteSidebarProject({ ...sampleProjects[0], path: "" })).toBe(false);
      expect(isCompleteSidebarProject({ ...sampleProjects[0], sessions: null })).toBe(false);
      expect(isCompleteSidebarProject(null)).toBe(false);
      expect(isCompleteSidebarProject(undefined)).toBe(false);
    });
  });

  describe("cacheSidebarProjects / readCachedSidebarProjects", () => {
    it("round-trips a complete project projection with render fields", () => {
      cacheSidebarProjects(sampleProjects);

      const cached = readCachedSidebarProjects();
      expect(cached).not.toBeNull();
      expect(cached).toHaveLength(1);
      expect(cached[0].path).toBe("/work/proj");
      expect(cached[0].folderName).toBe("proj");
      expect(cached[0].dirName).toBe("proj");
      expect(cached[0].sessions).toHaveLength(1);
      expect(cached[0].sessions[0].name).toBe("Session 1");
      expect(cached[0].sessions[0].firstMessage).toBe("hello");
      expect(cached[0].sessions[0].filePath).toBe("/s1.jsonl");
    });

    it("drops sessions without a filePath and incomplete projects", () => {
      cacheSidebarProjects([
        {
          ...sampleProjects[0],
          sessions: [
            ...sampleProjects[0].sessions,
            { name: "no path", firstMessage: "x", timestamp: 1 },
          ],
        },
        { workspaceId: "", path: "", sessions: [] },
      ]);

      const cached = readCachedSidebarProjects();
      expect(cached).not.toBeNull();
      expect(cached).toHaveLength(1);
      expect(cached[0].sessions).toHaveLength(1);
    });

    it("shards large project trees and reads them back", () => {
      const manySessions = Array.from({ length: 400 }, (_, i) => ({
        filePath: `/s${i}.jsonl`,
        name: `Session ${i}`,
        firstMessage: `m${i}`,
        timestamp: i,
        ctime: i,
        tmux: false,
      }));
      cacheSidebarProjects([{ ...sampleProjects[0], sessions: manySessions }]);

      const cached = readCachedSidebarProjects();
      expect(cached).not.toBeNull();
      expect(cached[0].sessions).toHaveLength(400);
      expect(cached[0].sessions[399].name).toBe("Session 399");
    });

    it("returns null when no cache exists", () => {
      expect(readCachedSidebarProjects()).toBeNull();
    });

    it("ignores non-array input", () => {
      cacheSidebarProjects(null);
      cacheSidebarProjects(undefined);
      cacheSidebarProjects("not-an-array");
      expect(readCachedSidebarProjects()).toBeNull();
    });
  });
});
