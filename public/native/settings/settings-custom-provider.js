// Guided custom / relay provider form. Detects OpenAI-compatible vs
// Anthropic protocols, lists upstream models, tests connectivity, then saves
// into models.json via picot-config (CredentialStore for the API key).

import { t } from "../../i18n.js";

const PROBE_TIMEOUT_MS = 45_000;

function createField(labelText, input) {
  const wrap = document.createElement("label");
  wrap.textContent = labelText;
  wrap.appendChild(input);
  return wrap;
}

function suggestProviderIdFromBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    const slug = (parts.length >= 2 ? `${parts.at(-2)}-${parts.at(-1)}` : host)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "custom-relay";
  } catch {
    return "custom-relay";
  }
}

export function openCustomProviderEditor({ call, setupDialog, onSaved }) {
  const { backdrop, dialog } = setupDialog(
    t("settings.customProvider.title"),
    t("settings.customProvider.subtitle"),
  );
  const form = document.createElement("div");
  form.className = "provider-setup-form";

  const providerId = document.createElement("input");
  providerId.className = "ui-input";
  providerId.placeholder = t("settings.customProvider.idPlaceholder");
  const baseUrl = document.createElement("input");
  baseUrl.className = "ui-input";
  baseUrl.placeholder = "https://api.example.com/v1";
  const apiKey = document.createElement("input");
  apiKey.className = "ui-input";
  apiKey.type = "password";
  apiKey.placeholder = t("settings.customProvider.apiKeyPlaceholder");
  const protocol = document.createElement("select");
  protocol.className = "ui-select";
  for (const [value, label] of [
    ["auto", t("settings.customProvider.protocolAuto")],
    ["openai-completions", t("settings.customProvider.protocolOpenAi")],
    ["anthropic-messages", t("settings.customProvider.protocolAnthropic")],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    protocol.appendChild(option);
  }

  form.append(
    createField(t("settings.customProvider.id"), providerId),
    createField(t("settings.customProvider.baseUrl"), baseUrl),
    createField(t("settings.customProvider.apiKey"), apiKey),
    createField(t("settings.customProvider.protocol"), protocol),
  );
  dialog.appendChild(form);

  const modelsWrap = document.createElement("div");
  modelsWrap.className = "custom-provider-models hidden";
  const modelsHead = document.createElement("div");
  modelsHead.className = "custom-provider-models-head";
  const modelsTitle = document.createElement("span");
  modelsTitle.textContent = t("settings.customProvider.models");
  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "ui-button ui-button--ghost ui-button--sm";
  selectAll.textContent = t("settings.customProvider.deselectAll");
  modelsHead.append(modelsTitle, selectAll);
  const modelsList = document.createElement("div");
  modelsList.className = "custom-provider-models-list";
  modelsWrap.append(modelsHead, modelsList);
  dialog.appendChild(modelsWrap);

  const status = document.createElement("div");
  status.className = "custom-provider-status hidden";
  status.setAttribute("role", "status");
  dialog.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "provider-setup-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ui-button ui-button--secondary";
  cancel.textContent = t("actions.cancel");
  cancel.onclick = () => backdrop.remove();
  const detectBtn = document.createElement("button");
  detectBtn.type = "button";
  detectBtn.className = "ui-button ui-button--secondary";
  detectBtn.textContent = t("settings.customProvider.detect");
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "ui-button ui-button--secondary";
  testBtn.textContent = t("settings.customProvider.test");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ui-button ui-button--primary";
  saveBtn.textContent = t("settings.customProvider.save");
  actions.append(cancel, detectBtn, testBtn, saveBtn);
  dialog.appendChild(actions);

  let detectedModels = [];
  let detectedProtocol = null;

  function setStatus(message, kind) {
    if (!message) {
      status.textContent = "";
      status.classList.add("hidden");
      status.classList.remove("is-error", "is-ok");
      return;
    }
    status.textContent = message;
    status.classList.remove("hidden", "is-error", "is-ok");
    if (kind === "error") status.classList.add("is-error");
    if (kind === "ok") status.classList.add("is-ok");
  }

  function renderModels(models) {
    detectedModels = Array.isArray(models) ? models : [];
    modelsList.replaceChildren();
    if (detectedModels.length === 0) {
      modelsWrap.classList.add("hidden");
      return;
    }
    modelsWrap.classList.remove("hidden");
    for (const model of detectedModels) {
      const row = document.createElement("label");
      row.className = "custom-provider-model-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "custom-provider-model-toggle";
      checkbox.value = model.id;
      checkbox.checked = true;
      const label = document.createElement("span");
      label.className = "custom-provider-model-id";
      label.textContent = model.name ? `${model.id} · ${model.name}` : model.id;
      row.append(checkbox, label);
      modelsList.appendChild(row);
    }
    selectAll.textContent = t("settings.customProvider.deselectAll");
  }

  function selectedModels() {
    const selectedIds = new Set(
      [...modelsList.querySelectorAll(".custom-provider-model-toggle:checked")].map(
        (el) => el.value,
      ),
    );
    return detectedModels.filter((model) => selectedIds.has(model.id));
  }

  function resolvedProtocol() {
    if (protocol.value !== "auto") return protocol.value;
    return detectedProtocol;
  }

  selectAll.addEventListener("click", () => {
    const toggles = [...modelsList.querySelectorAll(".custom-provider-model-toggle")];
    const allChecked = toggles.length > 0 && toggles.every((toggle) => toggle.checked);
    for (const toggle of toggles) toggle.checked = !allChecked;
    selectAll.textContent = allChecked
      ? t("settings.customProvider.selectAll")
      : t("settings.customProvider.deselectAll");
  });

  baseUrl.addEventListener("blur", () => {
    if (providerId.value.trim()) return;
    const base = baseUrl.value.trim();
    if (base) providerId.value = suggestProviderIdFromBaseUrl(base);
  });

  detectBtn.addEventListener("click", async () => {
    if (!baseUrl.value.trim()) {
      setStatus(t("settings.customProvider.baseUrlRequired"), "error");
      return;
    }
    if (!apiKey.value.trim()) {
      setStatus(t("settings.customProvider.keyRequired"), "error");
      return;
    }
    detectBtn.disabled = true;
    setStatus(t("settings.customProvider.detecting"));
    try {
      const resp = await call(
        "detect_custom_provider",
        {
          baseUrl: baseUrl.value.trim(),
          apiKey: apiKey.value.trim(),
          preferred: protocol.value,
        },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (!resp?.ok) throw new Error(resp?.error || t("settings.customProvider.detectFailed"));
      const data = resp.data || {};
      if (!data.protocol || data.protocol === "unknown") {
        throw new Error(data.error || t("settings.customProvider.detectFailed"));
      }
      detectedProtocol = data.protocol;
      if (protocol.value === "auto") protocol.value = data.protocol;
      renderModels(data.models);
      setStatus(
        t("settings.customProvider.detected", {
          protocol: data.protocol,
          count: data.models?.length ?? 0,
        }),
        "ok",
      );
    } catch (error) {
      detectedProtocol = null;
      setStatus(error.message || String(error), "error");
    } finally {
      detectBtn.disabled = false;
    }
  });

  testBtn.addEventListener("click", async () => {
    const nextProtocol = resolvedProtocol();
    if (!baseUrl.value.trim() || !apiKey.value.trim() || !nextProtocol) {
      setStatus(t("settings.customProvider.detectFirst"), "error");
      return;
    }
    testBtn.disabled = true;
    setStatus(t("settings.customProvider.testing"));
    try {
      const selected = selectedModels();
      const resp = await call(
        "test_custom_provider",
        {
          baseUrl: baseUrl.value.trim(),
          apiKey: apiKey.value.trim(),
          protocol: nextProtocol,
          modelId: selected[0]?.id,
        },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (!resp?.ok) throw new Error(resp?.error || t("settings.customProvider.testFailed"));
      if (!resp.data?.ok) {
        throw new Error(resp.data?.error || t("settings.customProvider.testFailed"));
      }
      setStatus(t("settings.customProvider.testOk", { ms: resp.data.latencyMs ?? "—" }), "ok");
    } catch (error) {
      setStatus(error.message || String(error), "error");
    } finally {
      testBtn.disabled = false;
    }
  });

  saveBtn.addEventListener("click", async () => {
    const nextProtocol = resolvedProtocol();
    if (!baseUrl.value.trim() || !apiKey.value.trim() || !nextProtocol) {
      setStatus(t("settings.customProvider.detectFirst"), "error");
      return;
    }
    const models = selectedModels();
    if (models.length === 0) {
      setStatus(t("settings.customProvider.modelsRequired"), "error");
      return;
    }
    saveBtn.disabled = true;
    setStatus(t("settings.customProvider.saving"));
    try {
      const resp = await call("save_custom_provider", {
        providerId: providerId.value.trim(),
        baseUrl: baseUrl.value.trim(),
        apiKey: apiKey.value.trim(),
        protocol: nextProtocol,
        models,
        storeKey: true,
        includeApiKeyInFile: false,
      });
      if (!resp?.ok) throw new Error(resp?.error || t("settings.customProvider.saveFailed"));
      const keyNote = resp.data?.keyStored
        ? t("settings.customProvider.keyStored")
        : t("settings.customProvider.keyNotStored");
      setStatus(
        t("settings.customProvider.saved", {
          id: resp.data?.providerId || providerId.value.trim(),
          count: resp.data?.modelCount ?? models.length,
        }) + keyNote,
        "ok",
      );
      await onSaved?.(resp.data?.providerId);
      backdrop.remove();
    } catch (error) {
      setStatus(error.message || String(error), "error");
      saveBtn.disabled = false;
    }
  });
}
