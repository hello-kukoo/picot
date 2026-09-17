// ABOUTME: Per-package settings renderers mounted at the bottom of the Extensions package detail page.
// ABOUTME: Advisor is the first entry; packages without a renderer render nothing.

import { t } from "../i18n.js";

/**
 * Mount a package's settings section into the detail page. Advisor needs the
 * config gateway (bridge, in-process model registry — workspace required);
 * pi-fff runs on host control ops via transport, so it also renders on the
 * landing page. A missing dep renders nothing.
 */
export function renderExtensionSettings(detailEl, pkg, { configGateway, transport } = {}) {
  if (pkg?.source === "npm:@juicesharp/rpiv-advisor" && configGateway) {
    renderAdvisorSettings(detailEl, pkg, configGateway);
    return;
  }
  if (pkg?.source === "npm:@ff-labs/pi-fff" && transport) {
    renderFffSettings(detailEl, pkg, transport);
  }
}

/**
 * Advisor: reviewer model + reasoning effort, save-on-change. The GUI's
 * effect ceiling is the next session_start (advisor re-reads the file per
 * session); the hint line keeps that expectation honest.
 */
async function renderAdvisorSettings(detailEl, _pkg, configGateway) {
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
  for (const model of models) {
    if (!model.available) continue;
    const option = document.createElement("option");
    option.value = model.key;
    option.textContent =
      model.name && model.name !== model.key.split("/").slice(1).join("/")
        ? `${model.name} (${model.key})`
        : model.key;
    modelSelect.appendChild(option);
  }
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

function fieldRow(labelText, control, trailing) {
  const row = document.createElement("label");
  row.className = "pkg-ext-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  row.append(label, control);
  if (trailing) row.appendChild(trailing);
  return row;
}

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
async function renderFffSettings(detailEl, _pkg, transport) {
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
  modeRow.className = "pkg-ext-field";
  const modeLabel = document.createElement("span");
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
  modeRow.append(modeLabel, segment);
  if (modeBadge) modeRow.appendChild(modeBadge);
  section.append(modeRow, desc);

  // Four boolean toggles — extensions-page switch pattern.
  for (const field of FFF_TOGGLES) {
    const row = document.createElement("div");
    row.className = "pkg-ext-row";
    const label = document.createElement("span");
    label.className = "pkg-ext-row-label";
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
    row.append(label, toggle);
    const badge = badgeFor(field);
    if (badge) row.appendChild(badge);
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
