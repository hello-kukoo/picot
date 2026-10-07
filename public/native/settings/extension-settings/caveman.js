// ABOUTME: pi-caveman settings: default level and status toggle.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderCavemanSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionCaveman.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionCaveman.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await transport
    .getCavemanConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const levelSelect = document.createElement("select");
  for (const level of [
    "off",
    "lite",
    "full",
    "ultra",
    "wenyan-lite",
    "wenyan",
    "wenyan-ultra",
    "micro",
  ]) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    option.selected = result.effective?.defaultLevel === level;
    levelSelect.append(option);
  }
  levelSelect.addEventListener("change", async () => {
    const saved = await transport
      .setCavemanConfig({ key: "defaultLevel", value: levelSelect.value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    status.textContent = t("settings.saved");
  });
  const levelLabel = document.createElement("span");
  levelLabel.className = "settings-label";
  levelLabel.textContent = t("settings.extensionCaveman.levelLabel");
  const levelRow = document.createElement("div");
  levelRow.className = "settings-row";
  levelRow.append(levelLabel, levelSelect);
  section.append(levelRow);

  const statusToggle = document.createElement("button");
  statusToggle.type = "button";
  statusToggle.className = `settings-toggle${result.effective?.showStatus === true ? " on" : ""}`;
  statusToggle.setAttribute("role", "switch");
  statusToggle.setAttribute("aria-checked", String(result.effective?.showStatus === true));
  statusToggle.addEventListener("click", async () => {
    const next = !(statusToggle.getAttribute("aria-checked") === "true");
    const saved = await transport
      .setCavemanConfig({ key: "showStatus", value: next })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    statusToggle.classList.toggle("on", next);
    statusToggle.setAttribute("aria-checked", String(next));
    status.textContent = t("settings.saved");
  });
  const statusLabel = document.createElement("span");
  statusLabel.className = "settings-label";
  statusLabel.textContent = t("settings.extensionCaveman.statusLabel");
  const statusRow = document.createElement("div");
  statusRow.className = "settings-row";
  statusRow.append(statusLabel, statusToggle);
  section.append(statusRow);
}
