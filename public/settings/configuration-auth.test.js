import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

describe("settings page split", () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");

  test("moves provider credentials and models.json into the Models panel", () => {
    const dom = new JSDOM(html);
    const { document } = dom.window;

    expect(document.querySelector('[data-settings-tab="auth"]')).toBeNull();
    expect(document.querySelector('[data-settings-panel="auth"]')).toBeNull();

    const configurationPanel = document.querySelector('[data-settings-panel="configuration"]');
    const modelsPanel = document.querySelector('[data-settings-panel="models"]');

    expect(configurationPanel.querySelector("#inline-config-textarea")).not.toBeNull();
    expect(configurationPanel.querySelector("#settings-api-keys")).toBeNull();
    expect(configurationPanel.querySelector("#inline-models-textarea")).toBeNull();
    expect(modelsPanel.querySelector("#settings-api-keys")).not.toBeNull();
    expect(modelsPanel.querySelector("#inline-models-textarea")).not.toBeNull();
  });

  test("opens provider and model editing through their own tabs", () => {
    expect(appJs).toContain('openSettings("models")');
    expect(appJs).toContain('selectSettingsTab("models")');
    expect(appJs).not.toContain('selectSettingsTab("auth")');
  });

  test("mobile QR surfaces run on native pairing, never the retired route", () => {
    const dom = new JSDOM(html, { url: "http://localhost:3001/" });
    const { document } = dom.window;

    // Original contract: never print a raw LAN URL in Settings.
    expect(Boolean(document.querySelector("#setting-lan-url-value"))).toBe(false);
    // The toolbar QR button + modal are restored (Dr. Lin: only Telegram was
    // meant to go). They mint a native pairing token on open; the retired
    // /api/lan-qr dataUrl route stays dead.
    expect(document.querySelector("#lan-qr-btn")).not.toBeNull();
    expect(document.querySelector("#lan-qr-modal")).not.toBeNull();
    expect(appJs).not.toContain("/api/lan-qr");
  });
});
