// ABOUTME: Covers the Configuration page editors: agent settings.json,
// ABOUTME: AGENTS.md, and APPEND_SYSTEM.md load/validate/write behavior.

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
    <span id="agents-md-path"></span>
    <textarea id="agents-md-textarea"></textarea>
    <div id="agents-md-error" class="hidden"></div>
    <button id="agents-md-save">Save</button>
    <span id="append-system-md-path"></span>
    <textarea id="append-system-md-textarea"></textarea>
    <div id="append-system-md-error" class="hidden"></div>
    <button id="append-system-md-save">Save</button>
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
    if (operation === "read_agents_md") {
      return {
        ok: true,
        data: { path: "/home/.pi/agent/AGENTS.md", content: "# Global rules", exists: true },
      };
    }
    if (operation === "write_agents_md") return { ok: true };
    if (operation === "read_append_system_md") {
      return {
        ok: true,
        data: { path: "/home/.pi/agent/APPEND_SYSTEM.md", content: "", exists: false },
      };
    }
    if (operation === "write_append_system_md") return { ok: true };
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

test("loads AGENTS.md verbatim", async () => {
  const editor = createEditor();
  await editor.loadAgentsMdEditor();

  expect(document.querySelector("#agents-md-path").textContent).toBe("/home/.pi/agent/AGENTS.md");
  expect(document.querySelector("#agents-md-textarea").value).toBe("# Global rules");
});

test("writes AGENTS.md content without JSON validation", async () => {
  createEditor();
  document.querySelector("#agents-md-textarea").value = "Not JSON: just markdown {";
  document.querySelector("#agents-md-save").click();

  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith("write_agents_md", {
      content: "Not JSON: just markdown {",
    }),
  );
});

test("loads a missing APPEND_SYSTEM.md as empty content with its path", async () => {
  const editor = createEditor();
  await editor.loadAppendSystemMdEditor();

  expect(document.querySelector("#append-system-md-path").textContent).toBe(
    "/home/.pi/agent/APPEND_SYSTEM.md",
  );
  expect(document.querySelector("#append-system-md-textarea").value).toBe("");
});

test("writes APPEND_SYSTEM.md content", async () => {
  createEditor();
  document.querySelector("#append-system-md-textarea").value = "Always answer briefly.";
  document.querySelector("#append-system-md-save").click();

  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith("write_append_system_md", {
      content: "Always answer briefly.",
    }),
  );
});
