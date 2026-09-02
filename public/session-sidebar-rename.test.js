// ABOUTME: Regression tests for target-aware session rename sidebar behavior.
// ABOUTME: Covers display/search metadata and the catalog mutation barrier.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { JSDOM } from "jsdom";
import { buildSessionItem, getSessionDisplayTitle } from "./sidebar/build-session-item.js";
import { SessionSidebar } from "./sidebar/index.js";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS;
  globalThis.localStorage = dom.window.localStorage;
});

describe("session sidebar rename metadata", () => {
  test("uses name, then first message, then localized empty title", () => {
    expect(getSessionDisplayTitle({ name: "Renamed", firstMessage: "Original" })).toBe("Renamed");
    expect(getSessionDisplayTitle({ firstMessage: "Original" })).toBe("Original");
    expect(getSessionDisplayTitle({})).toBe("sidebar.emptySession");
  });

  test("keeps name and first message as independent searchable row metadata", () => {
    const item = buildSessionItem({
      session: { filePath: "/sessions/a.jsonl", name: "Renamed", firstMessage: "Original task" },
    });
    expect(item.dataset.name).toBe("renamed");
    expect(item.dataset.firstMessage).toBe("original task");
  });

  test("keeps a server-error retry actionable through pointerdown and click", async () => {
    let renameCalls = 0;
    const transport = {
      available: true,
      capabilities: { native: true },
      sessionRename: vi.fn(async () => {
        renameCalls += 1;
        if (renameCalls === 1) {
          const error = new Error("session rename failed");
          error.code = "session_rename_failed";
          throw error;
        }
        return { ok: true };
      }),
      runtimeInstances: vi.fn(async () => ({ instances: [] })),
      listWorkspaces: vi.fn(async () => ({ workspaces: [], removed: [] })),
    };
    const root = document.getElementById("root");
    const sidebar = new SessionSidebar(root, vi.fn(), vi.fn(), { transport });
    const item = document.createElement("div");
    item.className = "session-item";
    item.dataset.filePath = "/sessions/a.jsonl";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = "Old name";
    item.appendChild(title);
    root.appendChild(item);

    sidebar.startRename(item, { filePath: "/sessions/a.jsonl", name: "Old name" });
    const input = item.querySelector(".session-rename-input");
    input.value = "New name";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(item.querySelector(".session-rename-retry")).toBeTruthy());

    const retry = item.querySelector(".session-rename-retry");
    const pointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
    retry.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    retry.click();
    await vi.waitFor(() => expect(renameCalls).toBe(2));
  });

  test("normal session rows route right-click actions to the shared session menu", () => {
    const onContextMenu = vi.fn();
    const session = { filePath: "/sessions/a.jsonl", name: "Renamed" };
    const item = buildSessionItem({ session, onContextMenu });
    const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledWith(event, item, session);
  });

  test("rename action is target-aware and does not select the row", () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const session = { filePath: "/sessions/a.jsonl", name: "Renamed" };
    const item = buildSessionItem({ session, onSelect, onRename });
    item.querySelector(".session-rename-btn").click();
    expect(onRename).toHaveBeenCalledWith(session.filePath, session, item);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
