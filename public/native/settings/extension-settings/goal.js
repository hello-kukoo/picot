// ABOUTME: pi-goal settings: limits and rpc gate.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderGoalSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionGoal.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionGoal.hint");
  section.appendChild(hint);

  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.appendChild(status);
  detailEl.appendChild(section);

  const result = await transport
    .getGoalConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  if (result.invalid) {
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    error.textContent = result.invalid.reason || "invalid config";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "pkg-ext-clear-btn";
    resetBtn.textContent = t("settings.extensionGoal.reset");
    let armed = false;
    resetBtn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        resetBtn.textContent = t("settings.extensionGoal.resetConfirm");
        return;
      }
      const saved = await transport
        .setGoalConfig({ reset: true })
        .catch((error_) => ({ ok: false, error: error_?.message ?? String(error_) }));
      if (!saved.ok) {
        status.textContent = saved.error || "reset failed";
        return;
      }
      // Re-render the section with the fresh defaults.
      section.remove();
      await renderGoalSettings(detailEl, _pkg, transport);
    });
    section.append(error, resetBtn);
    return;
  }

  const settings = result.settings ?? {};
  const rpcToggle = document.createElement("button");
  rpcToggle.type = "button";
  rpcToggle.className = `settings-toggle${settings.rpc?.enabled === true ? " on" : ""}`;
  rpcToggle.setAttribute("role", "switch");
  rpcToggle.setAttribute("aria-checked", String(settings.rpc?.enabled === true));
  rpcToggle.addEventListener("click", async () => {
    const next = !(rpcToggle.getAttribute("aria-checked") === "true");
    const saved = await transport
      .setGoalConfig({ key: "rpc.enabled", value: next })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    rpcToggle.classList.toggle("on", next);
    rpcToggle.setAttribute("aria-checked", String(next));
    status.textContent = t("settings.saved");
  });
  const rpcLabel = document.createElement("span");
  rpcLabel.className = "settings-label settings-label-stack";
  const rpcMain = document.createElement("span");
  rpcMain.className = "settings-label-main";
  rpcMain.textContent = t("settings.extensionGoal.rpcLabel");
  const rpcSub = document.createElement("span");
  rpcSub.className = "settings-label-sub";
  rpcSub.textContent = t("settings.extensionGoal.rpcDesc");
  rpcLabel.append(rpcMain, rpcSub);
  // The package accepts a removed legacy setting and only warns about it
  // (docs/settings.md); mirror that instead of blocking the file.
  if (result.legacyExperimentalGoals) {
    const legacy = document.createElement("p");
    legacy.className = "settings-help";
    legacy.textContent = t("settings.extensionGoal.legacyWarning");
    section.append(legacy);
  }
  const rpcRow = document.createElement("div");
  rpcRow.className = "settings-row";
  rpcRow.append(rpcLabel, rpcToggle);
  section.append(rpcRow);

  for (const field of ["automaticTurns", "noProgressTurns"]) {
    const stored = settings.continuationLimits?.[field];
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.value = typeof stored === "number" ? String(stored) : "";
    input.disabled = stored === null;
    const unlimited = document.createElement("input");
    unlimited.type = "checkbox";
    unlimited.checked = stored === null;
    const unlimitedLabel = document.createElement("span");
    unlimitedLabel.className = "settings-label";
    unlimitedLabel.textContent = t("settings.extensionGoal.unlimited");
    unlimited.addEventListener("change", async () => {
      const saved = await transport
        .setGoalConfig({
          key: `continuationLimits.${field}`,
          value: unlimited.checked ? null : Number.parseInt(input.value || "1", 10),
        })
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!saved.ok) {
        status.textContent = saved.error || "save failed";
        unlimited.checked = !unlimited.checked;
        return;
      }
      input.disabled = unlimited.checked;
      status.textContent = t("settings.saved");
    });
    input.addEventListener("change", async () => {
      const turns = Number.parseInt(input.value, 10);
      if (!Number.isInteger(turns) || turns < 1) {
        status.textContent = t("settings.extensionGoal.limitError");
        return;
      }
      const saved = await transport
        .setGoalConfig({ key: `continuationLimits.${field}`, value: turns })
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!saved.ok) {
        status.textContent = saved.error || "save failed";
        return;
      }
      status.textContent = t("settings.saved");
    });
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = t(`settings.extensionGoal.${field}Label`);
    const row = document.createElement("div");
    row.className = "settings-row";
    const controls = document.createElement("span");
    controls.className = "pkg-ext-controls";
    controls.append(input, unlimitedLabel, unlimited);
    row.append(label, controls);
    section.append(row);
  }
}
