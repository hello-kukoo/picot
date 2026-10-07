// ABOUTME: pi-vcc settings: compaction booleans.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderVccSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionVcc.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionVcc.hint");
  section.appendChild(hint);

  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.appendChild(status);
  detailEl.appendChild(section);

  const result = await transport
    .getVccConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  if (result.relocatedByEnv) {
    const badge = document.createElement("span");
    badge.className = "pkg-ext-badge";
    badge.textContent = t("settings.extensionVcc.relocatedBadge", {
      name: "PI_VCC_CONFIG_PATH",
    });
    section.appendChild(badge);
  }
  const readOnly = Boolean(result.relocatedByEnv);

  const fields = [
    "overrideDefaultCompaction",
    "smartKeepTail",
    "continueAfterThresholdCompact",
    "debug",
  ];
  for (const field of fields) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `settings-toggle${result.values?.[field] === true ? " on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(result.values?.[field] === true));
    toggle.disabled = readOnly;
    toggle.addEventListener("click", async () => {
      const next = !(toggle.getAttribute("aria-checked") === "true");
      const saved = await transport
        .setVccConfig({ key: field, value: next })
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!saved.ok) {
        status.textContent = saved.error || "save failed";
        return;
      }
      toggle.classList.toggle("on", next);
      toggle.setAttribute("aria-checked", String(next));
      status.textContent = t("settings.saved");
    });
    const label = document.createElement("span");
    label.className = "settings-label settings-label-stack";
    const main = document.createElement("span");
    main.className = "settings-label-main";
    main.textContent = t(`settings.extensionVcc.${field}Label`);
    const sub = document.createElement("span");
    sub.className = "settings-label-sub";
    sub.textContent = t(`settings.extensionVcc.${field}Desc`);
    label.append(main, sub);
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, toggle);
    section.append(row);
  }
}
