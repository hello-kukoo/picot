// ABOUTME: pi-fff per-package settings renderer (mode, scan toggles, advanced paths).
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js; host-plane ops only.

import { t } from "../../../i18n.js";

import { fieldRow } from "./shared.js";

const FFF_MODES = ["tools-and-ui", "tools-only", "override"];
const FFF_TOGGLES = [
  "enableFsRootScanning",
  "enableHomeDirScanning",
  "warnOnHomeDirScan",
  "followSymlinks",
];

/** pi-fff: startup config read once at module load — every write needs a
 * Picot restart to apply (the fixed hint says so). Schema is
 * additionalProperties:false; the host op guarantees a schema-clean file. */
export async function renderFffSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  detailEl.appendChild(section);
  await buildFffSection(section, transport);
}

async function buildFffSection(section, transport) {
  section.replaceChildren();
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionFff.title");
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionFff.hint");
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(title, hint, status);

  let data;
  try {
    data = await transport.getFffConfig();
  } catch (error) {
    status.textContent = error?.message ?? String(error);
    return;
  }
  const { envShadowed, flagShadowed, shadowNames, invalid } = data;
  // UI state owns a copy — the op payload (and any fixture holding it) must
  // never be mutated by control handlers.
  const values = { ...(data.values ?? {}) };
  const shadowed = new Set([...(envShadowed ?? []), ...(flagShadowed ?? [])]);

  async function setKey(key, value) {
    try {
      await transport.setFffConfig({ key, value });
      status.textContent = t("settings.extensionFff.saved");
      return true;
    } catch (error) {
      status.textContent = t("settings.extensionFff.saveFailed", {
        message: error?.message ?? String(error),
      });
      return false;
    }
  }

  if (invalid) {
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    error.textContent = `${t("settings.extensionFff.invalidConfig")} ${invalid.reason ?? ""}`;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "pkg-ext-btn-danger";
    reset.textContent = t("settings.extensionFff.reset");
    let armed = false;
    let disarmTimer = 0;
    reset.addEventListener("click", async () => {
      if (!armed) {
        // Two-click inline confirm: destructive reset requires intent twice.
        armed = true;
        reset.textContent = t("settings.extensionFff.resetConfirm");
        clearTimeout(disarmTimer);
        disarmTimer = setTimeout(() => {
          armed = false;
          reset.textContent = t("settings.extensionFff.reset");
        }, 3000);
        return;
      }
      try {
        await transport.setFffConfig({ reset: true });
        await buildFffSection(section, transport);
      } catch (error) {
        status.textContent = t("settings.extensionFff.saveFailed", {
          message: error?.message ?? String(error),
        });
      }
    });
    error.appendChild(reset);
    section.appendChild(error);
    return;
  }

  function badgeFor(field) {
    if (!shadowed.has(field)) return null;
    const badge = document.createElement("span");
    badge.className = "pkg-ext-badge";
    badge.textContent = t("settings.extensionFff.shadowBadge", {
      name: shadowNames?.[field] ?? field,
    });
    return badge;
  }

  // Mode: 3-way segmented control + a one-line description of the active mode.
  const modeRow = document.createElement("div");
  modeRow.className = "settings-row";
  const modeLabel = document.createElement("span");
  modeLabel.className = "settings-label";
  modeLabel.textContent = t("settings.extensionFff.modeLabel");
  const segment = document.createElement("div");
  segment.className = "pkg-ext-segment";
  const modeBadge = badgeFor("mode");
  const desc = document.createElement("div");
  desc.className = "pkg-ext-desc";
  function renderDesc() {
    desc.textContent = t(`settings.extensionFff.modeDesc.${values.mode}`);
  }
  for (const mode of FFF_MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pkg-ext-segment-btn${values.mode === mode ? " is-on" : ""}`;
    btn.textContent = t(`settings.extensionFff.mode.${mode}`);
    btn.disabled = shadowed.has("mode");
    btn.addEventListener("click", async () => {
      if (values.mode === mode) return;
      if (await setKey("mode", mode)) {
        values.mode = mode;
        for (const other of segment.children) other.classList.remove("is-on");
        btn.classList.add("is-on");
        renderDesc();
      }
    });
    segment.appendChild(btn);
  }
  renderDesc();
  const modeControls = document.createElement("span");
  modeControls.className = "pkg-ext-controls";
  modeControls.append(segment);
  if (modeBadge) modeControls.appendChild(modeBadge);
  modeRow.append(modeLabel, modeControls);
  section.append(modeRow, desc);

  // Four boolean toggles — extensions-page switch pattern.
  for (const field of FFF_TOGGLES) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    label.textContent = t(`settings.extensionFff.${field}`);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `pkg-manager-toggle${values[field] ? " is-on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(Boolean(values[field])));
    toggle.setAttribute("aria-label", t(`settings.extensionFff.${field}`));
    toggle.appendChild(document.createElement("span"));
    toggle.disabled = shadowed.has(field);
    toggle.addEventListener("click", async () => {
      const next = !values[field];
      if (await setKey(field, next)) {
        values[field] = next;
        toggle.classList.toggle("is-on", next);
        toggle.setAttribute("aria-checked", String(next));
      }
    });
    const controls = document.createElement("span");
    controls.className = "pkg-ext-controls";
    controls.append(toggle);
    const badge = badgeFor(field);
    if (badge) controls.appendChild(badge);
    row.append(label, controls);
    section.appendChild(row);
  }

  // Advanced: the two db paths collapse behind a native disclosure.
  const advanced = document.createElement("details");
  advanced.className = "pkg-ext-advanced";
  const summary = document.createElement("summary");
  summary.textContent = t("settings.extensionFff.advanced");
  advanced.appendChild(summary);
  for (const field of ["frecencyDbPath", "historyDbPath"]) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = typeof values[field] === "string" ? values[field] : "";
    input.placeholder = t("settings.extensionFff.dbManaged");
    input.disabled = shadowed.has(field);
    const row = fieldRow(t(`settings.extensionFff.${field}`), input, badgeFor(field));
    input.addEventListener("change", () => {
      // Empty input clears the key back to the fff-managed default.
      void setKey(field, input.value.trim() || null);
    });
    advanced.appendChild(row);
  }
  section.appendChild(advanced);
}
