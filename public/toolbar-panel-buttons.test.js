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
  expect(button?.querySelector('rect[x="3.5"]')).not.toBeNull();
  expect(button?.querySelector('path[d="M17 5v14"]')).not.toBeNull();
});

test("Side Chat keeps its existing icon button styling", () => {
  const button = document.querySelector("#side-chat-btn");

  expect(button?.classList.contains("icon-btn")).toBe(true);
  expect(button?.classList.contains("panel-toggle-btn")).toBe(false);
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
