// ABOUTME: Settings → MCP page — three layer tabs, each a master/detail view over mcp.json layers.
// ABOUTME: Pi-owned sources are editable; shared sources render read-only; disable toggles the pi-project layer.

import { onLocaleChange, t } from "../i18n.js";

/**
 * @typedef {{name:string, entry:Object, sourceFile:string, editable:boolean, ownDisabled:boolean, effectiveDisabled:boolean}} McpListEntry
 * @typedef {{installed: boolean, groups: Record<string, McpListEntry[]>, groupErrors: Record<string, string|undefined>}} McpListData
 */

export function setupMcpPage({ masterEl, detailEl, tabs, navItem, configGateway }) {
  /** @type {McpListData | null} */
  let data = null;
  let activeTab = "sharedGlobal";
  /** @type {Map<string, {name: string}>} per-tab selection */
  const selections = new Map();
  let mode = "view"; // view | add
  let loadSeq = 0;
  let availabilityCache = null;
  let statusText = "";

  const unsubscribeLocale = onLocaleChange(() => render());

  function scopeLabel(scope) {
    return t(`settings.mcp.groups.${scope}`);
  }

  function groupEntries() {
    return data?.groups[activeTab] ?? [];
  }

  function findEntry(name) {
    return groupEntries().find((e) => e.name === name) ?? null;
  }

  async function load() {
    const seq = ++loadSeq;
    const result = await call("mcp_list_servers");
    if (seq !== loadSeq) return;
    data = result.ok ? result.data : null;
    statusText = result.ok ? "" : String(result.error ?? "load failed");
    if (selected()) {
      const name = selected().name;
      if (!groupEntries().some((e) => e.name === name)) selections.delete(activeTab);
    }
    render();
  }

  async function activate() {
    await load();
  }

  async function refreshAvailability() {
    if (availabilityCache !== null) return availabilityCache;
    try {
      const result = await call("mcp_list_servers");
      availabilityCache = result.ok ? Boolean(result.data?.installed) : false;
    } catch {
      availabilityCache = false;
    }
    navItem?.classList.toggle("hidden", !availabilityCache);
    return availabilityCache;
  }

  /** Gateway rejects (timeout / no target / transport failure) normalize to
   * the same {ok:false} shape the handlers already render — models-page.js
   * precedent. Without this, a rejected call strands the click handler as an
   * unhandled rejection with no user feedback for the full 30s timeout. */
  function call(op, params) {
    return configGateway.call(op, params).catch((error) => ({
      ok: false,
      error: error?.message ?? String(error),
    }));
  }

  function selected() {
    return selections.get(activeTab) ?? null;
  }

  function setStatus(text) {
    statusText = text;
    renderStatus();
  }

  function renderStatus() {
    const el = detailEl.querySelector(".mcp-detail-status");
    if (el) el.textContent = statusText;
  }

  function render() {
    renderTabs();
    renderMaster();
    renderDetail();
  }

  function renderTabs() {
    for (const btn of tabs) {
      const isActive = btn.dataset.mcpTab === activeTab;
      btn.classList.toggle("extensions-page-tab", true);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
  }

  function renderMaster() {
    masterEl.replaceChildren();
    if (!data) return;
    const entries = groupEntries();

    const head = document.createElement("div");
    head.className = "mcp-master-head";
    const count = document.createElement("span");
    count.className = "pkg-manager-group-header";
    count.textContent = `${scopeLabel(activeTab)} · ${entries.length}`;
    head.appendChild(count);
    masterEl.appendChild(head);

    if (data.groupErrors?.[activeTab]) {
      const err = document.createElement("div");
      err.className = "mcp-group-error";
      err.textContent = data.groupErrors[activeTab];
      masterEl.appendChild(err);
    }
    if (activeTab === "project" && entries.length === 0 && !data.groupErrors?.project) {
      const empty = document.createElement("div");
      empty.className = "mcp-group-error";
      empty.textContent = t("settings.mcp.noProject");
      masterEl.appendChild(empty);
    }

    for (const item of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pkg-manager-sidebar-row";
      if (selected()?.name === item.name) row.classList.add("is-selected");
      const name = document.createElement("div");
      name.className = "pkg-manager-sidebar-name";
      name.textContent = item.name;
      row.appendChild(name);
      const meta = document.createElement("div");
      meta.className = "pkg-manager-sidebar-meta";
      const dot = document.createElement("span");
      dot.className = `pkg-manager-status-dot ${item.effectiveDisabled ? "is-disabled" : "is-loaded"}`;
      meta.appendChild(dot);
      const src = document.createElement("span");
      src.textContent = basename(item.sourceFile);
      src.title = item.sourceFile;
      meta.appendChild(src);
      if (item.effectiveDisabled) {
        const badge = document.createElement("span");
        badge.textContent = t("settings.mcp.disabledBadge");
        meta.appendChild(badge);
      }
      row.appendChild(meta);
      row.addEventListener("click", () => {
        selections.set(activeTab, { name: item.name });
        mode = "view";
        render();
      });
      masterEl.appendChild(row);
    }

    // Add affordance sits at the bottom of the master list (dashed, same
    // pattern as the Models page's provider add button) — pi-owned tabs only.
    if (activeTab !== "sharedGlobal") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "models-provider-add";
      add.textContent = t("settings.mcp.addMcp");
      add.addEventListener("click", () => {
        mode = "add";
        render();
      });
      masterEl.appendChild(add);
    }
  }

  function basename(filePath) {
    const idx = filePath.lastIndexOf("/");
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }

  function renderDetail() {
    detailEl.replaceChildren();
    const body = document.createElement("div");
    body.className = "mcp-detail-body";
    const status = document.createElement("div");
    status.className = "mcp-detail-status";
    status.textContent = statusText;
    body.appendChild(status);

    if (mode === "add") {
      body.appendChild(renderForm(null, null));
      detailEl.replaceChildren(body);
      return;
    }
    const sel = selected();
    if (!sel) {
      detailEl.replaceChildren(body);
      return;
    }
    const item = findEntry(sel.name);
    if (!item) {
      detailEl.replaceChildren(body);
      return;
    }
    body.appendChild(renderEntry(item));
    detailEl.replaceChildren(body);
  }

  function renderEntry(item) {
    const wrap = document.createElement("div");
    wrap.className = "mcp-entry";

    wrap.appendChild(renderToggle(item));

    const head = document.createElement("div");
    head.className = "mcp-entry-head";
    const title = document.createElement("h4");
    title.textContent = item.name;
    head.appendChild(title);
    if (!item.editable) {
      const badge = document.createElement("span");
      badge.className = "mcp-badge";
      badge.textContent = t("settings.mcp.readOnlyBadge");
      head.appendChild(badge);
    }
    wrap.appendChild(head);

    const source = document.createElement("div");
    source.className = "mcp-source";
    source.textContent = `${t("settings.mcp.sourceLabel")}: ${item.sourceFile}`;
    wrap.appendChild(source);

    if (item.editable) {
      const form = renderForm(activeTab, item.name);
      wrap.appendChild(form);
    } else {
      const pre = document.createElement("pre");
      pre.className = "mcp-entry-raw";
      pre.textContent = JSON.stringify(item.entry, null, 2);
      wrap.appendChild(pre);
    }

    return wrap;
  }

  function renderToggle(item) {
    // Extensions-page switch pattern: role=switch + pkg-manager-toggle.
    const row = document.createElement("div");
    row.className = "mcp-toggle-row";
    const label = document.createElement("span");
    label.className = "mcp-toggle-label";
    label.textContent = t("settings.mcp.enable");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `pkg-manager-toggle${item.effectiveDisabled ? "" : " is-on"}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(!item.effectiveDisabled));
    toggle.setAttribute("aria-label", t("settings.mcp.enable"));
    toggle.appendChild(document.createElement("span"));
    toggle.addEventListener("click", async () => {
      const result = await call("mcp_toggle_server", {
        name: item.name,
        disable: !item.effectiveDisabled,
      });
      if (result.ok) {
        setStatus(t("settings.mcp.saved"));
        await load();
      } else setStatus(String(result.error ?? "toggle failed"));
    });
    row.append(label, toggle);
    return row;
  }

  /**
   * Edit form for pi-owned entries; add form when (scope, name) are null.
   * Array-form `command` displays joined with spaces and round-trips the
   * original array untouched unless the user edits the field.
   */
  function renderForm(scope, name) {
    const existing = name ? findEntry(name)?.entry : null;
    const isEdit = existing !== null;
    const form = document.createElement("form");
    form.className = "mcp-form";
    form.addEventListener("submit", (e) => e.preventDefault());

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.required = true;
    nameInput.value = name ?? "";
    nameInput.disabled = isEdit;
    const nameRow = fieldRow(t("settings.mcp.form.name"), nameInput);

    const typeSelect = document.createElement("select");
    const stdioOpt = document.createElement("option");
    stdioOpt.value = "stdio";
    stdioOpt.textContent = t("settings.mcp.form.stdio");
    const remoteOpt = document.createElement("option");
    remoteOpt.value = "remote";
    remoteOpt.textContent = t("settings.mcp.form.remote");
    typeSelect.append(stdioOpt, remoteOpt);
    typeSelect.value = existing?.url ? "remote" : "stdio";
    const typeRow = fieldRow(t("settings.mcp.form.type"), typeSelect);

    const originalCommand = existing?.command;
    const commandIsArray = Array.isArray(originalCommand);
    const commandInput = document.createElement("input");
    commandInput.type = "text";
    commandInput.placeholder = "npx";
    commandInput.value = commandIsArray
      ? originalCommand.join(" ")
      : typeof originalCommand === "string"
        ? originalCommand
        : "";
    let commandDirty = false;
    commandInput.addEventListener("input", () => {
      commandDirty = true;
    });
    const commandRow = fieldRow(t("settings.mcp.form.command"), commandInput);

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://mcp.example.com/mcp";
    urlInput.value = typeof existing?.url === "string" ? existing.url : "";
    const urlRow = fieldRow(t("settings.mcp.form.url"), urlInput);

    const argsInput = document.createElement("textarea");
    argsInput.rows = 3;
    argsInput.placeholder = "-y\nchrome-devtools-mcp@latest";
    const args = existing?.args;
    if (Array.isArray(args)) argsInput.value = args.join("\n");
    const argsRow = fieldRow(t("settings.mcp.form.args"), argsInput);

    const envInput = document.createElement("textarea");
    envInput.rows = 3;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP ${VAR} placeholder, shown as literal text
    envInput.placeholder = "API_KEY=${MY_API_KEY}";
    const env = existing?.env;
    if (env && typeof env === "object") {
      envInput.value = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    }
    const envRow = fieldRow(t("settings.mcp.form.env"), envInput);

    const headersInput = document.createElement("textarea");
    headersInput.rows = 2;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP ${VAR} placeholder, shown as literal text
    headersInput.placeholder = "Authorization=Bearer ${TOKEN}";
    const headers = existing?.headers;
    if (headers && typeof headers === "object") {
      headersInput.value = Object.entries(headers)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    }
    const headersRow = fieldRow(t("settings.mcp.form.headers"), headersInput);

    const syncTransport = () => {
      const remote = typeSelect.value === "remote";
      commandRow.classList.toggle("hidden", remote);
      argsRow.classList.toggle("hidden", remote);
      envRow.classList.toggle("hidden", remote);
      urlRow.classList.toggle("hidden", !remote);
      headersRow.classList.toggle("hidden", !remote);
    };
    typeSelect.addEventListener("change", syncTransport);
    syncTransport();

    // Save + Delete share one action row — Delete only exists for edits.
    const actions = document.createElement("div");
    actions.className = "mcp-form-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "mcp-btn mcp-btn-primary";
    save.textContent = t("settings.mcp.save");
    actions.appendChild(save);
    if (isEdit) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "mcp-btn mcp-btn-danger";
      del.textContent = t("settings.mcp.delete");
      del.addEventListener("click", async () => {
        const result = await call("mcp_delete_server", { scope, name });
        if (result.ok) {
          selections.delete(activeTab);
          mode = "view";
          setStatus(t("settings.mcp.saved"));
          await load();
        } else setStatus(String(result.error ?? "delete failed"));
      });
      actions.appendChild(del);
    }
    form.addEventListener("submit", async () => {
      const entry = { ...(existing ?? {}) };
      if (typeSelect.value === "remote") {
        if (!urlInput.value.trim()) {
          setStatus(t("settings.mcp.form.urlRequired"));
          return;
        }
        entry.url = urlInput.value.trim();
        delete entry.command;
        delete entry.args;
        parseKeyValue(headersInput.value, entry, "headers");
      } else {
        if (!commandInput.value.trim() && !commandIsArray) {
          setStatus(t("settings.mcp.form.commandRequired"));
          return;
        }
        // Unmodified array command round-trips verbatim; an edit collapses
        // it to a single string command (args field still applies).
        if (commandIsArray && !commandDirty) entry.command = originalCommand;
        else entry.command = commandInput.value.trim();
        delete entry.url;
        delete entry.headers;
        const argsLines = argsInput.value
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (argsLines.length > 0) entry.args = argsLines;
        else delete entry.args;
        parseKeyValue(envInput.value, entry, "env");
      }
      const targetName = isEdit ? name : nameInput.value.trim();
      const result = await call("mcp_save_server", {
        scope,
        name: targetName,
        entry,
      });
      if (result.ok) {
        selections.set(activeTab, { name: targetName });
        mode = "view";
        availabilityCache = null;
        setStatus(t("settings.mcp.saved"));
        await load();
      } else setStatus(String(result.error ?? "save failed"));
    });

    form.append(nameRow, typeRow, commandRow, urlRow, argsRow, envRow, headersRow, actions);
    return form;
  }

  function fieldRow(labelText, control) {
    const row = document.createElement("label");
    row.className = "mcp-field";
    const label = document.createElement("span");
    label.className = "mcp-field-label";
    label.textContent = labelText;
    row.append(label, control);
    return row;
  }

  function parseKeyValue(text, entry, key) {
    const pairs = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf("=");
        if (idx <= 0) return null;
        return [l.slice(0, idx), l.slice(idx + 1)];
      })
      .filter(Boolean);
    if (pairs.length > 0) entry[key] = Object.fromEntries(pairs);
    else delete entry[key];
  }

  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.mcpTab;
      if (!tab || tab === activeTab) return;
      activeTab = tab;
      mode = "view";
      render();
    });
  }

  function destroy() {
    unsubscribeLocale();
  }

  return { activate, refreshAvailability, destroy };
}
