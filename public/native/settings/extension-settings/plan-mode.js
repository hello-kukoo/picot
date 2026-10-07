// ABOUTME: pi-plan-mode settings: default mode and model selection.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (bridge plane).

import { t } from "../../../i18n.js";
import {
  appendModelOptions,
  loadModelChoices,
  noteWhenCatalogUnavailable,
} from "./model-choices.js";

export async function renderPlanModeSettings(detailEl, _pkg, configGateway) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionPlanMode.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionPlanMode.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await configGateway
    .call("planMode.config.get")
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const data = result.data ?? {};
  if (data.invalid) {
    // An unreadable file is reported, never rendered as "defaults": the ops
    // refuse to write onto it, so the page must not pretend to edit it.
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    error.textContent = data.invalid.reason || "invalid config";
    const note = document.createElement("p");
    note.className = "settings-help";
    note.textContent = t("settings.extensionPlanMode.invalidNote");
    section.append(error, note);
    return;
  }
  const settings = data.settings ?? {};

  const save = async (key, value) => {
    const saved = await configGateway
      .call("planMode.config.set", { key, value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return false;
    }
    status.textContent = t("settings.saved");
    return true;
  };

  const selectRow = (labelKey, options, current, onchange) => {
    const select = document.createElement("select");
    for (const option of options) {
      const el = document.createElement("option");
      el.value = option;
      el.textContent = option;
      el.selected = option === current;
      select.append(el);
    }
    select.addEventListener("change", () => onchange(select.value));
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = t(labelKey);
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, select);
    section.append(row);
    return select;
  };

  const PLAN_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const IMPL_LEVELS = PLAN_LEVELS.slice(1);
  selectRow(
    "settings.extensionPlanMode.thinkingLabel",
    PLAN_LEVELS,
    typeof settings.thinkingLevel === "string" ? settings.thinkingLevel : "inherit",
    (value) => void save("thinkingLevel", value),
  );

  // Implementation model: the composer's own picker list (enabled + scoped)
  // plus the follow-plan-model clear row.
  const modelSelect = document.createElement("select");
  const followOption = document.createElement("option");
  followOption.value = "";
  followOption.textContent = t("settings.extensionPlanMode.followPlanModel");
  modelSelect.append(followOption);
  const storedModel =
    typeof settings.defaultImplementationModel === "string"
      ? settings.defaultImplementationModel
      : "";
  const choices = await loadModelChoices(configGateway);
  appendModelOptions(modelSelect, choices);
  if (storedModel && ![...modelSelect.options].some((o) => o.value === storedModel)) {
    const stale = document.createElement("option");
    stale.value = storedModel;
    stale.textContent = storedModel;
    modelSelect.append(stale);
  }
  modelSelect.value = storedModel;
  noteWhenCatalogUnavailable(section, choices);
  modelSelect.addEventListener(
    "change",
    () => void save("defaultImplementationModel", modelSelect.value || null),
  );
  const modelLabel = document.createElement("span");
  modelLabel.className = "settings-label";
  modelLabel.textContent = t("settings.extensionPlanMode.implModelLabel");
  const modelRow = document.createElement("div");
  modelRow.className = "settings-row";
  modelRow.append(modelLabel, modelSelect);
  section.append(modelRow);

  selectRow(
    "settings.extensionPlanMode.implThinkingLabel",
    IMPL_LEVELS,
    typeof settings.defaultImplementationThinkingLevel === "string"
      ? settings.defaultImplementationThinkingLevel
      : "off",
    (value) => void save("defaultImplementationThinkingLevel", value),
  );
  selectRow(
    "settings.extensionPlanMode.retentionLabel",
    ["clear-on-start", "clear-after-first-run", "keep"],
    typeof settings.implementationPlanRetention === "string"
      ? settings.implementationPlanRetention
      : "clear-on-start",
    (value) => void save("implementationPlanRetention", value),
  );

  const exportInput = document.createElement("input");
  exportInput.type = "text";
  exportInput.placeholder = "PLAN.md";
  exportInput.value =
    typeof settings.defaultPlanExportPath === "string" ? settings.defaultPlanExportPath : "";
  exportInput.addEventListener(
    "change",
    () => void save("defaultPlanExportPath", exportInput.value.trim() || null),
  );
  const exportLabel = document.createElement("span");
  exportLabel.className = "settings-label";
  exportLabel.textContent = t("settings.extensionPlanMode.exportPathLabel");
  const exportRow = document.createElement("div");
  exportRow.className = "settings-row";
  exportRow.append(exportLabel, exportInput);
  section.append(exportRow);

  const shortcutInput = document.createElement("input");
  shortcutInput.type = "text";
  shortcutInput.spellcheck = false;
  shortcutInput.value = typeof settings.toggleShortcut === "string" ? settings.toggleShortcut : "";
  shortcutInput.addEventListener(
    "change",
    () => void save("toggleShortcut", shortcutInput.value.trim() || null),
  );
  const shortcutLabel = document.createElement("span");
  shortcutLabel.className = "settings-label";
  shortcutLabel.textContent = t("settings.extensionPlanMode.shortcutLabel");
  const shortcutRow = document.createElement("div");
  shortcutRow.className = "settings-row";
  shortcutRow.append(shortcutLabel, shortcutInput);
  section.append(shortcutRow);

  // Advanced: raw JSON editors for defaultPlanTools + safeSubcommands.
  const advanced = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = t("settings.extensionPlanMode.advancedGroup");
  advanced.append(summary);
  for (const [key, i18nKey] of [
    ["defaultPlanTools", "planToolsLabel"],
    ["safeSubcommands", "safeSubcommandsLabel"],
  ]) {
    const areaLabel = document.createElement("p");
    areaLabel.className = "settings-label";
    areaLabel.textContent = t(`settings.extensionPlanMode.${i18nKey}`);
    const area = document.createElement("textarea");
    area.rows = 4;
    area.spellcheck = false;
    area.value = JSON.stringify(settings[key] ?? (key === "safeSubcommands" ? {} : []), null, 2);
    const notice = document.createElement("span");
    notice.className = "pkg-ext-notice";
    area.addEventListener("change", async () => {
      notice.textContent = "";
      let parsed;
      try {
        parsed = JSON.parse(area.value);
      } catch {
        notice.textContent = t("settings.extensionPlanMode.invalidJson");
        return;
      }
      const ok = await save(key, parsed);
      if (!ok) notice.textContent = status.textContent;
    });
    advanced.append(areaLabel, area, notice);
  }
  section.append(advanced);
}
