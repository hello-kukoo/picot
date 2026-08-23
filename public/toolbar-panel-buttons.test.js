// ABOUTME: Verifies the compact outlined controls used for the terminal and file panels.
// ABOUTME: Keeps the supplied toolbar visual contract separate from Side Chat's existing button.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

const publicDir = join(process.cwd(), "public");
const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
const styleCss = readFileSync(join(publicDir, "style.css"), "utf8");
const appJs = readFileSync(join(publicDir, "app.js"), "utf8");
const document = new JSDOM(indexHtml).window.document;

test("file sidebar uses the outlined panel toolbar control", () => {
  const button = document.querySelector("#file-sidebar-toggle");

  expect(button?.classList.contains("panel-toggle-btn")).toBe(true);
  expect(button?.getAttribute("aria-label")).toBe("Toggle file browser");
  // Static HTML carries an inline panel SVG; at runtime app.js replaces it
  // with the shared registry glyph (panel-right) via setButtonIcon.
  expect(appJs).toContain('setButtonIcon(fileSidebarToggle, "panel-right"');
});

test("Side Chat mirrors Terminal's active panel toggle contract", () => {
  const button = document.querySelector("#side-chat-btn");

  expect(button?.classList.contains("icon-btn")).toBe(true);
  expect(button?.classList.contains("panel-toggle-btn")).toBe(true);
  expect(button?.getAttribute("aria-pressed")).toBe("false");
  expect(appJs).toContain('setButtonIcon(sideChatButton, "message-square"');
  expect(appJs).toContain('activeContent?.kind === "transient"');
  expect(appJs).toContain("onStateChange: syncSideChatButton");
});

test("sidebar action buttons share the main panel toggle visual contract", () => {
  for (const id of ["open-folder-btn", "quick-chat-btn", "refresh-sessions-btn"]) {
    expect(document.querySelector(`#${id}`)?.classList.contains("panel-toggle-btn")).toBe(true);
  }
  expect(appJs).toContain('setButtonIcon(openFolderBtn, "folder-plus", { size: 16 });');
  expect(appJs).toContain('setButtonIcon(refreshSessionsBtn, "refresh-cw", { size: 16 });');
  expect(appJs).toContain(
    'setButtonIcon(document.getElementById("quick-chat-btn"), "message-circle", { size: 16 });',
  );
  expect(appJs).toContain('setButtonIcon(lanQrBtn, "smartphone"');
  expect(styleCss).toContain(".lan-qr-btn");
  expect(styleCss).toContain(".panel-toggle-btn:hover");
  expect(styleCss).toContain('.panel-toggle-btn[aria-pressed="true"]');
});

test("File panel actions share the same scoped button treatment", () => {
  for (const id of [
    "file-sidebar-up",
    "file-sidebar-refresh",
    "file-sidebar-toggle-hidden",
    "info-panel-refresh",
    "git-panel-refresh",
    "file-sidebar-finder",
    "file-sidebar-close",
  ]) {
    const button = document.querySelector(`#${id}`);
    expect(button?.classList.contains("file-sidebar-action")).toBe(true);
    expect(button?.querySelector("svg")).toBeNull();
  }
  expect(appJs).toContain('[fileSidebarClose, "x", 16]');
  expect(appJs).toContain('[fileSidebarUp, "arrow-up", 16]');
  expect(appJs).toContain('[fileSidebarRefresh, "refresh-cw", 16]');
  expect(appJs).toContain('[fileSidebarToggleHidden, "eye", 16]');
  expect(appJs).toContain('[infoPanelRefresh, "refresh-cw", 16]');
  expect(appJs).toContain('[gitPanelRefresh, "refresh-cw", 16]');
  expect(appJs).toContain('fileSidebarRefresh.classList.toggle("hidden", showInfo || showGit)');
  expect(appJs).toContain(
    'fileSidebarToggleHidden.classList.toggle("hidden", showInfo || showGit)',
  );
  expect(appJs).toContain('infoPanelRefresh.classList.toggle("hidden", !showInfo)');
  expect(appJs).toContain('gitPanelRefresh.classList.toggle("hidden", !showGit)');
  expect(styleCss).toContain(".file-sidebar-header .file-sidebar-action");
  expect(styleCss).toContain(".file-sidebar-header .file-sidebar-action svg");
});

test("sidebar tabs expose icons and keep labels in accessible markup", () => {
  const tabs = [
    ["#file-sidebar-info-tab", "infoPanel.title"],
    ["#file-sidebar-files-tab", "files.title"],
    ["#file-sidebar-git-tab", "git.panel"],
  ];
  for (const [selector, key] of tabs) {
    const tab = document.querySelector(selector);
    expect(tab?.querySelector(".file-sidebar-tab-icon")).not.toBeNull();
    expect(tab?.querySelector(".file-sidebar-tab-label")?.dataset.i18n).toBe(key);
    expect(tab?.getAttribute("aria-label")).not.toBeNull();
  }
  expect(appJs).toContain('[fileSidebarInfoTab, "circle-info"]');
  expect(appJs).toContain('[fileSidebarFilesTab, "folder"]');
  expect(appJs).toContain('[fileSidebarGitTab, "git-info"]');
  expect(styleCss).toContain(".file-sidebar-tab.active .file-sidebar-tab-label");
  expect(styleCss).toContain(".file-sidebar-tab-label {\n  display: none;");
});

test("declares File and Git header controls with the expected initial state", () => {
  expect(document.querySelector("#file-sidebar-refresh")).not.toBeNull();
  expect(document.querySelector("#file-sidebar-toggle-hidden")?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(document.querySelector("#info-panel-refresh")).not.toBeNull();
  expect(document.querySelector("#git-panel-refresh")).not.toBeNull();
  expect(document.querySelector("#git-panel-refresh")?.classList.contains("hidden")).toBe(true);
});

test("toolbar orders Side Chat, Terminal Panel, then File Browser", () => {
  const moveSideChat = appJs.indexOf("toolbarEl.insertBefore(sideChatToggle, fileSidebarToggle)");
  const moveTerminal = appJs.indexOf(
    "toolbarEl.insertBefore(terminalPanel.toggleEl, fileSidebarToggle)",
  );

  expect(moveSideChat).toBeGreaterThan(-1);
  expect(moveTerminal).toBeGreaterThan(moveSideChat);
});

test("panel controls use the compact borderless visual contract", () => {
  expect(styleCss).toContain(".panel-toggle-btn,");
  expect(styleCss).toContain("width: 32px;");
  expect(styleCss).toContain("height: 28px;");
  expect(styleCss).toContain("border: 0;");
  expect(styleCss).toContain('.panel-toggle-btn[aria-pressed="true"]');
  expect(styleCss).not.toContain(
    "border: 1.5px solid color-mix(in srgb, var(--text-primary) 48%, transparent);",
  );
  expect(styleCss).not.toContain("terminal-toggle[data-terminal-count]");
});
