// ABOUTME: ponytail settings: default mode and visibility switches.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderPonytailSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";

  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionPonytail.title");
  section.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionPonytail.hint");
  section.appendChild(hint);

  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.appendChild(status);
  detailEl.appendChild(section);

  const result = await transport
    .getPonytailConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const shadowed = new Set(result.envShadowed ?? []);
  const badgeFor = (field) => {
    if (!shadowed.has(field)) return null;
    const badge = document.createElement("span");
    badge.className = "pkg-ext-badge";
    badge.textContent = t("settings.extensionFff.shadowBadge", {
      name: result.shadowNames?.[field] ?? field,
    });
    return badge;
  };

  // Mode: 3-way segmented (lite/full/ultra); "use default" clears the key.
  const modes = ["lite", "full", "ultra"];
  const segment = document.createElement("div");
  segment.className = "pkg-ext-segment";
  const storedMode = typeof result.defaultMode === "string" ? result.defaultMode : null;
  const modeLabel = document.createElement("span");
  modeLabel.className = "settings-label";
  modeLabel.textContent = t("settings.extensionPonytail.modeLabel");
  const modeRow = document.createElement("div");
  modeRow.className = "settings-row";
  for (const mode of modes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pkg-ext-segment-btn${storedMode === mode ? " is-on" : ""}`;
    btn.textContent = t(`settings.extensionPonytail.mode_${mode}`);
    btn.disabled = shadowed.has("defaultMode");
    btn.addEventListener("click", async () => {
      const saved = await transport
        .setPonytailConfig({ key: "defaultMode", value: mode })
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!saved.ok) {
        status.textContent = saved.error || "save failed";
        return;
      }
      for (const other of segment.children) other.classList.remove("is-on");
      btn.classList.add("is-on");
      status.textContent = t("settings.saved");
    });
    segment.appendChild(btn);
  }
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "pkg-ext-clear-btn";
  clearBtn.textContent = t("settings.extensionPonytail.useDefault");
  clearBtn.disabled = shadowed.has("defaultMode");
  clearBtn.addEventListener("click", async () => {
    const saved = await transport
      .setPonytailConfig({ key: "defaultMode", value: null })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    for (const other of segment.children) other.classList.remove("is-on");
    status.textContent = t("settings.saved");
  });
  const modeControls = document.createElement("span");
  modeControls.className = "pkg-ext-controls";
  modeControls.append(segment, clearBtn);
  const modeBadge = badgeFor("defaultMode");
  if (modeBadge) modeControls.append(modeBadge);
  modeRow.append(modeLabel, modeControls);
  section.append(modeRow);

  // Two boolean switches — extensions-page switch pattern.
  for (const field of ["quietStartup", "hideStatus"]) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `settings-toggle${result[field] === true ? " on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(result[field] === true));
    toggle.disabled = shadowed.has(field);
    toggle.addEventListener("click", async () => {
      const next = !(toggle.getAttribute("aria-checked") === "true");
      const saved = await transport
        .setPonytailConfig({ key: field, value: next })
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
    label.className = "settings-label";
    label.textContent = t(`settings.extensionPonytail.${field}Label`);
    const row = document.createElement("div");
    row.className = "settings-row";
    const controls = document.createElement("span");
    controls.className = "pkg-ext-controls";
    controls.append(toggle);
    const badge = badgeFor(field);
    if (badge) controls.append(badge);
    row.append(label, controls);
    section.append(row);
  }
}
