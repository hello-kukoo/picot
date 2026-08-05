// ABOUTME: Renders the Settings provider catalog and models.json editor.
// ABOUTME: Keeps provider/model editing behind an injected configuration gateway.
// Settings → Configuration tab: API keys / model catalog panel plus the inline
// agent-config and models.json editors. Transport is supplied by the injected
// gateway so legacy and native runtimes can share the renderer.

import { onLocaleChange, t } from "../i18n.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./save-status.js";

const HEALTH_CHECK_TIMEOUT_MS = 120_000;
const MODELS_DOCS_URL =
  "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md";
const PROVIDER_ICON_ALIASES = {
  "amazon-bedrock": "aws",
  "azure-openai-responses": "azure",
  "github-copilot": "github-copilot",
  "google-vertex": "google",
  "ant-ling": "ant-group",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "cloudflare",
  deepseek: "deep-seek",
  fireworks: "fireworks",
  huggingface: "hugging-face",
  openrouter: "open-router",
  opencode: "open-code",
  "opencode-go": "open-code",
  xai: "x-a-i",
  "vercel-ai-gateway": "vercel",
  "minimax-cn": "minimax",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "xiaomi-token-plan-ams": "xiaomi-mi-mo",
  "xiaomi-token-plan-cn": "xiaomi-mi-mo",
  "xiaomi-token-plan-sgp": "xiaomi-mi-mo",
};
function providerIcon(provider, className = "provider-logo") {
  const key = PROVIDER_ICON_ALIASES[provider] || provider;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = `/icons/providers/${key}.svg`;
  img.onerror = () => {
    img.replaceWith(
      Object.assign(document.createElement("span"), {
        className,
        textContent: provider.slice(0, 1).toUpperCase(),
      }),
    );
  };
  return img;
}

export function setupSettingsConfig({ configGateway, onModelConfigurationChanged }) {
  const call = (op, params, options) => configGateway.call(op, params, options);
  const apiKeysContainer = document.getElementById("settings-api-keys");
  const providerExpansionState = new Map();
  let catalogProviders = [];

  async function loadApiKeysPanel(options = {}) {
    if (!apiKeysContainer) return;
    rememberProviderExpansionState();
    const scrollContainer = options.preserveUi ? getSettingsScrollContainer() : null;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    if (!options.preserveUi) {
      const loading = document.createElement("div");
      loading.className = "settings-api-keys-loading";
      loading.textContent = t("settings.loadingProviders");
      apiKeysContainer.replaceChildren(loading);
    }
    let data;
    try {
      data = await call("list_model_catalog");
    } catch (error) {
      renderApiKeysPanelError(error?.message || t("settings.apiKeys.loadFailed"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    if (!data?.ok || !Array.isArray(data.data?.providers)) {
      renderApiKeysPanelError(data?.error || t("settings.apiKeys.loadFailed"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    renderApiKeysPanel(data.data.providers);
    restoreScroll(scrollContainer, scrollTop);
  }

  function rememberProviderExpansionState() {
    if (!apiKeysContainer) return;
    for (const row of apiKeysContainer.querySelectorAll(".api-key-row[data-provider]")) {
      const modelList = row.querySelector(".api-model-list");
      if (modelList) {
        providerExpansionState.set(
          row.dataset.provider,
          !modelList.classList.contains("collapsed"),
        );
      }
    }
  }

  function getSettingsScrollContainer() {
    return (
      apiKeysContainer?.closest?.(".settings-content") ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  function restoreScroll(scrollContainer, scrollTop) {
    if (!scrollContainer) return;
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
    });
  }

  function renderApiKeysPanelError(message) {
    apiKeysContainer.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "settings-api-keys-empty";
    const msg = document.createElement("div");
    msg.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ui-button ui-button--secondary config-editor-cancel";
    retry.textContent = t("actions.retry");
    retry.style.marginTop = "var(--space-2)";
    retry.addEventListener("click", () => loadApiKeysPanel());
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    apiKeysContainer.appendChild(wrap);
  }

  function renderApiKeysPanel(providers) {
    catalogProviders = providers;
    if (inlineModelsTextarea) {
      if (!inlineModelsTextarea.value.trim()) {
        inlineModelsTextarea.value = '{\n  "providers": {}\n}';
      }
      renderModelsConfigLayout();
      return;
    }

    apiKeysContainer.replaceChildren();
    const configured = providers.filter((provider) => provider.configured);
    for (const provider of configured.sort((a, b) =>
      (a.displayName || a.provider).localeCompare(b.displayName || b.provider),
    )) {
      apiKeysContainer.appendChild(buildApiKeyRow(provider));
    }
  }

  function openProviderPicker(providers) {
    const backdrop = document.createElement("div");
    backdrop.className = "provider-picker-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "provider-picker-dialog";
    const head = document.createElement("div");
    head.className = "provider-picker-head";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = t("settings.providers.addTitle");
    const subtitle = document.createElement("p");
    subtitle.textContent = t("settings.providers.addDescription");
    heading.append(title, subtitle);
    head.appendChild(heading);
    const close = document.createElement("button");
    close.className = "provider-picker-close";
    close.textContent = t("settings.providers.close");
    head.appendChild(close);
    dialog.appendChild(head);
    const search = document.createElement("input");
    search.className = "provider-picker-search";
    search.placeholder = t("settings.providers.searchPlaceholder");
    dialog.appendChild(search);
    const grid = document.createElement("div");
    grid.className = "provider-picker-grid";
    dialog.appendChild(grid);
    const render = () => {
      grid.replaceChildren();
      const q = search.value.toLowerCase();
      const matches = providers.filter((p) =>
        (p.displayName || p.provider).toLowerCase().includes(q),
      );
      const custom = {
        provider: "custom",
        displayName: t("settings.providers.customCompatible"),
        custom: true,
      };
      const groups = [
        [
          t("settings.providers.customGroup"),
          !q || "custom openai-compatible anthropic-compatible".includes(q)
            ? [custom]
            : matches.filter((p) => p.custom || p.provider === "custom"),
        ],
        [t("settings.providers.apiKeyGroup"), matches.filter((p) => !p.custom)],
      ];
      for (const [label, items] of groups) {
        if (!items.length) continue;
        const heading = document.createElement("div");
        heading.className = "provider-picker-section-title";
        heading.textContent = label;
        grid.appendChild(heading);
        for (const p of items) {
          const card = document.createElement("button");
          card.className = "provider-picker-card";
          card.type = "button";
          const logo = providerIcon(p.provider);
          const text = document.createElement("span");
          const strong = document.createElement("strong");
          strong.textContent = p.displayName || p.provider;
          const small = document.createElement("small");
          small.textContent =
            label === t("settings.providers.customGroup")
              ? t("settings.providers.customEndpointFormat")
              : t("settings.providers.modelCount", {
                  count: Array.isArray(p.models) ? p.models.length : 0,
                });
          text.append(strong, small);
          card.append(logo, text);
          card.addEventListener("click", () => {
            backdrop.remove();
            if (p.custom) {
              openCustomProviderEditor();
              return;
            }
            let row = apiKeysContainer.querySelector(
              `[data-provider="${escapeSelectorValue(p.provider)}"]`,
            );
            if (!row) {
              row = buildApiKeyRow(p);
              const detail = apiKeysContainer.querySelector(".models-config-main");
              detail?.replaceChildren(row);
            }
            openApiKeyEditor(row, p);
          });
          grid.appendChild(card);
        }
      }
    };
    search.addEventListener("input", render);
    close.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    render();
    search.focus();
  }

  function setupDialog(title, subtitle) {
    const backdrop = document.createElement("div");
    backdrop.className = "provider-picker-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "provider-setup-dialog";
    Object.assign(dialog.style, {
      width: "min(560px, 100%)",
      maxHeight: "90vh",
      overflow: "auto",
      boxSizing: "border-box",
      padding: "24px",
      background: "var(--bg-primary, #fff)",
      border: "1px solid var(--border)",
      borderRadius: "16px",
      boxShadow: "0 24px 80px rgb(0 0 0 / 30%)",
    });
    const head = document.createElement("div");
    head.className = "provider-picker-head";
    const heading = document.createElement("div");
    const titleElement = document.createElement("h2");
    titleElement.textContent = title;
    const subtitleElement = document.createElement("p");
    subtitleElement.textContent = subtitle;
    heading.append(titleElement, subtitleElement);
    head.appendChild(heading);
    const close = document.createElement("button");
    close.className = "provider-picker-close";
    close.textContent = t("settings.providers.close");
    close.onclick = () => backdrop.remove();
    head.appendChild(close);
    dialog.appendChild(head);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    return { backdrop, dialog };
  }

  function openCustomProviderEditor() {
    const { backdrop, dialog } = setupDialog(
      t("settings.providers.customTitle"),
      t("settings.providers.customDescription"),
    );
    const form = document.createElement("div");
    form.className = "provider-setup-form";
    Object.assign(form.style, { display: "grid", gap: "14px" });
    const fields = [
      [t("settings.providers.providerId"), "provider", "my-provider"],
      [t("settings.providers.baseUrl"), "baseUrl", "https://api.example.com/v1"],
      [t("settings.providers.apiKey"), "apiKey", t("settings.providers.optional")],
      [t("settings.providers.modelId"), "modelId", "model-name"],
    ];
    const inputs = {};
    for (const [label, key, placeholder] of fields) {
      const wrap = document.createElement("label");
      wrap.textContent = label;
      Object.assign(wrap.style, {
        display: "grid",
        gap: "6px",
        color: "var(--text-dim)",
        fontSize: "13px",
      });
      const input = document.createElement("input");
      input.placeholder = placeholder;
      input.type = key === "apiKey" ? "password" : "text";
      Object.assign(input.style, {
        boxSizing: "border-box",
        width: "100%",
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        background: "var(--bg-glass)",
        color: "var(--text-primary)",
        font: "inherit",
      });
      wrap.appendChild(input);
      form.appendChild(wrap);
      inputs[key] = input;
    }
    dialog.appendChild(form);
    const error = document.createElement("div");
    error.className = "api-key-editor-error";
    dialog.appendChild(error);
    const actions = document.createElement("div");
    actions.className = "provider-setup-actions";
    const cancel = document.createElement("button");
    cancel.className = "ui-button ui-button--secondary";
    cancel.textContent = t("settings.providers.cancel");
    cancel.onclick = () => backdrop.remove();
    const save = document.createElement("button");
    save.className = "ui-button ui-button--primary";
    save.textContent = t("settings.providers.saveProvider");
    actions.append(cancel, save);
    dialog.appendChild(actions);
    save.onclick = async () => {
      const id = inputs.provider.value.trim(),
        baseUrl = inputs.baseUrl.value.trim(),
        modelId = inputs.modelId.value.trim();
      if (!id || !baseUrl || !modelId) {
        error.textContent = t("settings.providers.requiredFields");
        return;
      }
      save.disabled = true;
      try {
        const current = await call("read_models_config");
        const json = JSON.parse(current.data.content || "{}");
        json.providers ||= {};
        if (json.providers[id]) {
          error.textContent = t("settings.providers.duplicateProvider", { provider: id });
          save.disabled = false;
          return;
        }
        json.providers[id] = {
          baseUrl,
          api: "openai-completions",
          ...(inputs.apiKey.value.trim() ? { apiKey: inputs.apiKey.value.trim() } : {}),
          models: [{ id: modelId }],
        };
        const result = await call("write_models_config", {
          content: JSON.stringify(json, null, 2),
        });
        if (!result?.ok) throw new Error(result.error || t("settings.providers.saveFailed"));
        backdrop.remove();
        selectedModelsConfigItem = { type: "provider", provider: id };
        await loadInlineModelsEditor();
        await loadApiKeysPanel();
      } catch (e) {
        error.textContent = e.message || t("settings.providers.saveFailed");
        save.disabled = false;
      }
    };
  }

  function escapeSelectorValue(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function getProviderModels(provider) {
    return Array.isArray(provider.models) ? provider.models : [];
  }

  function buildApiKeyRow(p) {
    const row = document.createElement("div");
    row.className = "api-key-row";
    row.dataset.provider = p.provider;

    const header = document.createElement("div");
    header.className = "api-key-row-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "api-provider-toggle";
    toggle.setAttribute(
      "aria-label",
      t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
    );
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▼";

    const info = document.createElement("div");
    info.className = "api-key-row-info";
    const name = document.createElement("div");
    name.className = "api-key-row-name";
    name.textContent = p.displayName || p.provider;
    info.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "api-key-row-actions";
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.textContent = p.configured ? t("actions.update") : t("actions.setKey");
    setBtn.addEventListener("click", () => openApiKeyEditor(row, p));

    const models = getProviderModels(p);
    const hasConfiguredModels = p.configured && models.length > 0;
    if (hasConfiguredModels) {
      const checkHealthBtn = document.createElement("button");
      checkHealthBtn.type = "button";
      checkHealthBtn.className = "api-model-check-visible";
      checkHealthBtn.textContent = t("settings.apiKeys.checkHealth");
      checkHealthBtn.disabled = !models.some((model) => model.visible !== false && model.available);
      checkHealthBtn.addEventListener("click", () => checkModelHealth(p.provider));
      actions.appendChild(checkHealthBtn);
    }
    actions.appendChild(setBtn);
    if (p.configured && p.source === "stored") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = t("actions.remove");
      removeBtn.addEventListener("click", () => removeApiKey(p));
      actions.appendChild(removeBtn);
    }

    const modelList = hasConfiguredModels ? buildModelList(p) : null;
    header.appendChild(toggle);
    header.appendChild(info);
    if (hasConfiguredModels) {
      const summary = document.createElement("div");
      summary.className = "api-key-row-summary";
      summary.textContent = describeProviderSummary(models);
      header.appendChild(summary);
    }
    header.appendChild(actions);
    row.appendChild(header);
    if (modelList) {
      const isExpanded = providerExpansionState.get(p.provider) ?? true;
      modelList.classList.toggle("collapsed", !isExpanded);
      toggle.setAttribute("aria-expanded", String(isExpanded));
      const toggleModelList = () => {
        modelList.classList.toggle("collapsed");
        const expanded = !modelList.classList.contains("collapsed");
        toggle.setAttribute("aria-expanded", String(expanded));
        providerExpansionState.set(p.provider, expanded);
      };
      header.addEventListener("click", (event) => {
        if (event.target.closest?.(".api-key-row-actions")) return;
        toggleModelList();
      });
      info.classList.add("api-provider-title-toggle");
      info.tabIndex = 0;
      info.setAttribute("role", "button");
      info.setAttribute(
        "aria-label",
        t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
      );
      info.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleModelList();
        }
      });
      row.appendChild(modelList);
    } else {
      toggle.hidden = true;
    }
    return row;
  }

  function buildModelList(p) {
    const wrap = document.createElement("div");
    wrap.className = "api-model-list";

    const models = getProviderModels(p);
    if (models.length === 0) return null;

    const columnLabels = document.createElement("div");
    columnLabels.className = "api-model-list-heading";
    const statusColumn = document.createElement("span");
    const modelColumn = document.createElement("span");
    modelColumn.textContent = t("settings.apiKeys.model");

    const actions = document.createElement("div");
    actions.className = "api-model-list-heading-actions";
    const visibilityColumn = document.createElement("label");
    visibilityColumn.className = "api-model-select-all";
    const allModelsEnabled = models.every((model) => model.visible !== false);
    const visibilityToggle = document.createElement("input");
    visibilityToggle.type = "checkbox";
    visibilityToggle.className = "api-model-select-all-toggle";
    visibilityToggle.checked = allModelsEnabled;
    visibilityToggle.setAttribute(
      "aria-label",
      t(allModelsEnabled ? "settings.apiKeys.deselectAll" : "settings.apiKeys.selectAll", {
        provider: p.displayName || p.provider,
      }),
    );
    visibilityToggle.addEventListener("change", () =>
      setProviderModelsVisibility(p.provider, visibilityToggle.checked),
    );
    visibilityColumn.appendChild(visibilityToggle);
    columnLabels.append(statusColumn, modelColumn, actions, visibilityColumn);
    wrap.appendChild(columnLabels);

    for (const model of models) {
      wrap.appendChild(buildModelRow(model));
    }
    return wrap;
  }

  function getProviderModelRows(provider) {
    return [
      ...apiKeysContainer.querySelectorAll(
        `.api-model-row[data-provider="${escapeSelectorValue(provider)}"]`,
      ),
    ];
  }

  async function setProviderModelsVisibility(provider, visible) {
    const rows = getProviderModelRows(provider);
    const toggles = rows
      .map((row) => row.querySelector(".api-model-visibility-toggle"))
      .filter(Boolean);
    const modelsToUpdate = rows.filter(
      (row) => row.querySelector(".api-model-visibility-toggle")?.checked !== visible,
    );
    if (modelsToUpdate.length === 0) return;

    const providerRow = apiKeysContainer.querySelector(
      `.api-key-row[data-provider="${escapeSelectorValue(provider)}"]`,
    );
    const visibilityButton = providerRow?.querySelector(".api-model-select-all-toggle");
    if (visibilityButton) visibilityButton.disabled = true;
    for (const toggle of toggles) toggle.disabled = true;
    for (const row of modelsToUpdate) {
      const resp = await call("set_model_visibility", {
        provider,
        modelId: row.dataset.modelId,
        visible,
      }).catch(() => null);
      if (!resp?.ok) {
        if (visibilityButton) visibilityButton.disabled = false;
        for (const toggle of toggles) toggle.disabled = false;
        return;
      }
    }
    await onModelConfigurationChanged?.();
    await loadApiKeysPanel({ preserveUi: true });
  }

  function buildModelRow(model) {
    const row = document.createElement("div");
    row.className = "api-model-row";
    row.dataset.provider = model.provider;
    row.dataset.modelId = model.id;
    row.dataset.available = String(model.available);

    const health = model.health || { status: "unknown" };
    const healthDot = document.createElement("span");
    healthDot.className = `api-model-health-dot ${health.status || "unknown"}`;
    healthDot.title = describeModelHealth(health);

    const label = document.createElement("div");
    label.className = "api-model-label";
    const name = document.createElement("div");
    name.className = "api-model-name";
    name.textContent = model.name || model.id;
    const meta = document.createElement("div");
    meta.className = "api-model-health-status";
    meta.textContent = describeModelStatus(model);
    label.appendChild(name);
    label.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "api-model-actions";

    const visibilityLabel = document.createElement("label");
    visibilityLabel.className = "api-model-visibility";
    const visibility = document.createElement("input");
    visibility.type = "checkbox";
    visibility.className = "api-model-visibility-toggle";
    visibility.setAttribute(
      "aria-label",
      t("settings.apiKeys.enableModel", { model: model.name || model.id }),
    );
    visibility.checked = model.visible !== false;
    visibility.addEventListener("change", async () => {
      visibility.disabled = true;
      const resp = await call("set_model_visibility", {
        provider: model.provider,
        modelId: model.id,
        visible: visibility.checked,
      }).catch(() => null);
      if (resp?.ok) {
        await onModelConfigurationChanged?.();
        await loadApiKeysPanel({ preserveUi: true });
      } else {
        visibility.checked = !visibility.checked;
        visibility.disabled = false;
      }
    });
    visibilityLabel.appendChild(visibility);
    actions.appendChild(visibilityLabel);

    row.appendChild(healthDot);
    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  function describeModelStatus(model) {
    const parts = [];
    if (!model.available) parts.push(t("settings.apiKeys.noKeyAvailable"));
    parts.push(describeModelHealth(model.health || { status: "unknown" }));
    return parts.join(" · ");
  }

  function describeProviderSummary(models) {
    const enabled = models.filter((model) => model.visible !== false).length;
    const healthy = models.filter((model) => model.health?.status === "healthy").length;
    const issues = models.filter((model) => model.health?.status === "unhealthy").length;
    return t("settings.apiKeys.summary", { enabled, healthy, issues });
  }

  function describeModelHealth(health) {
    if (!health || health.status === "unknown") return t("settings.apiKeys.healthUnknown");
    if (health.status === "healthy") {
      return health.latencyMs
        ? t("settings.apiKeys.healthyLatency", { latency: health.latencyMs })
        : t("settings.apiKeys.healthy");
    }
    return health.error
      ? t("settings.apiKeys.failedWithMessage", { message: health.error })
      : t("settings.apiKeys.failed");
  }

  function setModelRowChecking(row) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    if (dot) {
      dot.className = "api-model-health-dot checking";
      dot.title = t("settings.apiKeys.checkingHealth");
    }
    if (status) status.textContent = t("settings.apiKeys.checkingHealthEllipsis");
  }

  function setModelRowHealthError(row, message) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const text = t("settings.apiKeys.failedWithMessage", {
      message: message || t("settings.apiKeys.healthCheckFailed"),
    });
    if (dot) {
      dot.className = "api-model-health-dot unknown";
      dot.title = text;
    }
    if (status) status.textContent = text;
  }

  function applyHealthResult(result) {
    const row = apiKeysContainer.querySelector(
      `.api-model-row[data-provider="${escapeSelectorValue(result.provider)}"][data-model-id="${escapeSelectorValue(result.modelId)}"]`,
    );
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const health = { status: result.status, latencyMs: result.latencyMs, error: result.error };
    if (dot) {
      dot.className = `api-model-health-dot ${result.status || "unknown"}`;
      dot.title = describeModelHealth(health);
    }
    if (status) status.textContent = describeModelHealth(health);
  }

  async function checkModelHealth(provider) {
    for (const modelRow of getProviderModelRows(provider)) {
      const toggle = modelRow.querySelector(".api-model-visibility-toggle");
      if (toggle?.checked && modelRow.dataset.available !== "false") setModelRowChecking(modelRow);
    }
    const resp = await call(
      "check_model_health",
      { provider },
      { timeoutMs: HEALTH_CHECK_TIMEOUT_MS },
    ).catch((error) => ({ ok: false, error: error?.message }));
    if (resp?.ok && Array.isArray(resp.data?.results)) {
      for (const result of resp.data.results) applyHealthResult(result);
    } else {
      const message = resp?.error || t("settings.apiKeys.healthCheckFailed");
      for (const modelRow of getProviderModelRows(provider)) {
        const toggle = modelRow.querySelector(".api-model-visibility-toggle");
        if (toggle?.checked && modelRow.dataset.available !== "false") {
          setModelRowHealthError(modelRow, message);
        }
      }
    }
  }

  function openApiKeyEditor(row, p) {
    const editor = document.createElement("div");
    editor.className = "api-key-editor";

    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = t("settings.apiKeys.editorTitle", {
      provider: p.displayName || p.provider,
    });
    editor.appendChild(title);

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("settings.apiKeys.pastePlaceholder");
    editor.appendChild(input);

    const err = document.createElement("div");
    err.className = "api-key-editor-error";
    err.style.display = "none";
    editor.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "api-key-editor-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ui-button ui-button--secondary config-editor-cancel";
    cancelBtn.textContent = t("actions.cancel");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ui-button ui-button--primary";
    saveBtn.textContent = t("actions.save");
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editor.appendChild(actions);

    row.replaceWith(editor);
    requestAnimationFrame(() => input.focus());

    const cancel = () => {
      editor.replaceWith(row);
    };
    cancelBtn.addEventListener("click", cancel);

    const save = async () => {
      const key = input.value.trim();
      if (!key) {
        err.textContent = t("settings.apiKeys.keyCannotBeEmpty");
        err.style.display = "";
        return;
      }
      saveBtn.disabled = true;
      const resp = await call("set_api_key", { provider: p.provider, apiKey: key }).catch(
        (error) => ({
          ok: false,
          error: error?.message,
        }),
      );
      if (resp?.ok) {
        await onModelConfigurationChanged?.();
        loadApiKeysPanel();
      } else {
        err.textContent = resp?.error || t("settings.apiKeys.saveFailed");
        err.style.display = "";
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }

  async function removeApiKey(p) {
    const ok = confirm(
      t("settings.apiKeys.removeConfirm", { provider: p.displayName || p.provider }),
    );
    if (!ok) return;
    const resp = await call("remove_api_key", { provider: p.provider }).catch(() => null);
    if (resp?.ok) {
      await onModelConfigurationChanged?.();
      loadApiKeysPanel();
    }
  }

  const inlineConfigPath = document.getElementById("inline-config-path");
  const inlineConfigTextarea = document.getElementById("inline-config-textarea");
  const inlineConfigError = document.getElementById("inline-config-error");
  const inlineConfigSave = document.getElementById("inline-config-save");

  async function loadInlineConfigEditor() {
    if (!inlineConfigTextarea) return;
    inlineConfigError?.classList.add("hidden");
    inlineConfigTextarea.value = "";
    if (inlineConfigPath)
      inlineConfigPath.textContent = t("native.settings.settingsConfig.textcontent.loading");
    try {
      const data = await call("read_agent_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load config");
      try {
        inlineConfigTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineConfigTextarea.value = data.data.content;
      }
      if (inlineConfigPath) inlineConfigPath.textContent = data.data.path || "";
    } catch (e) {
      if (inlineConfigPath) inlineConfigPath.textContent = "";
      if (inlineConfigError) {
        inlineConfigError.textContent = e.message || String(e);
        inlineConfigError.classList.remove("hidden");
      }
    }
  }

  inlineConfigSave?.addEventListener("click", async () => {
    if (!inlineConfigTextarea) return;
    clearSettingsSaveMessage(inlineConfigError);
    const content = inlineConfigTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, `Invalid JSON: ${e.message}`);
      return;
    }
    setSettingsSaveButtonSaving(inlineConfigSave, true);
    try {
      const data = await call("write_agent_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save config");
      showSettingsSaveSuccess(inlineConfigError);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineConfigSave, false);
    }
  });

  const inlineModelsPath = document.getElementById("inline-models-path");
  const inlineModelsTextarea = document.getElementById("inline-models-textarea");
  const inlineModelsError = document.getElementById("inline-models-error");
  const inlineModelsSave = document.getElementById("inline-models-save");
  const inlineModelsInsertExample = document.getElementById("inline-models-insert-example");
  const modelsConfigDocsLink = document.getElementById("models-config-docs-link");
  let selectedModelsConfigItem = null;

  const MODELS_JSON_EXAMPLE = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
`;

  function showInlineModelsError(message) {
    showSettingsSaveError(inlineModelsError, message);
  }

  function clearInlineModelsError() {
    clearSettingsSaveMessage(inlineModelsError);
  }

  async function loadInlineModelsEditor() {
    if (!inlineModelsTextarea) return;
    clearInlineModelsError();
    if (!inlineModelsTextarea.value.trim()) {
      inlineModelsTextarea.value = '{\n  "providers": {}\n}';
    }
    renderModelsConfigLayout();
    if (inlineModelsPath)
      inlineModelsPath.textContent = t("native.settings.settingsConfig.textcontent.loading");
    try {
      const data = await call("read_models_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load models.json");
      try {
        inlineModelsTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineModelsTextarea.value = data.data.content;
      }
      renderModelsConfigLayout();
      if (inlineModelsPath) inlineModelsPath.textContent = data.data.path || "";
    } catch (e) {
      if (inlineModelsPath) inlineModelsPath.textContent = "";
      showInlineModelsError(e.message || String(e));
    }
  }

  function renderModelsConfigLayout() {
    if (!inlineModelsTextarea) return;
    let parsed;
    try {
      parsed = JSON.parse(inlineModelsTextarea.value);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) {
      parsed.providers = {};
    }
    const providers = parsed.providers;
    const providerNames = Object.keys(providers);
    const configuredProviders = catalogProviders
      .filter((provider) => provider.configured)
      .sort((a, b) => (a.displayName || a.provider).localeCompare(b.displayName || b.provider));
    if (
      !selectedModelsConfigItem ||
      (selectedModelsConfigItem.type === "auth" &&
        !configuredProviders.some(
          (provider) => provider.provider === selectedModelsConfigItem.provider,
        )) ||
      (selectedModelsConfigItem.type !== "auth" && !providers[selectedModelsConfigItem.provider]) ||
      (selectedModelsConfigItem.type === "model" &&
        !providers[selectedModelsConfigItem.provider].models?.[selectedModelsConfigItem.index])
    ) {
      selectedModelsConfigItem = configuredProviders[0]
        ? { type: "auth", provider: configuredProviders[0].provider }
        : providerNames[0]
          ? { type: "provider", provider: providerNames[0] }
          : null;
    }

    let layout = document.getElementById("models-config-layout");
    if (!layout) {
      layout = document.createElement("div");
      layout.id = "models-config-layout";
      layout.className = "models-config-layout";
      apiKeysContainer.replaceChildren(layout);

      const source = document.createElement("details");
      source.className = "models-config-source";
      const summary = document.createElement("summary");
      summary.textContent = t("settings.providers.advancedJsonEditor");
      source.append(summary, inlineModelsTextarea);
      inlineModelsTextarea.addEventListener("change", renderModelsConfigLayout);

      const footer = document.createElement("div");
      footer.className = "models-config-footer";
      const sourceSection = inlineModelsSave?.closest(".settings-section");
      const actions = inlineModelsSave?.closest(".settings-config-actions");
      footer.appendChild(source);
      if (actions) {
        actions.classList.add("models-config-footer-actions");
        footer.appendChild(actions);
      }
      apiKeysContainer.append(layout, footer);
      if (sourceSection) sourceSection.hidden = true;
    } else if (layout.parentNode !== apiKeysContainer) {
      apiKeysContainer.prepend(layout);
    }
    layout.replaceChildren();
    const sidebar = document.createElement("aside");
    sidebar.className = "models-config-sidebar";
    const list = document.createElement("div");
    list.className = "models-provider-list";
    const main = document.createElement("section");
    main.className = "models-config-main";

    const sync = () => {
      inlineModelsTextarea.value = JSON.stringify(parsed, null, 2);
      clearInlineModelsError();
    };
    const update = (callback) => {
      callback();
      sync();
      renderModelsConfigLayout();
    };

    for (const provider of configuredProviders) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item models-auth-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "auth" &&
          selectedModelsConfigItem.provider === provider.provider,
      );
      item.append(providerIcon(provider.provider, "models-provider-icon"));
      item.appendChild(
        Object.assign(document.createElement("span"), {
          textContent: provider.displayName || provider.provider,
        }),
      );
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "auth", provider: provider.provider };
        renderModelsConfigLayout();
      });
      list.appendChild(item);
    }

    if (configuredProviders.length && providerNames.length) {
      const divider = document.createElement("div");
      divider.className = "models-provider-divider";
      list.appendChild(divider);
    }

    for (const id of providerNames) {
      const provider = providers[id];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "provider" && selectedModelsConfigItem.provider === id,
      );
      item.append(providerIcon(id, "models-provider-icon"));
      item.appendChild(Object.assign(document.createElement("span"), { textContent: id }));
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "provider", provider: id };
        renderModelsConfigLayout();
      });
      list.appendChild(item);

      for (const [index, model] of (provider.models || []).entries()) {
        const modelItem = document.createElement("button");
        modelItem.type = "button";
        modelItem.className = "models-model-item";
        modelItem.classList.toggle(
          "selected",
          selectedModelsConfigItem?.type === "model" &&
            selectedModelsConfigItem.provider === id &&
            selectedModelsConfigItem.index === index,
        );
        modelItem.textContent = model.id || t("settings.providers.newModel");
        modelItem.addEventListener("click", () => {
          selectedModelsConfigItem = { type: "model", provider: id, index };
          renderModelsConfigLayout();
        });
        list.appendChild(modelItem);
      }

      const addModel = document.createElement("button");
      addModel.type = "button";
      addModel.className = "models-model-add";
      addModel.textContent = t("settings.providers.addModel");
      addModel.addEventListener("click", () => {
        provider.models ||= [];
        provider.models.push({ id: "new-model" });
        selectedModelsConfigItem = {
          type: "model",
          provider: id,
          index: provider.models.length - 1,
        };
        sync();
        renderModelsConfigLayout();
      });
      list.appendChild(addModel);
    }
    sidebar.appendChild(list);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "models-provider-add";
    add.textContent = t("settings.providers.addProvider");
    add.addEventListener("click", () => openProviderPicker(catalogProviders));
    sidebar.appendChild(add);

    if (!selectedModelsConfigItem) {
      const emptyTitle = document.createElement("h3");
      emptyTitle.textContent = t("settings.providers.noProvidersTitle");
      const emptyHint = document.createElement("p");
      emptyHint.textContent = t("settings.providers.noProvidersDescription");
      main.append(emptyTitle, emptyHint);
    } else if (selectedModelsConfigItem.type === "auth") {
      const provider = configuredProviders.find(
        (candidate) => candidate.provider === selectedModelsConfigItem.provider,
      );
      if (provider) {
        const card = buildApiKeyRow(provider);
        card.classList.add("provider-manager-card");
        card.querySelector(".api-key-row-header")?.classList.add("provider-manager-card-header");
        card.querySelector(".api-model-list")?.classList.add("provider-manager-model-list");
        main.appendChild(card);
      }
    } else if (selectedModelsConfigItem.type === "provider") {
      renderProviderConfigForm(main, parsed, selectedModelsConfigItem.provider, update);
    } else {
      renderModelConfigForm(
        main,
        parsed,
        selectedModelsConfigItem.provider,
        selectedModelsConfigItem.index,
        update,
      );
    }
    layout.append(sidebar, main);
  }

  function createModelsField(label, control, hint) {
    const field = document.createElement("label");
    field.className = "models-config-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    field.append(caption, control);
    if (hint) {
      const help = document.createElement("small");
      help.textContent = hint;
      field.appendChild(help);
    }
    return field;
  }

  function createModelsInput(value, placeholder = "") {
    const input = document.createElement("input");
    input.className = "ui-input";
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  }

  function renderProviderConfigForm(main, config, providerName, update) {
    const provider = config.providers[providerName];
    const header = document.createElement("div");
    header.className = "models-config-detail-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "models-config-eyebrow";
    eyebrow.textContent = t("settings.providers.provider");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ui-button ui-button--danger ui-button--sm";
    remove.textContent = t("settings.providers.delete");
    remove.addEventListener("click", () => {
      if (!confirm(t("settings.providers.deleteProviderConfirm", { provider: providerName })))
        return;
      update(() => {
        delete config.providers[providerName];
        selectedModelsConfigItem = null;
      });
    });
    header.append(eyebrow, remove);

    const form = document.createElement("div");
    form.className = "models-config-form";
    const name = createModelsInput(providerName, t("settings.providers.providerNamePlaceholder"));
    name.addEventListener("change", () => {
      const nextName = name.value.trim();
      if (!nextName || nextName === providerName) {
        name.value = providerName;
        return;
      }
      if (config.providers[nextName]) {
        showInlineModelsError(t("settings.providers.duplicateProvider", { provider: nextName }));
        name.value = providerName;
        return;
      }
      update(() => {
        config.providers[nextName] = provider;
        delete config.providers[providerName];
        selectedModelsConfigItem = { type: "provider", provider: nextName };
      });
    });
    const baseUrl = createModelsInput(provider.baseUrl, "https://api.example.com/v1");
    baseUrl.addEventListener("input", () => {
      provider.baseUrl = baseUrl.value || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    const apiKey = createModelsInput(provider.apiKey, t("settings.providers.apiKeyPlaceholder"));
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.addEventListener("input", () => {
      provider.apiKey = apiKey.value || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    const api = document.createElement("select");
    api.className = "ui-select";
    for (const optionValue of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ]) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      option.selected = (provider.api || "openai-completions") === optionValue;
      api.appendChild(option);
    }
    api.addEventListener("change", () => {
      provider.api = api.value;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    form.append(
      createModelsField(t("settings.providers.providerName"), name),
      createModelsField(t("settings.providers.baseUrl"), baseUrl),
      createModelsField(t("settings.providers.apiKey"), apiKey, t("settings.providers.apiKeyHint")),
      createModelsField(t("settings.providers.api"), api),
    );
    main.append(header, form);
  }

  function renderModelConfigForm(main, config, providerName, index, update) {
    const model = config.providers[providerName].models[index];
    const header = document.createElement("div");
    header.className = "models-config-detail-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "models-config-eyebrow";
    eyebrow.textContent = t("settings.providers.model");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ui-button ui-button--danger ui-button--sm";
    remove.textContent = t("settings.providers.delete");
    remove.addEventListener("click", () =>
      update(() => {
        config.providers[providerName].models.splice(index, 1);
        selectedModelsConfigItem = { type: "provider", provider: providerName };
      }),
    );
    header.append(eyebrow, remove);

    const form = document.createElement("div");
    form.className = "models-config-form";
    const bindings = [
      [t("settings.providers.modelId"), "id", "model-name"],
      [t("settings.providers.displayName"), "name", t("settings.providers.optional")],
      [t("settings.providers.contextWindow"), "contextWindow", t("settings.providers.optional")],
      [t("settings.providers.maxTokens"), "maxTokens", t("settings.providers.optional")],
    ];
    for (const [label, key, placeholder] of bindings) {
      const input = createModelsInput(model[key], placeholder);
      if (key === "contextWindow" || key === "maxTokens") input.type = "number";
      input.addEventListener("input", () => {
        const value = input.value.trim();
        model[key] = value
          ? key === "contextWindow" || key === "maxTokens"
            ? Number(value)
            : value
          : undefined;
        inlineModelsTextarea.value = JSON.stringify(config, null, 2);
        if (key === "id") {
          const item = document.querySelector(".models-model-item.selected");
          if (item) item.textContent = value || t("settings.providers.newModel");
        }
      });
      form.appendChild(createModelsField(label, input));
    }
    const reasoning = document.createElement("input");
    reasoning.type = "checkbox";
    reasoning.checked = model.reasoning === true;
    reasoning.addEventListener("change", () => {
      model.reasoning = reasoning.checked || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    form.appendChild(createModelsField(t("settings.providers.reasoningModel"), reasoning));
    main.append(header, form);
  }

  inlineModelsSave?.addEventListener("click", async () => {
    if (!inlineModelsTextarea) return;
    clearInlineModelsError();
    const content = inlineModelsTextarea.value;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      showInlineModelsError(`Invalid JSON: ${e.message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showInlineModelsError("models.json must be a JSON object.");
      return;
    }
    if (
      "providers" in parsed &&
      (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
    ) {
      showInlineModelsError("'providers' must be an object.");
      return;
    }
    setSettingsSaveButtonSaving(inlineModelsSave, true);
    try {
      const data = await call("write_models_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save models.json");
      showSettingsSaveSuccess(inlineModelsError);
      await onModelConfigurationChanged?.();
    } catch (e) {
      showInlineModelsError(e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineModelsSave, false);
    }
  });

  inlineModelsInsertExample?.addEventListener("click", () => {
    if (!inlineModelsTextarea) return;
    const current = inlineModelsTextarea.value.trim();
    if (current && current !== "{}" && current !== '{\n  "providers": {}\n}') {
      if (!confirm(t("settings.models.replaceConfirm"))) return;
    }
    inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
    selectedModelsConfigItem = { type: "provider", provider: "ollama" };
    renderModelsConfigLayout();
    clearInlineModelsError();
  });

  modelsConfigDocsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    call("open_external", { url: MODELS_DOCS_URL }).catch(() => {
      const link = document.createElement("a");
      link.href = MODELS_DOCS_URL;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.click();
    });
  });

  onLocaleChange(() => {
    if (apiKeysContainer?.isConnected) void loadApiKeysPanel({ preserveUi: true });
  });

  return { loadApiKeysPanel, loadInlineConfigEditor, loadInlineModelsEditor };
}
