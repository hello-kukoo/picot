// ABOUTME: Focuses on SessionSidebar wiring of the workspace Focus affordance.
// ABOUTME: Verifies the focus button is rendered only for the active workspace
// ABOUTME: and that clicking it routes to the onWorkspaceFocus callback.
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { SessionSidebar } from "./sidebar/index.js";

function createProjects() {
  return [
    {
      path: "/work/alpha",
      workspaceId: "history:alpha",
      dirName: "alpha",
      sessions: [{ filePath: "/sessions/alpha.jsonl", name: "Alpha work" }],
    },
    {
      path: "/work/beta",
      workspaceId: "history:beta",
      dirName: "beta",
      sessions: [{ filePath: "/sessions/beta.jsonl", name: "Beta work" }],
    },
  ];
}

function setupDom() {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || {
    escape: (value) => String(value).replace(/["\\]/g, "\\$&"),
  };
}

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const target = String(url);
    if (target.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sidebar: {
            recent: "RECENT",
            pinned: "PINNED",
            projects: "PROJECTS",
            newChat: "New chat in {path}",
            workspaceActions: "Workspace actions",
            unavailable: "Unavailable",
            emptySession: "Empty session",
            rename: "Rename",
            pinSession: "Pin session",
            unpinSession: "Unpin session",
            deleteSession: "Delete",
            deleteDisabledActive: "Cannot delete the active session",
            deleteDisabledStreaming: "Cannot delete a streaming session",
            deleteDisabledRunning: "Cannot delete a running session",
            openProject: "Open project",
            showMore: "Show more",
            showLess: "Show less",
          },
          workspace: {
            focus: "Enter focus mode",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("SessionSidebar workspace focus affordance", () => {
  test("renders the focus button for the current workspace without an active session", () => {
    setupDom();
    const onFocus = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onWorkspaceFocus: onFocus,
      isCurrentWorkspace: (project) => project.path === "/work/beta",
    });
    sidebar.projects = createProjects();
    sidebar.render();

    const groups = Array.from(document.querySelectorAll(".projects-group .workspace-group"));
    expect(groups.length).toBe(2);

    const alphaHeader = groups
      .find((g) => g.dataset.workspaceId === "history:alpha")
      .querySelector(".workspace-header");
    const betaHeader = groups
      .find((g) => g.dataset.workspaceId === "history:beta")
      .querySelector(".workspace-header");

    // Current foreground workspace (beta) exposes the focus button even
    // before Pi has persisted a first session.
    expect(betaHeader.querySelector(".workspace-focus-btn")).not.toBeNull();
    expect(alphaHeader.querySelector(".workspace-focus-btn")).toBeNull();
  });

  test("clicking the focus button fires onWorkspaceFocus with the active project", () => {
    setupDom();
    const onFocus = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onWorkspaceFocus: onFocus,
    });
    const projects = createProjects();
    sidebar.projects = projects;
    sidebar.setActive("/sessions/beta.jsonl");
    sidebar.render();

    const betaGroup = Array.from(
      document.querySelectorAll(".projects-group .workspace-group"),
    ).find((g) => g.dataset.workspaceId === "history:beta");
    betaGroup.querySelector(".workspace-focus-btn").click();
    expect(onFocus).toHaveBeenCalledWith(projects[1]);
  });

  test("omits the focus button entirely when no onWorkspaceFocus callback is given", () => {
    setupDom();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.setActive("/sessions/beta.jsonl");
    sidebar.render();

    const focusButtons = document.querySelectorAll(".projects-group .workspace-focus-btn");
    expect(focusButtons.length).toBe(0);
  });

  test("pinned active workspace also exposes the focus button", () => {
    setupDom();
    const onFocus = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onWorkspaceFocus: onFocus,
    });
    const projects = createProjects();
    sidebar.projects = projects;
    // Registry pins are now DB rows surfaced through _registryPins; seed one
    // for alpha so its pinned group qualifies for the focus affordance.
    sidebar._registryPins = [{ id: "history:alpha", path: "/work/alpha" }];
    sidebar.setActive("/sessions/alpha.jsonl");
    sidebar.render();

    const pinnedGroups = Array.from(document.querySelectorAll(".pinned-group .workspace-group"));
    expect(pinnedGroups.length).toBeGreaterThan(0);
    const focusBtn = pinnedGroups[0].querySelector(".workspace-focus-btn");
    expect(focusBtn).not.toBeNull();
    focusBtn.click();
    expect(onFocus).toHaveBeenCalled();
  });
});
