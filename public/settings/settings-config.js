// ABOUTME: Renders the Agent settings.json editor on the Settings Configuration page.
// ABOUTME: Keeps agent-config editing behind an injected configuration gateway.
// Settings → Configuration tab: the inline agent-config editor. Transport is
// supplied by the injected gateway so legacy and native runtimes can share the
// renderer.

import { t } from "../i18n.js";

export function setupSettingsConfig({
  configGateway,
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}) {
  const inlineConfigPath = document.getElementById("inline-config-path");
  const inlineConfigTextarea = document.getElementById("inline-config-textarea");
  const inlineConfigError = document.getElementById("inline-config-error");
  const inlineConfigSave = document.getElementById("inline-config-save");

  async function loadInlineConfigEditor() {
    if (!inlineConfigTextarea) return;
    inlineConfigError?.classList.add("hidden");
    inlineConfigTextarea.value = "";
    if (inlineConfigPath)
      inlineConfigPath.textContent = t("native.settings.settingsConfig.textcontent.loading");
    try {
      const data = await configGateway.call("read_agent_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load config");
      try {
        inlineConfigTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineConfigTextarea.value = data.data.content;
      }
      if (inlineConfigPath) inlineConfigPath.textContent = data.data.path || "";
    } catch (e) {
      if (inlineConfigPath) inlineConfigPath.textContent = "";
      if (inlineConfigError) {
        inlineConfigError.textContent = e.message || String(e);
        inlineConfigError.classList.remove("hidden");
      }
    }
  }

  inlineConfigSave?.addEventListener("click", async () => {
    if (!inlineConfigTextarea) return;
    clearSettingsSaveMessage(inlineConfigError);
    const content = inlineConfigTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, `Invalid JSON: ${e.message}`);
      return;
    }
    setSettingsSaveButtonSaving(inlineConfigSave, true);
    try {
      const data = await configGateway.call("write_agent_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save config");
      showSettingsSaveSuccess(inlineConfigError);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineConfigSave, false);
    }
  });

  return { loadInlineConfigEditor };
}
