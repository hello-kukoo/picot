// ABOUTME: pi-web-access settings: search provider and model.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js (bridge plane).

import { t } from "../../../i18n.js";
import {
  appendModelOptions,
  loadModelChoices,
  noteWhenCatalogUnavailable,
} from "./model-choices.js";

export async function renderWebAccessSettings(detailEl, _pkg, configGateway) {
  const section = document.createElement("div");
  section.className = "pkg-ext-settings";
  const title = document.createElement("h4");
  title.className = "pkg-ext-title";
  title.textContent = t("settings.extensionWebAccess.title");
  section.append(title);
  const hint = document.createElement("p");
  hint.className = "settings-help";
  hint.textContent = t("settings.extensionWebAccess.hint");
  section.append(hint);
  const status = document.createElement("div");
  status.className = "pkg-ext-status";
  section.append(status);
  detailEl.append(section);

  const result = await configGateway
    .call("webaccess.config.get")
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (!result.ok) {
    status.textContent = result.error || "load failed";
    return;
  }
  const data = result.data ?? {};
  if (data.invalid) {
    const error = document.createElement("div");
    error.className = "pkg-ext-error";
    // The package never quotes file text back (its own text is the secret)
    // — the reason carries no content either.
    error.textContent = data.invalid.reason || "invalid config";
    const note = document.createElement("p");
    note.className = "settings-help";
    note.textContent = t("settings.extensionWebAccess.invalidNote");
    section.append(error, note);
    return;
  }
  const envKeyed = new Set(data.envKeyed ?? []);

  const post = async (payload) => {
    const saved = await configGateway
      .call("webaccess.config.set", payload)
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!saved.ok) {
      status.textContent = saved.error || "save failed";
      return false;
    }
    status.textContent = t("settings.saved");
    return true;
  };
  const save = (key, value) => post({ key, value });

  const secretRow = (key) => {
    const field = data.fields?.[key] ?? { configured: false };
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = field.configured
      ? t("settings.extensionWebAccess.configuredPreview", { preview: field.preview ?? "" })
      : "";
    input.autocomplete = "off";
    const notice = document.createElement("span");
    notice.className = "pkg-ext-notice";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "pkg-ext-clear-btn";
    clearBtn.textContent = t("settings.extensionWebAccess.clear");
    clearBtn.hidden = !field.configured;
    let armed = false;
    clearBtn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        clearBtn.textContent = t("settings.extensionWebAccess.clearConfirm");
        return;
      }
      if (await save(key, null)) {
        clearBtn.hidden = true;
        input.placeholder = "";
      }
    });
    input.addEventListener("change", async () => {
      notice.textContent = "";
      const raw = input.value;
      if (raw === "") return; // save-on-change writes only when non-empty
      const saved = await save(key, raw);
      // The field is the only place the full key exists: clear it either
      // way, so a rejected save never leaves plaintext sitting in the DOM.
      input.value = "";
      if (saved) {
        input.placeholder = t("settings.extensionWebAccess.configuredPreview", {
          preview: raw.slice(-4),
        });
        clearBtn.hidden = false;
        clearBtn.textContent = t("settings.extensionWebAccess.clear");
        armed = false;
      }
    });
    const label = document.createElement("span");
    label.className = "settings-label settings-label-sub";
    label.textContent = key;
    if (envKeyed.has(key)) {
      const badge = document.createElement("span");
      badge.className = "pkg-ext-badge";
      badge.textContent = t("settings.extensionWebAccess.envBadge");
      label.append(" ", badge);
    }
    const row = document.createElement("div");
    row.className = "settings-row";
    const controls = document.createElement("span");
    controls.className = "pkg-ext-controls";
    controls.append(input, clearBtn, notice);
    row.append(label, controls);
    section.append(row);
  };

  const searchTitle = document.createElement("p");
  searchTitle.className = "settings-label";
  searchTitle.textContent = t("settings.extensionWebAccess.searchKeysGroup");
  section.append(searchTitle);
  for (const key of [
    "openaiApiKey",
    "braveApiKey",
    "exaApiKey",
    "perplexityApiKey",
    "geminiApiKey",
    "mistralApiKey",
    "serpapiApiKey",
    "xaiApiKey",
  ]) {
    secretRow(key);
  }

  const extractTitle = document.createElement("p");
  extractTitle.className = "settings-label";
  extractTitle.textContent = t("settings.extensionWebAccess.extractKeysGroup");
  section.append(extractTitle);
  for (const key of [
    "jinaApiKey",
    "firecrawlApiKey",
    "tinyfishApiKey",
    "search1apiApiKey",
    "searchinfinityApiKey",
    "queritApiKey",
    "bochaApiKey",
    "valyuApiKey",
    "anysearchApiKey",
    "datalabApiKey",
    "crawl4aiApiToken",
    "brightdataApiKey",
  ]) {
    secretRow(key);
  }

  const nonSecretTitle = document.createElement("p");
  nonSecretTitle.className = "settings-label";
  nonSecretTitle.textContent = t("settings.extensionWebAccess.endpointsGroup");
  section.append(nonSecretTitle);
  for (const key of [
    "proxy",
    "openaiResponsesUrl",
    "searxngBaseUrl",
    "crawl4aiBaseUrl",
    "brightdataSerpZone",
    "brightdataUnlockerZone",
  ]) {
    const input = document.createElement("input");
    input.type = "text";
    const stored = data.nonSecrets?.[key];
    input.value = typeof stored === "string" ? stored : "";
    input.placeholder = key;
    input.addEventListener("change", () => void save(key, input.value.trim() || null));
    const label = document.createElement("span");
    label.className = "settings-label settings-label-sub";
    label.textContent = key;
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, input);
    section.append(row);
  }
  for (const key of ["allowBrowserCookies", "image.enabled"]) {
    const stored = data.nonSecrets?.[key];
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `settings-toggle${stored === true ? " on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(stored === true));
    toggle.addEventListener("click", async () => {
      const next = !(toggle.getAttribute("aria-checked") === "true");
      if (await save(key, next)) {
        toggle.classList.toggle("on", next);
        toggle.setAttribute("aria-checked", String(next));
      }
    });
    const label = document.createElement("span");
    label.className = "settings-label settings-label-sub";
    label.textContent = key;
    const row = document.createElement("div");
    row.className = "settings-row";
    row.append(label, toggle);
    section.append(row);
  }

  const answerTitle = document.createElement("p");
  answerTitle.className = "settings-label";
  answerTitle.textContent = t("settings.extensionWebAccess.answerModelGroup");
  section.append(answerTitle);
  // Answer model rides the composer's picker list (enabled + scoped), the
  // same one advisor and the other extension pages show.
  const answerSelect = document.createElement("select");
  const answerUnset = document.createElement("option");
  answerUnset.value = "";
  answerUnset.textContent = t("settings.extensionWebAccess.modelUnset");
  answerSelect.append(answerUnset);
  const answerChoices = await loadModelChoices(configGateway);
  appendModelOptions(answerSelect, answerChoices);
  const answer = data.routing?.answerModel ?? {};
  const answerKey = answer.provider && answer.modelId ? `${answer.provider}/${answer.modelId}` : "";
  if (answerKey && ![...answerSelect.options].some((o) => o.value === answerKey)) {
    const stale = document.createElement("option");
    stale.value = answerKey;
    stale.textContent = answerKey;
    answerSelect.append(stale);
  }
  answerSelect.value = answerKey;
  answerSelect.addEventListener("change", async () => {
    const raw = answerSelect.value;
    const [provider, ...rest] = raw.split("/");
    const modelId = rest.join("/");
    // The package only accepts the pair together: one entries batch (and the
    // same rule clears both halves).
    await post({
      entries: [
        { key: "fetch.answerProvider", value: raw ? provider : null },
        { key: "fetch.answerModel", value: raw ? modelId : null },
      ],
    });
  });
  noteWhenCatalogUnavailable(section, answerChoices);
  const answerLabel = document.createElement("span");
  answerLabel.className = "settings-label";
  answerLabel.textContent = t("settings.extensionWebAccess.answerModelLabel");
  const answerRow = document.createElement("div");
  answerRow.className = "settings-row";
  answerRow.append(answerLabel, answerSelect);
  section.append(answerRow);
}
