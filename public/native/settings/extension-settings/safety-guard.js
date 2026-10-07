// ABOUTME: safety-guard settings: guard model and tool policy.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (bridge plane).

import { t } from "../../../i18n.js";
import {
  appendModelOptions,
  loadModelChoices,
  noteWhenCatalogUnavailable,
} from "./model-choices.js";

export async function renderSafetyGuardSettings(detailEl, _pkg, configGateway) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionSafetyGuard.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionSafetyGuard.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await configGateway
    .call("safetyGuard.config.get")
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const data = result.data ?? {};
  if (data.invalid) {
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    error.textContent = data.invalid.reason || "invalid config";
    const note = document.createElement("p");
    note.className = "settings-help";
    note.textContent = t("settings.extensionSafetyGuard.invalidNote");
    section.append(error, note);
    return;
  }
  const config = data.config ?? {};
  const readOnly = Boolean(data.relocatedByEnv);
  if (readOnly) {
    const badge = document.createElement("span");
    badge.className = "pkg-ext-badge";
    badge.textContent = t("settings.extensionSafetyGuard.relocatedBadge", {
      name: "PI_SAFETY_GUARD_CONFIG_FILE",
    });
    section.append(badge);
  }

  const post = async (payload) => {
    const saved = await configGateway
      .call("safetyGuard.config.set", payload)
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return false;
    }
    status.textContent = t("settings.saved");
    return true;
  };
  const save = (key, value) => post({ key, value });

  const switchRow = (labelText, key, current) => {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `settings-toggle${current === true ? " on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(current === true));
    toggle.disabled = readOnly;
    toggle.addEventListener("click", async () => {
      const next = !(toggle.getAttribute("aria-checked") === "true");
      if (await save(key, next)) {
        toggle.classList.toggle("on", next);
        toggle.setAttribute("aria-checked", String(next));
      }
    });
    const label = document.createElement("span");
    label.className = "settings-label settings-label-sub";
    label.textContent = labelText;
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, toggle);
    section.append(row);
    return toggle;
  };

  switchRow(t("settings.extensionSafetyGuard.masterLabel"), "enabled", config.enabled !== false);

  const categoriesTitle = document.createElement("p");
  categoriesTitle.className = "settings-label";
  categoriesTitle.textContent = t("settings.extensionSafetyGuard.categoriesGroup");
  section.append(categoriesTitle);
  for (const category of [
    "git",
    "filesystem",
    "docker",
    "package",
    "system",
    "database",
    "secrets",
  ]) {
    const current = config.categories?.[category] !== false;
    switchRow(
      t(`settings.extensionSafetyGuard.category_${category}`),
      `categories.${category}`,
      current,
    );
  }

  const pathsTitle = document.createElement("p");
  pathsTitle.className = "settings-label";
  pathsTitle.textContent = t("settings.extensionSafetyGuard.protectedPathsGroup");
  section.append(pathsTitle);
  switchRow(
    t("settings.extensionSafetyGuard.protectWrite"),
    "protectedPaths.write",
    config.protectedPaths?.write !== false,
  );
  switchRow(
    t("settings.extensionSafetyGuard.protectEdit"),
    "protectedPaths.edit",
    config.protectedPaths?.edit !== false,
  );

  const stepperRow = (labelText, key, current) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "20";
    input.value = String(current ?? 3);
    input.disabled = readOnly;
    input.addEventListener("change", async () => {
      const value = Number.parseInt(input.value, 10);
      if (!Number.isInteger(value) || value < 0 || value > 20) {
        status.textContent = t("settings.extensionSafetyGuard.rangeError");
        return;
      }
      await save(key, value);
    });
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = labelText;
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, input);
    section.append(row);
  };
  stepperRow(
    t("settings.extensionSafetyGuard.contextBefore"),
    "contextLines.before",
    config.contextLines?.before,
  );
  stepperRow(
    t("settings.extensionSafetyGuard.contextAfter"),
    "contextLines.after",
    config.contextLines?.after,
  );

  const autoTitle = document.createElement("p");
  autoTitle.className = "settings-label";
  autoTitle.textContent = t("settings.extensionSafetyGuard.autoReviewGroup");
  section.append(autoTitle);
  switchRow(
    t("settings.extensionSafetyGuard.autoReviewLabel"),
    "autoReview.enabled",
    config.autoReview?.enabled === true,
  );
  // Reviewer model: the composer's own picker list (enabled + scoped), so the
  // guard can only be pointed at a model the session can actually reach.
  const modelSelect = document.createElement("select");
  const unsetOption = document.createElement("option");
  unsetOption.value = "";
  unsetOption.textContent = t("settings.extensionSafetyGuard.modelUnset");
  modelSelect.append(unsetOption);
  const modelChoices = await loadModelChoices(configGateway);
  appendModelOptions(modelSelect, modelChoices);
  const storedModel = config.autoReview?.model;
  const storedKey =
    storedModel?.provider && storedModel?.modelId
      ? `${storedModel.provider}/${storedModel.modelId}`
      : "";
  if (storedKey && ![...modelSelect.options].some((o) => o.value === storedKey)) {
    const stale = document.createElement("option");
    stale.value = storedKey;
    stale.textContent = storedKey;
    modelSelect.append(stale);
  }
  modelSelect.value = storedKey;
  modelSelect.disabled = readOnly;
  modelSelect.addEventListener("change", async () => {
    const raw = modelSelect.value;
    const [provider, ...rest] = raw.split("/");
    const modelId = rest.join("/");
    // Provider + modelId are one package-level value: an `entries` batch
    // keeps them from landing as a mismatched pair (and clears both together).
    await post({
      entries: [
        { key: "autoReview.model.provider", value: raw ? provider : null },
        { key: "autoReview.model.modelId", value: raw ? modelId : null },
      ],
    });
  });
  noteWhenCatalogUnavailable(section, modelChoices);
  const modelLabel = document.createElement("span");
  modelLabel.className = "settings-label";
  modelLabel.textContent = t("settings.extensionSafetyGuard.modelLabel");
  const modelRow = document.createElement("div");
  modelRow.className = "settings-row";
  modelRow.append(modelLabel, modelSelect);
  section.append(modelRow);

  const levelSelect = document.createElement("select");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    option.selected =
      (typeof config.autoReview?.model?.thinkingLevel === "string"
        ? config.autoReview.model.thinkingLevel
        : "off") === level;
    levelSelect.append(option);
  }
  levelSelect.disabled = readOnly;
  levelSelect.addEventListener("change", async () => {
    await save("autoReview.model.thinkingLevel", levelSelect.value);
  });
  const levelLabel = document.createElement("span");
  levelLabel.className = "settings-label";
  levelLabel.textContent = t("settings.extensionSafetyGuard.thinkingLevelLabel");
  const levelRow = document.createElement("div");
  levelRow.className = "settings-row";
  levelRow.append(levelLabel, levelSelect);
  section.append(levelRow);

  const allow = document.createElement("p");
  allow.className = "settings-help";
  allow.textContent = t("settings.extensionSafetyGuard.allowCounts", {
    count: data.allowCounts?.global ?? 0,
  });
  section.append(allow);
}
