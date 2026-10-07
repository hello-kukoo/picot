// ABOUTME: rpiv-todo settings: todo panel behaviour toggles.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";
import { fieldRow } from "./shared.js";

export async function renderTodoSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionTodo.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionTodo.hint");
  section.appendChild(hint);

  const lineInput = document.createElement("input");
  lineInput.type = "number";
  lineInput.min = "3";
  lineInput.placeholder = "12";
  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.placeholder = "ctrl+shift+t";
  keyInput.spellcheck = false;
  const lineError = document.createElement("span");
  lineError.className = "pkg-ext-notice";
  const keyError = document.createElement("span");
  keyError.className = "pkg-ext-notice";

  const lineRow = fieldRow(t("settings.extensionTodo.maxLinesLabel"), lineInput, lineError);
  const keyRow = fieldRow(t("settings.extensionTodo.collapseKeyLabel"), keyInput, keyError);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(lineRow, keyRow, status);
  detailEl.appendChild(section);

  const result = await transport
    .getTodoConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const values = result.values ?? {};
  if (typeof values.maxWidgetLines === "number") lineInput.value = String(values.maxWidgetLines);
  if (typeof values.collapseKey === "string") keyInput.value = values.collapseKey;

  lineInput.addEventListener("change", async () => {
    lineError.textContent = "";
    const raw = lineInput.value.trim();
    const value = raw === "" ? null : Number.parseInt(raw, 10);
    if (value !== null && (!Number.isInteger(value) || value < 3)) {
      lineError.textContent = t("settings.extensionTodo.maxLinesError");
      return;
    }
    const saved = await transport
      .setTodoConfig({ key: "maxWidgetLines", value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      lineError.textContent = saved.error || "save failed";
      return;
    }
    status.textContent = t("settings.saved");
  });

  keyInput.addEventListener("change", async () => {
    keyError.textContent = "";
    const raw = keyInput.value.trim();
    const value = raw === "" ? null : raw;
    const saved = await transport
      .setTodoConfig({ key: "collapseKey", value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      // The host validator mirrors the package grammar; surface it verbatim.
      keyError.textContent = saved.error || "save failed";
      return;
    }
    if (typeof saved.values?.collapseKey === "string") keyInput.value = saved.values.collapseKey;
    status.textContent = t("settings.saved");
  });
}
