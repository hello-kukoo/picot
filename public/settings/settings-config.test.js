// ABOUTME: Covers the Agent settings.json editor on the Configuration page.
// ABOUTME: Verifies JSON load/pretty-print, validation, and write behavior.

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setupSettingsConfig } from "./settings-config.js";

let call;

beforeEach(() => {
  globalThis.window = new JSDOM(`
    <span id="inline-config-path"></span>
    <textarea id="inline-config-textarea"></textarea>
    <div id="inline-config-error" class="hidden"></div>
    <button id="inline-config-save">Save</button>
  `).window;
  globalThis.document = window.document;
  call = vi.fn(async (operation) => {
    if (operation === "read_agent_config") {
      return {
        ok: true,
        data: { path: "/home/.pi/agent/settings.json", content: '{"foo":true}' },
      };
    }
    if (operation === "write_agent_config") return { ok: true };
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

function createEditor() {
  return setupSettingsConfig({
    configGateway: { call },
    clearSettingsSaveMessage: vi.fn(),
    setSettingsSaveButtonSaving: vi.fn(),
    showSettingsSaveError: vi.fn(),
    showSettingsSaveSuccess: vi.fn(),
  });
}

test("loads and pretty-prints settings.json", async () => {
  const editor = createEditor();
  await editor.loadInlineConfigEditor();

  expect(document.querySelector("#inline-config-path").textContent).toBe(
    "/home/.pi/agent/settings.json",
  );
  expect(document.querySelector("#inline-config-textarea").value).toBe('{\n  "foo": true\n}');
});

test("does not write invalid JSON", () => {
  const showSettingsSaveError = vi.fn();
  setupSettingsConfig({
    configGateway: { call },
    clearSettingsSaveMessage: vi.fn(),
    setSettingsSaveButtonSaving: vi.fn(),
    showSettingsSaveError,
    showSettingsSaveSuccess: vi.fn(),
  });
  document.querySelector("#inline-config-textarea").value = "{invalid";
  document.querySelector("#inline-config-save").click();

  expect(call).not.toHaveBeenCalledWith("write_agent_config", expect.anything());
  expect(showSettingsSaveError).toHaveBeenCalledOnce();
});

test("writes valid settings.json content", async () => {
  const editor = createEditor();
  void editor;
  document.querySelector("#inline-config-textarea").value = '{"foo":true}';
  document.querySelector("#inline-config-save").click();

  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith("write_agent_config", {
      content: '{"foo":true}',
    }),
  );
});
