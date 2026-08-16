// ABOUTME: Asserts the Settings page split between Configuration and Models.
// ABOUTME: Locks navigation, panel placement, activation routing, and locale titles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

describe("settings page split", () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");

  test("adds a Models navigation entry", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    expect(document.querySelector('[data-settings-tab="models"]')).not.toBeNull();
    expect(document.querySelector('[data-settings-tab="models"]').dataset.i18n).toBe(
      "settings.models.title",
    );
    expect(document.querySelector('[data-settings-panel="models"]')).not.toBeNull();
  });

  test("splits Configuration and Models panels by ownership", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    const configurationPanel = document.querySelector('[data-settings-panel="configuration"]');
    const modelsPanel = document.querySelector('[data-settings-panel="models"]');

    expect(configurationPanel).not.toBeNull();
    expect(modelsPanel).not.toBeNull();
    expect(configurationPanel.querySelector("#inline-config-textarea")).not.toBeNull();
    expect(configurationPanel.querySelector("#settings-api-keys")).toBeNull();
    expect(configurationPanel.querySelector("#inline-models-textarea")).toBeNull();
    expect(modelsPanel.querySelector("#settings-api-keys")).not.toBeNull();
    expect(modelsPanel.querySelector("#inline-models-textarea")).not.toBeNull();
  });

  test("removes the non-functional Protection markup", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    expect(document.querySelector("#settings-auth-section")).toBeNull();
    expect(document.querySelector("#toggle-auth")).toBeNull();
  });

  test("activates the Models page through app.js routing", () => {
    expect(appJs).toContain('if (targetTabKey === "models")');
    expect(appJs).toContain("modelsPage.activate()");
    expect(appJs).not.toContain('rpcCommand({ type: "get_auth" })');
  });

  test("orders navigation and disables the Agent Inbox", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    const tabs = [...document.querySelectorAll(".settings-nav-item")].map(
      (item) => item.dataset.settingsTab,
    );
    expect(tabs).toEqual([
      "general",
      "models",
      "skills",
      "extensions",
      "configuration",
      "usage",
      "chat",
    ]);

    const chatItem = document.querySelector('[data-settings-tab="chat"]');
    expect(chatItem).not.toBeNull();
    expect(chatItem.disabled).toBe(true);
  });

  test("renames Configuration to Advanced Configuration in every locale", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    expect(document.querySelector('[data-settings-tab="configuration"]').dataset.i18n).toBe(
      "settings.configuration",
    );

    for (const locale of ["en", "es", "ja", "zh"]) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), `public/locales/${locale}.json`), "utf8"),
      );
      expect(messages.settings.configuration).toEqual(expect.any(String));
      expect(messages.settings.configuration.trim()).not.toBe("");
    }
  });

  test("resolves the Models navigation title in every locale", () => {
    for (const locale of ["en", "es", "ja", "zh"]) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), `public/locales/${locale}.json`), "utf8"),
      );
      expect(messages.settings.models.title).toEqual(expect.any(String));
      expect(messages.settings.models.title.trim()).not.toBe("");
    }
  });
});
