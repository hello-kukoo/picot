// ABOUTME: Verifies the pre-CSS theme bootstrap resolves and normalizes the saved
// ABOUTME: theme before the first paint, matching the repo's theme conventions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

function themeBootstrapSource() {
  const match = html.match(/<script id="theme-bootstrap">([\s\S]*?)<\/script>/);
  expect(match, "index.html should contain the synchronous theme bootstrap").not.toBeNull();
  return match[1];
}

function runThemeBootstrap(cookieValue) {
  document.documentElement.removeAttribute("data-theme");
  document.cookie = `pi-studio-theme=${encodeURIComponent(cookieValue)}; Path=/`;
  new Function(themeBootstrapSource())();
  return document.documentElement.dataset.theme;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.cookie = "pi-studio-theme=; Max-Age=0; Path=/";
});

test("applies the saved theme before theme CSS can paint", () => {
  const bootstrapIndex = html.indexOf('<script id="theme-bootstrap">');
  const themeCssIndex = html.indexOf('<link rel="stylesheet" href="style-theme.css"');

  expect(bootstrapIndex).toBeGreaterThan(-1);
  expect(bootstrapIndex).toBeLessThan(themeCssIndex);
  expect(runThemeBootstrap("clean")).toBe("clean");
});

test.each([
  ["light", "terracotta"],
  ["dark", "night"],
  ["unknown", "night"],
])("normalizes saved theme %s to %s during bootstrap", (saved, expected) => {
  expect(runThemeBootstrap(saved)).toBe(expected);
});
