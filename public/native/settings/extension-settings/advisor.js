// ABOUTME: Advisor settings: default model and thinking level for the advisor subagent.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (bridge plane).

import { t } from "../../../i18n.js";
import {
  appendModelOptions,
  loadModelChoices,
  noteWhenCatalogUnavailable,
} from "./model-choices.js";
import { fieldRow } from "./shared.js";

export async function renderAdvisorSettings(detailEl, _pkg, configGateway) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionAdvisor.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionAdvisor.hint");
  section.appendChild(hint);

  const modelSelect = document.createElement("select");
  const modelRow = fieldRow(t("settings.extensionAdvisor.modelLabel"), modelSelect);
  const effortSelect = document.createElement("select");
  const effortNotice = document.createElement("span");
  effortNotice.className = "pkg-ext-notice";
  const effortRow = fieldRow(
    t("settings.extensionAdvisor.effortLabel"),
    effortSelect,
    effortNotice,
  );
  const status = document.createElement("div");
  status.className = "pkg-ext-status";

  section.append(modelRow, effortRow, status);
  detailEl.appendChild(section);

  const result = await configGateway
    .call("advisor.config.get")
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = String(result.error ?? "load failed");
    return;
  }
  const { modelKey, effort, models } = result.data;
  const levelsByKey = new Map(models.map((m) => [m.key, m.levels]));

  const offOption = document.createElement("option");
  offOption.value = "";
  offOption.textContent = t("settings.extensionAdvisor.off");
  modelSelect.appendChild(offOption);
  // Same picker list as the composer (enabled + scoped); the op still owns the
  // per-model effort levels, so the two lists share one source of truth.
  const choices = await loadModelChoices(configGateway);
  appendModelOptions(modelSelect, choices);
  noteWhenCatalogUnavailable(section, choices);
  // A stored model outside the available list stays visible as its raw key so
  // the select never silently displays blank; the user can re-point or disable.
  if (modelKey && ![...modelSelect.options].some((o) => o.value === modelKey)) {
    const stale = document.createElement("option");
    stale.value = modelKey;
    stale.textContent = modelKey;
    modelSelect.appendChild(stale);
  }
  modelSelect.value = modelKey ?? "";

  function rebuildEffortOptions() {
    effortSelect.replaceChildren();
    const offEffort = document.createElement("option");
    offEffort.value = "";
    offEffort.textContent = t("settings.extensionAdvisor.effortOff");
    effortSelect.appendChild(offEffort);
    for (const level of levelsByKey.get(modelSelect.value) ?? []) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      effortSelect.appendChild(option);
    }
    effortSelect.disabled = !modelSelect.value;
  }
  rebuildEffortOptions();
  effortSelect.value = effort ?? "";
  // Last confirmed-saved pair — a failed save rolls the selects back here so
  // a write failure never changes what the controls display.
  let lastSaved = { modelKey: modelSelect.value, effort: effortSelect.value };

  async function save() {
    const attempted = { modelKey: modelSelect.value, effort: effortSelect.value };
    const saved = await configGateway
      .call("advisor.config.set", {
        modelKey: attempted.modelKey || null,
        effort: attempted.effort || null,
      })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (saved.ok) {
      lastSaved = attempted;
      status.textContent = t("settings.extensionAdvisor.saved");
      return;
    }
    modelSelect.value = lastSaved.modelKey;
    rebuildEffortOptions();
    effortSelect.value = lastSaved.effort;
    effortNotice.textContent = "";
    status.textContent = t("settings.extensionAdvisor.saveFailed", {
      message: String(saved.error ?? "save failed"),
    });
  }

  modelSelect.addEventListener("change", () => {
    const previousEffort = effortSelect.value;
    rebuildEffortOptions();
    // replaceChildren resets the select to its first option — restore the
    // previous effort when the new model still supports it, else reset to off.
    if (previousEffort && (levelsByKey.get(modelSelect.value) ?? []).includes(previousEffort)) {
      effortSelect.value = previousEffort;
      effortNotice.textContent = "";
    } else {
      effortSelect.value = "";
      effortNotice.textContent = t("settings.extensionAdvisor.effortReset");
    }
    void save();
  });
  effortSelect.addEventListener("change", () => {
    effortNotice.textContent = "";
    void save();
  });
}
