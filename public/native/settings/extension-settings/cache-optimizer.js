// ABOUTME: pi-cache-optimizer settings: footer stats mode.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderCacheOptimizerSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionCacheOptimizer.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionCacheOptimizer.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await transport
    .getCacheOptimizerConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  if (result.invalid) {
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    error.textContent = result.invalid.reason || "invalid config";
    const note = document.createElement("p");
    note.className = "settings-help";
    note.textContent = t("settings.extensionCacheOptimizer.invalidNote");
    section.append(error, note);
    return;
  }

  const modeSelect = document.createElement("select");
  for (const mode of ["total", "session", "process"]) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = t(`settings.extensionCacheOptimizer.mode_${mode}`);
    option.selected = result.effectiveFooterMode === mode;
    modeSelect.append(option);
  }
  modeSelect.disabled = result.footerModeSource === "env";
  modeSelect.addEventListener("change", async () => {
    const saved = await transport
      .setCacheOptimizerConfig({ key: "footerMode", value: modeSelect.value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    status.textContent = t("settings.saved");
  });
  const modeLabel = document.createElement("span");
  modeLabel.className = "settings-label";
  modeLabel.textContent = t("settings.extensionCacheOptimizer.footerModeLabel");
  const sourceBadge = document.createElement("span");
  sourceBadge.className = "pkg-ext-badge";
  sourceBadge.textContent = t(
    `settings.extensionCacheOptimizer.source_${result.footerModeSource ?? "default"}`,
  );
  const modeRow = document.createElement("div");
  modeRow.className = "settings-row";
  const modeControls = document.createElement("span");
  modeControls.className = "pkg-ext-controls";
  modeControls.append(modeSelect, sourceBadge);
  modeRow.append(modeLabel, modeControls);
  section.append(modeRow);

  if (Array.isArray(result.omitList) && result.omitList.length > 0) {
    const omitTitle = document.createElement("p");
    omitTitle.className = "settings-help";
    omitTitle.textContent = t("settings.extensionCacheOptimizer.omitTitle", {
      count: result.omitList.length,
    });
    const omitList = document.createElement("p");
    omitList.className = "settings-help";
    omitList.textContent = result.omitList.join(", ");
    section.append(omitTitle, omitList);
  }

  const envTitle = document.createElement("p");
  envTitle.className = "settings-label";
  envTitle.textContent = t("settings.extensionCacheOptimizer.envTitle");
  section.append(envTitle);
  for (const [name, on] of Object.entries(result.envSwitches ?? {})) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-label settings-label-sub";
    label.textContent = name;
    const state = document.createElement("span");
    state.className = "pkg-ext-badge";
    state.textContent = on
      ? t("settings.extensionCacheOptimizer.envOn")
      : t("settings.extensionCacheOptimizer.envOff");
    row.append(label, state);
    section.append(row);
  }
}
