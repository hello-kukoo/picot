// ABOUTME: pi-lens settings: curated global-layer toggles.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (host-plane op).

import { t } from "../../../i18n.js";

export async function renderLensSettings(detailEl, _pkg, transport) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionLens.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionLens.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await transport
    .getLensConfig()
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  if (result.relocatedByEnv) {
    const badge = document.createElement("span");
    badge.className = "pkg-ext-badge";
    badge.textContent = t("settings.extensionLens.relocatedBadge", {
      name: "PI_LENS_CONFIG_PATH",
    });
    section.append(badge);
  }
  if (!result.projectFile) {
    const note = document.createElement("p");
    note.className = "settings-help";
    note.textContent = t("settings.extensionLens.projectHint");
    section.append(note);
  }

  const groups = [
    { label: "runtimeGroup", keys: ["lens.enabled", "lsp.enabled"] },
    {
      label: "feedbackGroup",
      keys: ["format.enabled", "autofix.enabled", "tests.enabled", "delta.enabled"],
    },
    {
      label: "guardGroup",
      keys: [
        "guard.enabled",
        "guard.sharedCheckout",
        "readGuard.enabled",
        "contextInjection.enabled",
      ],
    },
    {
      label: "reportGroup",
      keys: [
        "turnSummary.enabled",
        "actionableWarnings.enabled",
        "actionableWarnings.includeLspCodeActions",
        "actionableWarnings.autoFix.enabled",
        "actionableWarnings.deltaOnly",
        "ui.compactToolLine",
      ],
    },
    {
      label: "analyzerGroup",
      keys: [
        "tools.lazy",
        "analyzers.knip.enabled",
        "analyzers.jscpd.enabled",
        "analyzers.madge.enabled",
        "analyzers.gitleaks.enabled",
        "analyzers.govulncheck.enabled",
        "analyzers.deadCode.enabled",
        "analyzers.complexity.enabled",
      ],
    },
  ];
  const sourceText = { env: "env", project: "project", global: null, default: null };

  for (const group of groups) {
    const groupTitle = document.createElement("p");
    groupTitle.className = "settings-label";
    groupTitle.textContent = t(`settings.extensionLens.${group.label}`);
    section.append(groupTitle);
    for (const key of group.keys) {
      const effective = result.effective?.[key];
      const source = result.sources?.[key];
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `settings-toggle${effective === true ? " on" : ""}`;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(effective === true));
      // env/project shadows are read-only surfaces for the global editor.
      toggle.disabled = source === "env" || source === "project";
      toggle.addEventListener("click", async () => {
        const next = !(toggle.getAttribute("aria-checked") === "true");
        const saved = await transport
          .setLensConfig({ key, value: next })
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
      label.className = "settings-label settings-label-sub";
      label.textContent = key;
      const row = document.createElement("div");
      row.className = "settings-row";
      const controls = document.createElement("span");
      controls.className = "pkg-ext-controls";
      controls.append(toggle);
      const shadowName = sourceText[source];
      if (shadowName) {
        const badge = document.createElement("span");
        badge.className = "pkg-ext-badge";
        badge.textContent = t("settings.extensionLens.shadowBadge", { source: shadowName });
        controls.append(badge);
      }
      row.append(label, controls);
      section.append(row);
    }
  }

  const advancedTitle = document.createElement("p");
  advancedTitle.className = "settings-label";
  advancedTitle.textContent = t("settings.extensionLens.advancedGroup");
  section.append(advancedTitle);
  const filesInput = document.createElement("input");
  filesInput.type = "number";
  filesInput.min = "1";
  filesInput.value = String(result.effective?.maxProjectFiles ?? 8000);
  filesInput.addEventListener("change", async () => {
    const value = Number.parseInt(filesInput.value, 10);
    if (!Number.isInteger(value) || value < 1) {
      status.textContent = t("settings.extensionLens.limitError");
      return;
    }
    const saved = await transport
      .setLensConfig({ key: "maxProjectFiles", value })
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return;
    }
    status.textContent = t("settings.saved");
  });
  const filesLabel = document.createElement("span");
  filesLabel.className = "settings-label";
  filesLabel.textContent = t("settings.extensionLens.maxProjectFilesLabel");
  const filesRow = document.createElement("div");
  filesRow.className = "settings-row";
  filesRow.append(filesLabel, filesInput);
  section.append(filesRow);
}
