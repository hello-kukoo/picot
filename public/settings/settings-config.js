// ABOUTME: Renders the agent settings.json, AGENTS.md, and APPEND_SYSTEM.md
// ABOUTME: editors on the Settings Configuration page behind an injected gateway.
// Settings → Configuration tab: inline editors for the global agent-config and
// system-prompt context files. Transport is supplied by the injected gateway so
// legacy and native runtimes can share the renderer.

import { t } from "../i18n.js";

function wireFileEditor({
  configGateway,
  pathEl,
  textareaEl,
  errorEl,
  saveBtn,
  readOp,
  writeOp,
  prepareContent,
  validate,
  clearSaveMessage,
  setSaveButtonSaving,
  showSaveError,
  showSaveSuccess,
}) {
  async function load() {
    if (!textareaEl) return;
    errorEl?.classList.add("hidden");
    textareaEl.value = "";
    if (pathEl) pathEl.textContent = t("native.settings.settingsConfig.textcontent.loading");
    try {
      const data = await configGateway.call(readOp);
      if (!data?.ok) throw new Error(data?.error || "Failed to load file");
      textareaEl.value = prepareContent ? prepareContent(data.data.content) : data.data.content;
      if (pathEl) pathEl.textContent = data.data.path || "";
    } catch (e) {
      if (pathEl) pathEl.textContent = "";
      if (errorEl) {
        errorEl.textContent = e.message || String(e);
        errorEl.classList.remove("hidden");
      }
    }
  }

  saveBtn?.addEventListener("click", async () => {
    if (!textareaEl) return;
    clearSaveMessage(errorEl);
    const content = textareaEl.value;
    if (validate) {
      const error = validate(content);
      if (error) {
        showSaveError(errorEl, error);
        return;
      }
    }
    setSaveButtonSaving(saveBtn, true);
    try {
      const data = await configGateway.call(writeOp, { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save file");
      showSaveSuccess(errorEl);
    } catch (e) {
      showSaveError(errorEl, e.message || String(e));
    } finally {
      setSaveButtonSaving(saveBtn, false);
    }
  });

  return { load };
}

function prettyPrintJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function validateJson(content) {
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    return `Invalid JSON: ${e.message}`;
  }
}

export function setupSettingsConfig({
  configGateway,
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}) {
  const editorOptions = {
    configGateway,
    clearSaveMessage: clearSettingsSaveMessage,
    setSaveButtonSaving: setSettingsSaveButtonSaving,
    showSaveError: showSettingsSaveError,
    showSaveSuccess: showSettingsSaveSuccess,
  };

  const inlineConfigEditor = wireFileEditor({
    ...editorOptions,
    pathEl: document.getElementById("inline-config-path"),
    textareaEl: document.getElementById("inline-config-textarea"),
    errorEl: document.getElementById("inline-config-error"),
    saveBtn: document.getElementById("inline-config-save"),
    readOp: "read_agent_config",
    writeOp: "write_agent_config",
    prepareContent: prettyPrintJson,
    validate: validateJson,
  });

  const agentsMdEditor = wireFileEditor({
    ...editorOptions,
    pathEl: document.getElementById("agents-md-path"),
    textareaEl: document.getElementById("agents-md-textarea"),
    errorEl: document.getElementById("agents-md-error"),
    saveBtn: document.getElementById("agents-md-save"),
    readOp: "read_agents_md",
    writeOp: "write_agents_md",
  });

  const appendSystemMdEditor = wireFileEditor({
    ...editorOptions,
    pathEl: document.getElementById("append-system-md-path"),
    textareaEl: document.getElementById("append-system-md-textarea"),
    errorEl: document.getElementById("append-system-md-error"),
    saveBtn: document.getElementById("append-system-md-save"),
    readOp: "read_append_system_md",
    writeOp: "write_append_system_md",
  });

  return {
    loadInlineConfigEditor: inlineConfigEditor.load,
    loadAgentsMdEditor: agentsMdEditor.load,
    loadAppendSystemMdEditor: appendSystemMdEditor.load,
  };
}
