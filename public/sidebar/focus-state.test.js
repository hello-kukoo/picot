// ABOUTME: Tests for the URL-scoped focus state machine.
// ABOUTME: Covers param propagation, clearing, and pending/matched/mismatched resolution.
import { describe, expect, test } from "vitest";
import {
  clearFocusParam,
  FOCUS_WORKSPACE_PARAM,
  resolveFocusState,
  withFocusParam,
  workspaceFocusId,
} from "./focus-state.js";

const ALPHA = { path: "/work/alpha" };
const alphaId = workspaceFocusId(ALPHA);

describe("withFocusParam", () => {
  test("appends focus id when target cwd matches the focused project path", () => {
    const url = withFocusParam("/work/alpha", ALPHA, "http://localhost:3001/");
    expect(url.searchParams.get(FOCUS_WORKSPACE_PARAM)).toBe(alphaId);
  });

  test("omits focus id when target cwd differs from focused project", () => {
    const url = withFocusParam("/work/beta", ALPHA, "http://localhost:3001/");
    expect(url.searchParams.has(FOCUS_WORKSPACE_PARAM)).toBe(false);
  });

  test("omits focus id when there is no focused project", () => {
    const url = withFocusParam("/work/alpha", null, "http://localhost:3001/");
    expect(url.searchParams.has(FOCUS_WORKSPACE_PARAM)).toBe(false);
  });

  test("omits focus id when target cwd is unknown", () => {
    const url = withFocusParam("", ALPHA, "http://localhost:3001/");
    expect(url.searchParams.has(FOCUS_WORKSPACE_PARAM)).toBe(false);
  });

  test("strips a pre-existing focus param when cwd no longer matches", () => {
    const url = withFocusParam(
      "/work/beta",
      ALPHA,
      `http://localhost:3001/?${FOCUS_WORKSPACE_PARAM}=${encodeURIComponent(alphaId)}`,
    );
    expect(url.searchParams.has(FOCUS_WORKSPACE_PARAM)).toBe(false);
  });

  test("preserves focus when replacing a same-workspace session route", () => {
    const url = withFocusParam(
      "/work/alpha",
      ALPHA,
      "http://localhost:3001/workspaces/workspace-alpha/sessions/session-b",
    );
    expect(url.pathname).toBe("/workspaces/workspace-alpha/sessions/session-b");
    expect(url.searchParams.get(FOCUS_WORKSPACE_PARAM)).toBe(alphaId);
  });

  test("preserves unrelated application params", () => {
    const url = withFocusParam("/work/alpha", ALPHA, "http://localhost:3001/?mobile=1");
    expect(url.searchParams.get("mobile")).toBe("1");
    expect(url.searchParams.get(FOCUS_WORKSPACE_PARAM)).toBe(alphaId);
  });
});

describe("clearFocusParam", () => {
  test("removes the focus param but keeps others", () => {
    const url = clearFocusParam(
      `http://localhost:3001/?${FOCUS_WORKSPACE_PARAM}=${encodeURIComponent(alphaId)}&mobile=1`,
    );
    expect(url.searchParams.has(FOCUS_WORKSPACE_PARAM)).toBe(false);
    expect(url.searchParams.get("mobile")).toBe("1");
  });
});

describe("resolveFocusState", () => {
  const projects = [
    { path: "/work/alpha", sessions: [{ filePath: "/s/a.jsonl" }] },
    { path: "/work/beta", sessions: [{ filePath: "/s/b.jsonl" }] },
  ];

  test("pending when activeSessionFile is null", () => {
    expect(
      resolveFocusState({ requestedId: alphaId, projects, activeSessionFile: null }).state,
    ).toBe("pending");
  });

  test("pending when the active session is not yet in a loaded project", () => {
    expect(
      resolveFocusState({ requestedId: alphaId, projects, activeSessionFile: "/s/unknown.jsonl" })
        .state,
    ).toBe("pending");
  });

  test("matched when requested id equals the active project id", () => {
    const r = resolveFocusState({
      requestedId: alphaId,
      projects,
      activeSessionFile: "/s/a.jsonl",
    });
    expect(r.state).toBe("matched");
    expect(r.project.path).toBe("/work/alpha");
  });

  test("matches the current runtime workspace before its first session is persisted", () => {
    const registryProjects = [
      { path: "/work/alpha", registryId: "workspace-alpha", sessions: [] },
      { path: "/work/beta", registryId: "workspace-beta", sessions: [] },
    ];
    const r = resolveFocusState({
      requestedId: alphaId,
      projects: registryProjects,
      activeSessionFile: null,
      runtimeWorkspaceId: "workspace-alpha",
    });
    expect(r.state).toBe("matched");
    expect(r.project.path).toBe("/work/alpha");
  });

  test("mismatched when requested id differs from the active project id", () => {
    expect(
      resolveFocusState({
        requestedId: alphaId,
        projects,
        activeSessionFile: "/s/b.jsonl",
      }).state,
    ).toBe("mismatched");
  });

  test("mismatched (not pending) when no focus is requested", () => {
    expect(
      resolveFocusState({ requestedId: null, projects, activeSessionFile: "/s/a.jsonl" }).state,
    ).toBe("mismatched");
  });
});
