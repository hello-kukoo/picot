// ABOUTME: Guards Skills settings chrome: page header above sub-tabs and shared type scale.
// ABOUTME: The Skills panel used to start at the tab bar with native button fonts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

function skillsMarkup() {
  const html = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");
  const start = html.indexOf('data-settings-panel="skills"');
  const end = html.indexOf('data-settings-panel="usage"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

test("skills settings page has a section header above the sub-tabs", () => {
  const skills = skillsMarkup();
  expect(skills).toContain('class="settings-section-title"');
  expect(skills.indexOf("settings-section-title")).toBeLessThan(skills.indexOf("skills-page-tabs"));
  expect(skills).toContain('data-i18n="settings.skills.title"');
});

test("skills sub-tabs use the settings body type scale", () => {
  const css = readFileSync(
    resolve(process.cwd(), "public/native/settings/skills-page.css"),
    "utf8",
  );
  const tab = ruleBody(css, ".skills-page-tab");
  expect(tab).toContain("font: inherit");
  expect(tab).toContain("font-size: var(--font-size-md)");
});
