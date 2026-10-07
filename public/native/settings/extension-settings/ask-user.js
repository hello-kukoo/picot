// ABOUTME: rpiv-ask-user-question settings: questionnaire overlay collapse shortcut.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";
import { fieldRow } from "./shared.js";

export async function renderAskUserSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionAskUser.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionAskUser.hint");
  section.appendChild(hint);

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.placeholder = "ctrl+]";
  keyInput.spellcheck = false;
  const keyError = document.createElement("span");
  keyError.className = "pkg-ext-notice";
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(
    fieldRow(t("settings.extensionAskUser.collapseKeyLabel"), keyInput, keyError),
    status,
  );
  detailEl.appendChild(section);

  const result = await transport
    .getAskUserConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  if (typeof result.values?.collapseKey === "string") keyInput.value = result.values.collapseKey;

  keyInput.addEventListener("change", async () => {
    keyError.textContent = "";
    const raw = keyInput.value.trim();
    const saved = await transport
      .setAskUserConfig({ key: "collapseKey", value: raw === "" ? null : raw })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      keyError.textContent = saved.error || "save failed";
      return;
    }
    if (typeof saved.values?.collapseKey === "string") keyInput.value = saved.values.collapseKey;
    status.textContent = t("settings.saved");
  });
}
