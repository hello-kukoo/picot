// ABOUTME: Settings → MCP page — two native layer tabs (user + project mcp.json), each a master/detail view.
// ABOUTME: Orphaned adapter/shared config layers surface as one-click migration banners into the native files.
// ABOUTME: Live connection state, browser sign-in, and sign-out come from the host `pi mcp` ops.

import { onLocaleChange, t } from "../i18n.js";
import { createMcpLoginDialog } from "./mcp-login-dialog.js";

/**
 * @typedef {{name:string, entry:Object, sourceFile:string, editable:true, enabled:boolean}} McpListEntry
 * @typedef {{id:string, sourceFile:string, missing:string[]}} McpMigrationTarget
 * @typedef {{name:string, scope?:string, state:string, transport?:string, tools?:unknown[], error?:string}} McpServerStatus
 * @typedef {{groups: Record<string, McpListEntry[]>, groupErrors: Record<string, string|undefined>, migrations: McpMigrationTarget[]}} McpListData
 */

// Long master-row error text is summarized; the full message stays on `title`.
const ERROR_SUMMARY_CHARS = 48;

/**
 * Binds the host transport (`WsTransport` control ops) to the login surface this
 * page consumes. Kept here so every host entry (landing + workspace shell)
 * wires MCP sign-in identically, and so the page stays testable with a stub.
 */
export function createMcpHostOps(transport) {
  return {
    start: (name) => transport.mcpLoginStart(name),
    cancel: (operationId) => transport.mcpLoginCancel(operationId),
    status: (operationId) => transport.mcpLoginStatus(operationId),
    logout: (name) => transport.mcpLogout(name),
    serverStatus: () => transport.mcpServerStatus(),
    subscribe: (listener) => transport.onMcpLoginUpdate(listener),
  };
}

export function setupMcpPage({
  masterEl,
  detailEl,
  tabs,
  navItem: _navItem,
  configGateway,
  // Host-plane MCP login surface (WS host_request → `pi mcp login|logout|list`).
  // Absent on transports without the host ops: the page then degrades to the
  // plain config list (no badges, no sign-in buttons).
  mcpLogin = null,
  openExternal = null,
  captionEl = null,
  migrationsEl = null,
}) {
  /** @type {McpListData | null} */
  let data = null;
  let activeTab = "piGlobal";
  /** @type {Map<string, {name: string}>} per-tab selection */
  const selections = new Map();
  let mode = "view"; // view | add
  let loadSeq = 0;
  let statusText = "";
  /** @type {{byScope: Map<string, McpServerStatus>, byName: Map<string, McpServerStatus>} | null} */
  let statuses = null;
  let statusError = "";
  let loginDialog = null;

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
    ensureSelection();
    render();
  }

  async function activate() {
    await load();
    await loadStatus();
  }

  /**
   * Live per-server state from the host (`pi mcp list --json`, 60s host-side
   * TTL). Queried on page activation and after every sign-in/sign-out — never
   * polled: an in-flight login polls through `mcp_login_status` instead.
   */
  async function loadStatus() {
    if (!mcpLogin) return;
    const result = await Promise.resolve()
      .then(() => mcpLogin.serverStatus())
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (result?.ok) {
      statuses = indexStatus(result.servers);
      statusError = "";
    } else {
      statuses = null;
      statusError = String(result?.error ?? "mcp_server_status failed");
    }
    render();
  }

  function indexStatus(servers) {
    const byScope = new Map();
    const byName = new Map();
    for (const server of Array.isArray(servers) ? servers : []) {
      if (!server || typeof server.name !== "string") continue;
      const scope = server.scope ? scopeOf(server.scope) : "";
      if (scope) byScope.set(`${scope}:${server.name}`, server);
      if (!byName.has(server.name)) byName.set(server.name, server);
    }
    return { byScope, byName };
  }

  function scopeOf(scope) {
    return String(scope).toLowerCase().includes("project") ? "project" : "piGlobal";
  }

  /**
   * pi's report scopes are not guaranteed to be present or uniformly spelled,
   * so a tab-scoped match wins and the bare name match is a fallback for
   * reports without scope. A scoped report never lends a same-named server
   * from the other scope a status — that is what gates untrusted projects.
   */
  function statusFor(name, scope) {
    const scoped = statuses?.byScope.get(`${scope}:${name}`);
    if (scoped) return scoped;
    const named = statuses?.byName.get(name);
    if (!named || named.scope) return null;
    return named;
  }

  function transportOf(item, status) {
    if (status?.transport) return String(status.transport);
    // pi 0.99 has no legacy SSE transport: a configured `url` is HTTP, and
    // everything else is a local stdio command.
    return typeof item.entry?.url === "string" && item.entry.url ? "http" : "stdio";
  }

  /** The adapter/shared copy runs only after the user clicks a migration
   * banner's action; the list op detects but never writes. */
  async function migrate(target) {
    const result = await call("mcp_migrate_adapter_config", { target });
    const migrated = result.ok ? (result.data?.migrated ?? []) : [];
    setStatus(
      result.ok && migrated.length > 0
        ? t("settings.mcp.saved")
        : String(result.data?.error ?? result.error ?? t("settings.mcp.migrationFailed")),
    );
    await load();
  }

  /** Native MCP ships with every Pi 0.99+ runtime, so the page is always
   * available; kept as an async method for the landing nav wiring. */
  async function refreshAvailability() {
    return true;
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

  /** An empty detail pane reads as a broken grey page; default to the
   * first master row whenever a tab has no selection. */
  function ensureSelection() {
    if (selected()) return;
    const first = groupEntries()[0];
    if (first) selections.set(activeTab, { name: first.name });
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
    renderCaption();
    renderMaster();
    renderDetail();
  }

  /** Tab-level caption outside the master list: scope label + entry count. */
  function renderCaption() {
    if (!data) return;
    const entries = groupEntries();
    const el = captionEl ?? document.getElementById("mcp-tab-caption");
    if (el) el.textContent = `${scopeLabel(activeTab)} · ${entries.length}`;
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
    (migrationsEl ?? document.getElementById("mcp-migrations"))?.replaceChildren();
    if (!data) return;
    const entries = groupEntries();

    if (statusError) {
      const note = document.createElement("div");
      note.className = "mcp-group-error mcp-status-error";
      note.textContent = t("settings.mcp.status.unavailable");
      note.title = statusError;
      masterEl.appendChild(note);
    }

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
      const live = statusFor(item.name, activeTab);
      const dot = document.createElement("span");
      dot.className = `pkg-manager-status-dot ${dotClassFor(item, live)}`;
      meta.appendChild(dot);
      const src = document.createElement("span");
      src.textContent = basename(item.sourceFile);
      src.title = item.sourceFile;
      meta.appendChild(src);
      const statusBadge = renderStatusBadge(live);
      if (statusBadge) meta.appendChild(statusBadge);
      // With live state known the badge is authoritative; the config-level
      // "disabled" chip would only repeat it (or contradict it).
      if (!item.enabled && !statusBadge) {
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
    const add = document.createElement("button");
    add.type = "button";
    add.className = "models-provider-add";
    add.textContent = t("settings.mcp.addMcp");
    add.addEventListener("click", () => {
      mode = "add";
      render();
    });
    masterEl.appendChild(add);

    // Migration notices live OUTSIDE the master/detail layout entirely:
    // migrating is the user's call and must not compete with the live view.
    for (const target of data.migrations ?? []) {
      const notice = document.createElement("div");
      notice.className = "mcp-legacy-notice";
      const text = document.createElement("span");
      // Full path, not basename: adapter, shared, and native files all end
      // in mcp.json / mcp-adapter.json, so the directory is the identifier.
      text.textContent = t("settings.mcp.migrateNotice")
        .replace("{file}", target.sourceFile)
        .replace("{count}", String(target.missing.length));
      const action = document.createElement("button");
      action.type = "button";
      action.className = "mcp-legacy-migrate";
      action.textContent = t("settings.mcp.migrate");
      // Disable on first click: the op is fast, but a double-fire would run
      // twice; the re-render after load() replaces this button anyway.
      action.addEventListener("click", () => {
        action.disabled = true;
        void migrate(target.id);
      });
      notice.append(text, action);
      (migrationsEl ?? document.getElementById("mcp-migrations") ?? masterEl).appendChild(notice);
    }
  }

  function basename(filePath) {
    const idx = filePath.lastIndexOf("/");
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }

  /** Master-row dot: live state wins over the config `enabled` flag. */
  function dotClassFor(item, live) {
    switch (live?.state) {
      case "connected":
        return "is-loaded";
      case "needs-auth":
        return "is-installed";
      // A failed server must not keep the accent "healthy" dot just because
      // its config entry is enabled; the badge text carries the detail.
      case "error":
        return "is-disabled";
      default:
        return item.enabled ? "is-loaded" : "is-disabled";
    }
  }

  function stateClass(state) {
    return String(state ?? "unknown").replace(/[^a-z-]/gi, "") || "unknown";
  }

  /** Compact per-row state chip from `mcp_server_status`. */
  function renderStatusBadge(status) {
    if (!status) return null;
    const state = String(status.state ?? "");
    const badge = document.createElement("span");
    badge.className = `mcp-badge mcp-status-badge is-${stateClass(state)}`;
    if (state === "connected") {
      const count = Array.isArray(status.tools) ? status.tools.length : 0;
      badge.textContent =
        count > 0
          ? t("settings.mcp.status.connected", { count })
          : t("settings.mcp.status.connectedNoTools");
    } else if (state === "needs-auth") {
      badge.textContent = t("settings.mcp.status.needsAuth");
    } else if (state === "disabled") {
      badge.textContent = t("settings.mcp.status.disabled");
    } else if (state === "error") {
      // Summary in the chip, full text on `title` (never rendered raw).
      const detail = String(status.error ?? "");
      badge.textContent = summarize(detail) || t("settings.mcp.status.error");
      badge.title = detail;
    } else {
      badge.textContent = state || t("settings.mcp.status.unknown");
    }
    return badge;
  }

  function summarize(text) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > ERROR_SUMMARY_CHARS
      ? `${collapsed.slice(0, ERROR_SUMMARY_CHARS - 1)}…`
      : collapsed;
  }

  /**
   * Sign-in / sign-out affordances for the selected row. Sign-out needs a live
   * connected HTTP server; sign-in is offered to every other authorization-
   * capable HTTP server. A project row pi does not report at all means the
   * project is not trusted (pi omits it), so the button is disabled with an
   * explicit reason instead of surfacing pi's raw trust error.
   */
  function renderOAuthRow(item) {
    if (!mcpLogin) return null;
    const live = statusFor(item.name, activeTab);
    const isHttp = /http/i.test(transportOf(item, live));
    const state = live?.state ?? null;
    const untrustedProject = activeTab === "project" && !live;
    const canSignOut = isHttp && state === "connected";
    // Sign-in targets MCP OAuth only: pi must explicitly report
    // `needs-auth`. An `error` or missing report (status query failed,
    // headers-based auth) is not something `/mcp login` can fix, so no
    // button — the error badge carries the detail instead. The one
    // exception is an unreported project row: pi omits untrusted projects,
    // so the disabled button explains why.
    const canSignIn = isHttp && item.enabled && (state === "needs-auth" || untrustedProject);
    if (!canSignIn && !canSignOut) return null;

    const row = document.createElement("div");
    row.className = "mcp-toggle-row";
    const badge = renderStatusBadge(live);
    if (badge) row.appendChild(badge);

    if (canSignIn) {
      const signIn = actionButton("mcp-login", t("settings.mcp.signIn"), "mcp-btn mcp-btn-primary");
      if (untrustedProject) {
        signIn.disabled = true;
        signIn.title = t("settings.mcp.projectUntrusted");
        const hint = document.createElement("span");
        hint.className = "mcp-toggle-label";
        hint.textContent = t("settings.mcp.projectUntrusted");
        row.append(signIn, hint);
      } else {
        signIn.addEventListener("click", () => startLogin(item.name));
        row.appendChild(signIn);
      }
    }
    if (canSignOut) {
      const signOut = actionButton(
        "mcp-logout",
        t("settings.mcp.signOut"),
        "mcp-btn mcp-btn-danger",
      );
      signOut.addEventListener("click", () => {
        signOut.disabled = true;
        void signOutServer(item.name);
      });
      row.appendChild(signOut);
    }
    return row;
  }

  function actionButton(action, label, className) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.dataset.action = action;
    node.textContent = label;
    return node;
  }

  function startLogin(name) {
    if (!mcpLogin) return;
    loginDialog?.destroy();
    loginDialog = createMcpLoginDialog({
      name,
      start: () => mcpLogin.start(name),
      cancel: (operationId) => mcpLogin.cancel(operationId),
      status: (operationId) => mcpLogin.status(operationId),
      subscribe: (listener) => mcpLogin.subscribe(listener),
      openExternal: (url) => openAuthUrl(url),
      // The dialog closes itself on success; the badge turns connected, so a
      // fresh status + list read is the confirmation.
      onSuccess: async () => {
        setStatus(t("settings.mcp.signedIn"));
        await loadStatus();
        await load();
      },
    });
    void loginDialog.start();
  }

  async function signOutServer(name) {
    if (!mcpLogin) return;
    const result = await Promise.resolve()
      .then(() => mcpLogin.logout(name))
      .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!result?.ok) {
      setStatus(String(result?.error ?? "logout failed"));
      render();
      return;
    }
    setStatus(t("settings.mcp.saved"));
    await loadStatus();
    await load();
  }

  /** Same host opener the other native pages use; a non-native client has no
   * opener, so the URL shown in the dialog stays the fallback. */
  function openAuthUrl(url) {
    if (!url) return;
    if (!openExternal) return;
    Promise.resolve(openExternal(url)).catch((error) => {
      console.error("[mcp] failed to open authorization URL:", error);
    });
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

    const oauthRow = renderOAuthRow(item);
    if (oauthRow) wrap.appendChild(oauthRow);

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
    toggle.className = `pkg-manager-toggle${item.enabled ? " is-on" : ""}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(item.enabled));
    toggle.setAttribute("aria-label", t("settings.mcp.enable"));
    toggle.appendChild(document.createElement("span"));
    toggle.addEventListener("click", async () => {
      const result = await call("mcp_toggle_server", {
        scope: activeTab,
        name: item.name,
        disable: item.enabled,
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

    // Exposure mirrors pi's own /mcp picker: codemode (default) / deferred /
    // direct / hidden. Saving "codemode" omits the key, matching pi's
    // updateMcpServerConfig (config.ts:145 deletes the default value).
    const exposureSelect = document.createElement("select");
    for (const value of ["codemode", "direct", "deferred", "hidden"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = t(`settings.mcp.form.exposure_${value}`);
      exposureSelect.appendChild(opt);
    }
    exposureSelect.value =
      existing?.exposure === "direct" ||
      existing?.exposure === "deferred" ||
      existing?.exposure === "hidden"
        ? existing.exposure
        : "codemode";
    const exposureRow = fieldRow(t("settings.mcp.form.exposure"), exposureSelect);

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
      if (exposureSelect.value === "codemode") delete entry.exposure;
      else entry.exposure = exposureSelect.value;
      const targetName = isEdit ? name : nameInput.value.trim();
      const result = await call("mcp_save_server", {
        scope,
        name: targetName,
        entry,
      });
      if (result.ok) {
        selections.set(activeTab, { name: targetName });
        mode = "view";
        setStatus(t("settings.mcp.saved"));
        await load();
      } else setStatus(String(result.error ?? "save failed"));
    });

    form.append(
      nameRow,
      typeRow,
      commandRow,
      urlRow,
      argsRow,
      envRow,
      headersRow,
      exposureRow,
      actions,
    );
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
      ensureSelection();
      render();
    });
  }

  function destroy() {
    loginDialog?.destroy();
    loginDialog = null;
    unsubscribeLocale();
  }

  return { activate, refreshAvailability, destroy };
}
