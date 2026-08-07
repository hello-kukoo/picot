// ABOUTME: Verifies the browser entry module initializes against the production document.
// ABOUTME: Prevents startup errors from blocking the Settings dialog and every other control.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

beforeEach(async () => {
  const fixture = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public/index.html"), "utf8"),
    "text/html",
  );
  document.documentElement.replaceChildren(...fixture.documentElement.childNodes);
  const storage = new Map();
  const storageApi = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  vi.stubGlobal("localStorage", storageApi);
  vi.stubGlobal("sessionStorage", storageApi);
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input) === "/locales/en.json") {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.replaceChildren();
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

test("places the preview workspace below the shared header", () => {
  const workspace = document.querySelector(".workspace");
  const content = document.querySelector(".workspace-content");

  expect(workspace).not.toBeNull();
  expect(workspace).toContain(document.querySelector(".header"));
  expect(workspace).toContain(content);
  expect(content).toContain(document.querySelector(".main"));
  expect(content).toContain(document.getElementById("file-preview-resizer"));
  expect(content).toContain(document.getElementById("file-preview-panel"));
  expect(content).toContain(document.getElementById("file-sidebar"));
});

test("initializes the application without reporting existing i18n keys as missing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await import("./app.js?startup-regression");

  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[i18n] missing key:"));

  document.getElementById("settings-btn").click();
  expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
});

test("switches the open file sidebar between Files and Git tabs", async () => {
  await import("./app.js?git-sidebar-tabs");

  const filesTab = document.getElementById("file-sidebar-files-tab");
  const gitTab = document.getElementById("file-sidebar-git-tab");
  const fileList = document.getElementById("file-list");
  const gitPanel = document.getElementById("git-panel");

  expect(filesTab).not.toBeNull();
  expect(gitTab).not.toBeNull();
  expect(filesTab.getAttribute("aria-selected")).toBe("true");

  gitTab.click();
  expect(gitTab.getAttribute("aria-selected")).toBe("true");
  expect(fileList.classList.contains("hidden")).toBe(true);
  expect(gitPanel.classList.contains("hidden")).toBe(false);
  expect(gitPanel.textContent).toContain("No Git status loaded");

  filesTab.click();
  expect(fileList.classList.contains("hidden")).toBe(false);
  expect(gitPanel.classList.contains("hidden")).toBe(true);
});

test("opens the file sidebar and switches tabs from header indicator pills", async () => {
  await import("./app.js?indicator-sidebar-tabs");

  const fileSidebar = document.getElementById("file-sidebar");
  const filesTab = document.getElementById("file-sidebar-files-tab");
  const gitTab = document.getElementById("file-sidebar-git-tab");
  const workspaceIndicator = document.getElementById("workspace-indicator");
  const gitIndicator = document.getElementById("git-branch-indicator");

  // Start from a known collapsed state so the pills must expand it.
  fileSidebar.classList.add("collapsed");

  workspaceIndicator.click();
  expect(fileSidebar.classList.contains("collapsed")).toBe(false);
  expect(filesTab.classList.contains("active")).toBe(true);
  expect(gitTab.classList.contains("active")).toBe(false);

  fileSidebar.classList.add("collapsed");
  gitIndicator.click();
  expect(fileSidebar.classList.contains("collapsed")).toBe(false);
  expect(filesTab.classList.contains("active")).toBe(false);
  expect(gitTab.classList.contains("active")).toBe(true);
});

test("header pills always open-and-focus: never collapse, and flash even when already open", async () => {
  await import("./app.js?indicator-always-open");

  const fileSidebar = document.getElementById("file-sidebar");
  const filesTab = document.getElementById("file-sidebar-files-tab");
  const gitTab = document.getElementById("file-sidebar-git-tab");
  const workspaceIndicator = document.getElementById("workspace-indicator");
  const gitIndicator = document.getElementById("git-branch-indicator");

  // Sidebar already expanded, already on the Files tab — clicking the path
  // pill must NOT toggle it closed, and must flash the Files tab.
  fileSidebar.classList.remove("collapsed");
  filesTab.classList.add("active");
  gitTab.classList.remove("active");

  workspaceIndicator.click();
  expect(fileSidebar.classList.contains("collapsed")).toBe(false);
  expect(filesTab.classList.contains("active")).toBe(true);
  expect(filesTab.classList.contains("flash-highlight")).toBe(true);

  // Same check for the Git pill when the sidebar is open on Files.
  gitIndicator.click();
  expect(fileSidebar.classList.contains("collapsed")).toBe(false);
  expect(gitTab.classList.contains("active")).toBe(true);
  expect(gitTab.classList.contains("flash-highlight")).toBe(true);
});

test("retries Git status when workspace generation arrives after opening Git", async () => {
  await import("./app.js?git-status-after-bootstrap");
  const socket = FakeWebSocket.instances.at(-1);
  socket.readyState = FakeWebSocket.OPEN;

  document.getElementById("file-sidebar-git-tab").click();
  expect(socket.sent).toHaveLength(0);

  socket.onmessage({ data: JSON.stringify({ type: "capabilities", class: "native" }) });
  socket.onmessage({
    data: JSON.stringify({ type: "owner_bootstrap", workspaceGeneration: 7, instances: [] }),
  });

  expect(socket.sent).toContainEqual({
    type: "git_command",
    requestId: "git-1",
    workspaceGeneration: 7,
    command: { type: "status" },
  });
});

test("persists the selected sidebar tab and restores it on reload", async () => {
  // Simulate a session where the user picked the Git tab, then reloads.
  const storage = new Map([
    ["pi-studio-file-sidebar", "open"],
    ["pi-studio-file-sidebar-tab", "git"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  });

  await import("./app.js?git-tab-persistence");

  const gitTab = document.getElementById("file-sidebar-git-tab");
  const gitPanel = document.getElementById("git-panel");
  const fileList = document.getElementById("file-list");

  // The stored Git tab must be restored on startup.
  expect(gitTab.getAttribute("aria-selected")).toBe("true");
  expect(gitPanel.classList.contains("hidden")).toBe(false);
  expect(fileList.classList.contains("hidden")).toBe(true);

  // Switching to Files must persist that choice.
  document.getElementById("file-sidebar-files-tab").click();
  expect(storage.get("pi-studio-file-sidebar-tab")).toBe("files");
});
