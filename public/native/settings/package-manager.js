// Settings → Extensions → "Installed Packages" management.
//
// Owns the management layer that pi-web exposes but Picot's community browser
// does not: a master-detail view over the installed packages — sidebar list
// grouped by scope, and a detail pane with enable/disable, update, remove,
// status fields, and the resolved extensions/skills/prompts/themes a package
// contributes — plus an agent-reload action and a diagnostics/totals footer.
// Package operations run the embedded `pi` CLI on the Rust host via the
// HostControlGateway (`host_request` frames); `listPiPackages` returns full
// package objects including package-level metadata and a resolved `resources` list.
//
// This is a distinct concern from the community catalog browser
// (package-browse.js), so it lives in its own module per the repo's
// one-concern-per-file rule.

import { t } from "../../i18n.js";
import { getPackageInstallFailure } from "../../packages/install-status.js";

const RESOURCE_GROUPS = [
  ["extensions", "extensions"],
  ["skills", "skills"],
  ["prompts", "prompts"],
  ["themes", "themes"],
];

function sourceOf(pkg) {
  return typeof pkg?.source === "string" ? pkg.source : "";
}

function keyOf(pkg) {
  return `${pkg.scope}\0${pkg.source}`;
}

// Normalize a user-typed install source: trim whitespace and unwrap a pasted
// `pi install ...` command so any of `npm:foo`, `pi install npm:foo`, or
// `npm install @scope/pkg` style inputs work.
function normalizeSource(raw) {
  let value = String(raw || "").trim();
  const installMatch = value.match(/(?:^|\s)(?:pi|npm)\s+install\s+(.+)$/i);
  if (installMatch) {
    value = installMatch[1]
      .split(/\s+/)
      .filter((part) => part && !part.startsWith("-"))
      .join(" ");
  }
  return value.trim();
}

function shortenPath(path) {
  if (!path) return "";
  return String(path).replace(/^\/?(Users|home)\/[^/]+/, "~");
}

function statusColor(status) {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-secondary)";
  return "#ef4444";
}

function statusLabel(status) {
  return status || "unknown";
}

function installedPathLabel(pkg) {
  return pkg?.installedPath ? shortenPath(pkg.installedPath) : t("extensions.notOnDisk");
}

function resourceSummary(pkg) {
  const parts = RESOURCE_GROUPS.map(([key, label]) => {
    const count = pkg?.counts?.[key] ?? 0;
    return count > 0 ? t("extensions.resourceCount", { count, label }) : "";
  }).filter(Boolean);
  return parts.length ? parts.join(" · ") : t("extensions.noResources");
}

function scopeLabel(scope) {
  return scope === "project" ? t("extensions.scopeProject") : t("extensions.scopeGlobal");
}

function iconButton(label, { danger = false, disabled = false, title = "" } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-value-btn pkg-manager-btn";
  if (danger) btn.classList.add("is-danger");
  btn.disabled = disabled;
  btn.textContent = label;
  if (title) btn.title = title;
  return btn;
}

function makeToggle({ enabled, loading, onToggle, label }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pkg-manager-toggle";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", String(enabled));
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.addEventListener("click", onToggle);
  const knob = document.createElement("span");
  knob.className = "pkg-manager-toggle-knob";
  btn.appendChild(knob);
  updateToggle(btn, enabled, loading);
  return btn;
}

function updateToggle(btn, enabled, loading) {
  if (!btn) return;
  btn.classList.toggle("is-on", enabled);
  btn.classList.toggle("is-loading", Boolean(loading));
  btn.setAttribute("aria-checked", String(enabled));
  btn.disabled = Boolean(loading);
}

function message(text, { isError = false } = {}) {
  const el = document.createElement("div");
  el.className = `pkg-manager-message${isError ? " is-error" : ""}`;
  el.textContent = text;
  return el;
}

function statusRow(label, value) {
  const row = document.createElement("div");
  row.className = "pkg-manager-status-row";
  const labelEl = document.createElement("span");
  labelEl.className = "pkg-manager-status-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "pkg-manager-status-value";
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

// Wires the Settings → Extensions installed-package management UI.
// `deps` = { control, data, notify, getWorkspaceId, getSessionId, onRestarted }.
export function setupPackageManager(deps) {
  const { control } = deps;
  const groupsEl = document.getElementById("pkg-manager-groups");
  if (!groupsEl) return { load() {} };

  const sectionEl = document.getElementById("pkg-manager-section");
  const detailEl = document.getElementById("pkg-manager-detail");
  const footerEl = document.getElementById("pkg-manager-footer");
  const addBtn = document.getElementById("pkg-manager-add-btn");
  const canManage = Boolean(control);

  let cwd = "";
  let packages = [];
  let selectedKey = null;
  let busyScope = null; // key that identifies which per-package action is in flight
  let restarting = false;
  let lastError = null;
  let lastMessage = null;
  let lastLoaded = false;
  let checkingUpdates = false;
  let updatingAll = false;
  let checkNotice = null;
  let checkInFlight = null;

  async function resolveCwd() {
    try {
      const workspaceId = deps.getWorkspaceId?.();
      if (!workspaceId || !deps.data) return "";
      const info = await deps.data.workspaceInfo(workspaceId);
      return info?.info?.path ?? "";
    } catch {
      return "";
    }
  }

  addBtn?.addEventListener("click", () => {
    // Adding a plugin means going to browse the community catalog: reveal the
    // package browser section (hidden by default), load it, and scroll to it.
    const browseSection = document.getElementById("pkg-browse-section");
    if (!browseSection) return;
    if (sectionEl) sectionEl.hidden = true;
    browseSection.hidden = false;
    if (deps.onBrowseRevealed) deps.onBrowseRevealed();
    browseSection.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });

  // Close button hides the package browser section again (return to the
  // installed-packages view). Attached once so it survives repeated open/close.
  document.getElementById("pkg-browse-close-btn")?.addEventListener("click", () => {
    const browseSection = document.getElementById("pkg-browse-section");
    if (browseSection) browseSection.hidden = true;
    if (sectionEl) sectionEl.hidden = false;
  });

  async function load(force = false) {
    // runUpdateAll owns the list while it is in flight; a concurrent reload
    // (e.g. re-entering the tab mid-update) would swap the list underneath it.
    if (updatingAll) return;
    if (!force && lastLoaded) {
      render();
      return;
    }
    lastLoaded = true;
    if (!canManage) {
      renderEmpty(t("extensions.managementUnavailable"));
      return;
    }
    try {
      await fetchList(null);
    } catch (error) {
      renderError(error);
      return;
    }
    render();
    await checkForUpdates();
  }

  // Re-list installed packages. `previousStates` (keyOf -> updateAvailable) keeps
  // already-known update badges stable across the reload instead of resetting them.
  async function fetchList(previousStates) {
    cwd = await resolveCwd();
    const listed = await control.listPiPackages();
    packages = (Array.isArray(listed) ? listed : []).map((pkg, index) => {
      const p = typeof pkg === "string" ? { source: pkg } : pkg;
      const status = p.disabled ? "disabled" : p.installedPath ? "loaded" : "installed";
      const source = sourceOf(p);
      // Normalize the scope once here so keyOf() below always produces the same
      // key format as the update-probe response mapping.
      const scope = p.scope === "project" ? "project" : "global";
      const key = `${scope}\0${source}`;
      return {
        source,
        scope,
        installedPath: p.installedPath || null,
        packageName: p.packageName || null,
        version: p.version || null,
        description: p.description || null,
        disabled: Boolean(p.disabled),
        status,
        counts: p.counts || {},
        resources: Array.isArray(p.resources) ? p.resources : [],
        index,
        updateAvailable: previousStates?.get(key) ?? null,
      };
    });
    if (!packages.some((p) => keyOf(p) === selectedKey)) {
      selectedKey = packages[0] ? keyOf(packages[0]) : null;
    }
  }

  function updateCount() {
    return packages.filter((pkg) => pkg.updateAvailable === true).length;
  }

  // Probe every installed package for an available update. Concurrent calls are
  // merged into one probe so re-entering the page never stacks network checks.
  function checkForUpdates() {
    if (updatingAll) return Promise.resolve();
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
      checkingUpdates = true;
      checkNotice = null;
      render();
      try {
        const updates = await control.checkPiPackageUpdates(deps.getWorkspaceId?.());
        const availableByKey = new Map(
          (Array.isArray(updates) ? updates : []).map((update) => [
            `${update.scope === "project" ? "project" : "global"}\0${update.source}`,
            update.available === true,
          ]),
        );
        packages = packages.map((pkg) => ({
          ...pkg,
          updateAvailable: availableByKey.get(keyOf(pkg)) ?? false,
        }));
      } catch {
        // Keep the loaded list; every Update button stays disabled because no
        // package reports updateAvailable === true, and the notice explains why.
        checkNotice = t("extensions.checkUpdatesFailed");
      } finally {
        checkingUpdates = false;
        render();
        deps.onUpdatesChecked?.(updateCount());
      }
    })();
    return checkInFlight.finally(() => {
      checkInFlight = null;
    });
  }

  function render() {
    sectionEl?.classList.remove("hidden");
    renderGroups();
    renderDetail(packages.find((p) => keyOf(p) === selectedKey) || null);
    renderFooter();
    flashMessage();
  }

  function renderEmpty(text) {
    groupsEl.replaceChildren(emptyNote(text));
    detailEl?.replaceChildren();
    renderFooter();
  }

  function renderError(error) {
    const msg = message(
      error?.message ? `Failed to load installed packages: ${error.message}` : String(error),
      { isError: true },
    );
    groupsEl.replaceChildren(msg);
    detailEl?.replaceChildren();
    renderFooter();
  }

  function emptyNote(text) {
    const el = document.createElement("div");
    el.className = "settings-api-keys-empty";
    el.textContent = text;
    return el;
  }

  function noticeNote(text, isError = false) {
    const el = document.createElement("div");
    el.className = `pkg-manager-notice${isError ? " pkg-manager-notice-error" : ""}`;
    el.textContent = text;
    return el;
  }

  function renderGroups() {
    groupsEl.innerHTML = "";
    if (!packages.length) {
      groupsEl.appendChild(emptyNote(t("extensions.noInstalled")));
      return;
    }
    for (const scope of ["global", "project"]) {
      const scoped = packages.filter((pkg) => pkg.scope === scope);
      if (!scoped.length) continue;
      const header = document.createElement("div");
      header.className = "pkg-manager-group-header";
      header.textContent = scopeLabel(scope).toUpperCase();
      groupsEl.appendChild(header);
      for (const pkg of scoped) groupsEl.appendChild(renderSidebarRow(pkg));
    }
  }

  function renderSidebarRow(pkg) {
    const key = keyOf(pkg);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `pkg-manager-sidebar-row${key === selectedKey ? " is-selected" : ""}`;
    row.addEventListener("click", () => {
      selectedKey = key;
      render();
    });

    const name = document.createElement("div");
    name.className = "pkg-manager-sidebar-name";
    name.textContent = pkg.packageName || pkg.source;
    row.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "pkg-manager-sidebar-meta";
    const dot = document.createElement("span");
    dot.className = "pkg-manager-status-dot";
    dot.style.background = statusColor(pkg.status);
    dot.title = statusLabel(pkg.status);
    meta.appendChild(dot);
    const metaText = document.createElement("span");
    metaText.textContent = [resourceSummary(pkg), pkg.version ? `v${pkg.version}` : ""]
      .filter(Boolean)
      .join(" · ");
    meta.appendChild(metaText);
    if (pkg.updateAvailable === true) {
      meta.appendChild(updateBadge());
    }
    row.appendChild(meta);

    return row;
  }

  function updateBadge() {
    const badge = document.createElement("span");
    badge.className = "pkg-manager-update-badge";
    badge.textContent = t("extensions.updateAvailable");
    badge.title = t("extensions.updateAvailable");
    badge.setAttribute("role", "status");
    return badge;
  }

  function renderDetail(pkg) {
    if (!detailEl) return;
    detailEl.innerHTML = "";
    if (!pkg) return;
    const key = keyOf(pkg);
    const busy = busyScope === key;

    const header = document.createElement("div");
    header.className = "pkg-manager-detail-header";
    const toggle = makeToggle({
      enabled: !pkg.disabled,
      loading: busy,
      label: pkg.disabled ? t("extensions.enablePackage") : t("extensions.disablePackage"),
      onToggle: () => runToggle(pkg, key),
    });
    header.appendChild(toggle);

    const scopeTag = document.createElement("span");
    scopeTag.className = "pkg-manager-scope";
    scopeTag.textContent = scopeLabel(pkg.scope);
    header.appendChild(scopeTag);

    const sourceEl = document.createElement("span");
    sourceEl.className = "pkg-manager-source";
    sourceEl.textContent = pkg.source;
    sourceEl.title = pkg.source;
    header.appendChild(sourceEl);
    if (pkg.updateAvailable === true) {
      header.appendChild(updateBadge());
    }
    detailEl.appendChild(header);

    const actions = document.createElement("div");
    actions.className = "settings-extension-actions pkg-manager-actions";

    // The update probe decides whether an update actually exists; until it
    // succeeds for this package (updateAvailable === true) the button stays off.
    const updateBtn = iconButton(t("extensions.update"), {
      disabled: busy || !canManage || pkg.updateAvailable !== true || updatingAll,
      title: t("extensions.updateTip"),
    });
    updateBtn.addEventListener("click", () => runUpdate(pkg, key));
    actions.appendChild(updateBtn);

    const removeBtn = iconButton(t("extensions.remove"), {
      danger: true,
      disabled: busy || !canManage,
      title: t("extensions.removeTip"),
    });
    removeBtn.addEventListener("click", () => runRemove(pkg, key));
    actions.appendChild(removeBtn);
    detailEl.appendChild(actions);

    const statusGrid = document.createElement("div");
    statusGrid.className = "pkg-manager-status-grid";
    statusGrid.appendChild(statusRow(t("extensions.status"), statusLabel(pkg.status)));
    if (pkg.version) statusGrid.appendChild(statusRow(t("extensions.version"), pkg.version));
    if (pkg.packageName)
      statusGrid.appendChild(statusRow(t("extensions.package"), pkg.packageName));
    if (pkg.description)
      statusGrid.appendChild(statusRow(t("extensions.description"), pkg.description));
    statusGrid.appendChild(statusRow(t("extensions.resources"), resourceSummary(pkg)));
    statusGrid.appendChild(statusRow(t("extensions.installPath"), installedPathLabel(pkg)));
    if (cwd) statusGrid.appendChild(statusRow(t("extensions.cwd"), cwd));
    detailEl.appendChild(statusGrid);

    const resolvedTitle = document.createElement("div");
    resolvedTitle.className = "settings-section-title settings-section-title-small";
    resolvedTitle.textContent = t("extensions.resolvedResources");
    detailEl.appendChild(resolvedTitle);

    const resourceList = document.createElement("div");
    resourceList.className = "pkg-manager-resource-list";
    if (!pkg.resources.length) {
      resourceList.appendChild(emptyNote(t("extensions.noResources")));
    } else {
      for (const entry of pkg.resources) {
        const row = document.createElement("div");
        row.className = "pkg-manager-resource-row";
        const name = document.createElement("span");
        name.className = "pkg-manager-resource-name";
        name.textContent = entry.name;
        const path = document.createElement("span");
        path.className = "pkg-manager-resource-path";
        path.textContent = entry.relativePath;
        row.append(name, path);
        resourceList.appendChild(row);
      }
    }
    detailEl.appendChild(resourceList);
  }

  function renderFooter() {
    if (!footerEl) return;
    footerEl.innerHTML = "";
    // Check-state notices use their own class on purpose: flashMessage manages
    // .pkg-manager-message elements and would otherwise wipe these on re-render.
    if (checkingUpdates) {
      footerEl.appendChild(noticeNote(t("extensions.checkingUpdates")));
    } else if (checkNotice) {
      footerEl.appendChild(noticeNote(checkNotice, true));
    }
    if (!packages.length) {
      footerEl.appendChild(document.createTextNode(t("extensions.noPackagesSummary")));
      return;
    }
    const totals = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
    for (const pkg of packages) {
      for (const [key] of RESOURCE_GROUPS) {
        totals[key] += pkg.counts?.[key] ?? 0;
      }
    }
    const summary = document.createElement("span");
    summary.className = "pkg-manager-footer-summary";
    summary.textContent = RESOURCE_GROUPS.map(([key, label]) => `${totals[key]} ${label}`).join(
      " · ",
    );
    footerEl.appendChild(summary);

    const reloadBtn = iconButton(t("extensions.reloadAgent"), {
      disabled: busyScope !== null || restarting || !canManage,
      title: t("extensions.reloadAgentTip"),
    });
    reloadBtn.id = "pkg-manager-reload-btn";
    reloadBtn.addEventListener("click", runRestart);
    footerEl.appendChild(reloadBtn);

    const updatable = updateCount();
    const updateAllBtn = iconButton(t("extensions.updateAll", { count: updatable }), {
      disabled: updatingAll || restarting || busyScope !== null || !canManage || updatable === 0,
      title: t("extensions.updateTip"),
    });
    updateAllBtn.id = "pkg-manager-update-all-btn";
    updateAllBtn.addEventListener("click", () => void runUpdateAll());
    footerEl.appendChild(updateAllBtn);

    const refreshBtn = iconButton(t("extensions.refresh"), {
      disabled: updatingAll || restarting,
      title: t("extensions.refreshTip"),
    });
    refreshBtn.addEventListener("click", () => load(true));
    footerEl.appendChild(refreshBtn);
  }

  // Update every package that reported an available update, one at a time so
  // failures stay isolated. Afterwards re-list to refresh versions while keeping
  // each package's last known update state (no fresh network probe).
  async function runUpdateAll() {
    if (!canManage || busyScope !== null || restarting || updatingAll) return;
    const targets = packages.filter((pkg) => pkg.updateAvailable === true);
    if (!targets.length) return;
    updatingAll = true;
    let updated = 0;
    let failed = 0;
    for (const [index, pkg] of targets.entries()) {
      checkNotice = t("extensions.updatingAll", { done: index, total: targets.length });
      render();
      try {
        await control.updatePiPackage(pkg.source);
        pkg.updateAvailable = false;
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    updatingAll = false;
    checkNotice = failed
      ? t("extensions.updatedAllWithFailures", { count: updated, failed })
      : null;
    if (!failed) {
      lastMessage = t("extensions.updatedAll", { count: updated });
      lastError = null;
    }
    const previousStates = new Map(packages.map((pkg) => [keyOf(pkg), pkg.updateAvailable]));
    try {
      await fetchList(previousStates);
    } catch {
      // Keep showing the pre-update list; the user can hit Refresh to retry.
    }
    render();
    deps.onUpdatesChecked?.(updateCount());
  }

  // Restart the embedded pi subprocess for the current workspace/session so
  // package enable/disable/update changes take effect immediately. On success
  // the caller re-bootstraps the session against the fresh runtime.
  async function runRestart() {
    if (!canManage || restarting || busyScope !== null) return;
    const workspaceId = deps.getWorkspaceId?.();
    const sessionId = deps.getSessionId?.();
    if (!workspaceId || !sessionId || !control.restartRuntime) {
      lastError = t("extensions.reloadAgentUnavailable");
      lastMessage = null;
      render();
      return;
    }
    restarting = true;
    lastError = null;
    lastMessage = t("extensions.reloadingAgent");
    render();
    try {
      await control.restartRuntime(workspaceId, sessionId);
      deps.onRestarted?.();
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      restarting = false;
      render();
    }
  }

  async function runToggle(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.setPiPackageDisabled(pkg.source, pkg.scope, !pkg.disabled, cwd);
      pkg.disabled = !pkg.disabled;
      pkg.status = pkg.disabled ? "disabled" : pkg.installedPath ? "loaded" : "installed";
      lastMessage = pkg.disabled
        ? t("extensions.packageDisabledMessage", { source: pkg.source })
        : t("extensions.packageEnabledMessage", { source: pkg.source });
      lastError = null;
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
    } finally {
      busyScope = null;
      render();
    }
  }

  async function runUpdate(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.updatePiPackage(pkg.source);
      await load(true);
      lastMessage = t("extensions.updateMessage", { source: pkg.source });
      lastError = null;
      render();
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
      render();
    } finally {
      busyScope = null;
    }
  }

  async function runRemove(pkg, key) {
    if (!canManage || busyScope) return;
    busyScope = key;
    render();
    try {
      await control.removePiPackage(pkg.source, { local: pkg.scope === "project" });
      packages = packages.filter((p) => keyOf(p) !== key);
      if (selectedKey === key) {
        selectedKey = packages[0] ? keyOf(packages[0]) : null;
      }
      lastMessage = t("extensions.removeMessage", { source: pkg.source });
      lastError = null;
      render();
    } catch (error) {
      lastError = summarizeActionError(error);
      lastMessage = null;
      render();
    } finally {
      busyScope = null;
    }
  }

  function summarizeActionError(error) {
    const failure = getPackageInstallFailure(error, "install");
    return failure.detail || String(error?.message || error || "unknown error");
  }

  // Re-render last message/error onto the footer.
  function flashMessage() {
    if (!footerEl) return;
    const existing = footerEl.querySelector(".pkg-manager-message");
    if (existing) existing.remove();
    if (lastMessage) {
      footerEl.prepend(message(lastMessage));
    } else if (lastError) {
      footerEl.prepend(message(lastError, { isError: true }));
    }
  }

  return { load };
}

export { normalizeSource };
