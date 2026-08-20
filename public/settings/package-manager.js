// ABOUTME: Renders the Settings > Extensions Installed package manager.
// ABOUTME: Keeps package selection, scope grouping, resource details, and native mutations isolated.

const RESOURCE_GROUPS = [
  ["extensions", "extensions"],
  ["skills", "skills"],
  ["prompts", "prompts"],
  ["themes", "themes"],
];

function sourceOf(pkg) {
  return typeof pkg?.source === "string" ? pkg.source : "";
}

function packageKey(pkg) {
  return `${pkg.scope}\0${pkg.source}`;
}

function shortenPath(value) {
  return String(value || "").replace(/^\/(Users|home)\/[^/]+/, "~");
}

function scopeLabel(scope, t) {
  return scope === "project" ? t("extensions.scopeProject") : t("extensions.scopeGlobal");
}

function resourceSummary(pkg, t) {
  const parts = RESOURCE_GROUPS.map(([key, label]) => {
    const count = Number(pkg.counts?.[key] || 0);
    return count ? t("extensions.resourceCount", { count, label }) : "";
  }).filter(Boolean);
  return parts.length ? parts.join(" · ") : t("extensions.noResources");
}

function statusFor(pkg) {
  if (pkg.disabled) return "disabled";
  return pkg.installedPath ? "loaded" : "installed";
}

function text(root, value) {
  const el = root.createElement("span");
  el.textContent = value;
  return el;
}

function button(root, label, { danger = false, disabled = false } = {}) {
  const el = root.createElement("button");
  el.type = "button";
  el.className = `settings-value-btn pkg-manager-btn${danger ? " is-danger" : ""}`;
  el.disabled = disabled;
  el.textContent = label;
  return el;
}

function empty(root, label) {
  const el = root.createElement("div");
  el.className = "settings-api-keys-empty pkg-manager-empty";
  el.textContent = label;
  return el;
}

function errorText(error) {
  return String(error?.message || error || "unknown error");
}

export function setupPackageManager({
  root = document,
  transport,
  nativeAvailable = () => false,
  t,
  getWorkspaceId,
  getSessionId,
  onRestarted,
}) {
  const groupsEl = root.getElementById("pkg-manager-groups");
  if (!groupsEl) return { load: async () => {} };
  const detailEl = root.getElementById("pkg-manager-detail");
  const footerEl = root.getElementById("pkg-manager-footer");

  let packages = [];
  let selectedKey = null;
  let busyKey = null;
  let restarting = false;
  let pendingLoad = null;
  let notice = null;

  function normalized(listed) {
    return (Array.isArray(listed) ? listed : [])
      .map((entry) => {
        const pkg = typeof entry === "string" ? { source: entry } : entry || {};
        return {
          source: sourceOf(pkg),
          scope: pkg.scope === "project" ? "project" : "global",
          installedPath: pkg.installedPath || null,
          packageName: pkg.packageName || null,
          version: pkg.version || null,
          description: pkg.description || null,
          disabled: Boolean(pkg.disabled),
          updateAvailable: typeof pkg.updateAvailable === "boolean" ? pkg.updateAvailable : null,
          counts: pkg.counts || {},
          resources: Array.isArray(pkg.resources) ? pkg.resources : [],
        };
      })
      .filter((pkg) => pkg.source);
  }

  async function runLoad() {
    packages = packages.map((pkg) => ({ ...pkg, updateAvailable: null }));
    // Surface the whole load (list + update check) in the footer so the user can
    // see why every Update button is disabled.
    notice = t("extensions.checkingUpdates");
    render();
    if (!nativeAvailable()) {
      // Transient capability loss (e.g. during a reconnect) must not wipe an
      // already-loaded list; the capabilities event triggers a recovery refresh.
      notice = t("extensions.managementUnavailable");
      return render();
    }
    try {
      packages = normalized(await transport.listPiPackages()).map((pkg) => ({
        ...pkg,
        updateAvailable: null,
      }));
      if (!packages.some((pkg) => packageKey(pkg) === selectedKey)) {
        selectedKey = packages[0] ? packageKey(packages[0]) : null;
      }
      render();
    } catch (error) {
      notice = errorText(error);
      groupsEl.replaceChildren(empty(root, notice));
      detailEl?.replaceChildren();
      renderFooter();
      return;
    }

    try {
      const updates = await transport.checkPiPackageUpdates();
      const availableByKey = new Map(
        (Array.isArray(updates) ? updates : []).map((update) => [
          `${update.scope}\0${update.source}`,
          update.available === true,
        ]),
      );
      packages = packages.map((pkg) => ({
        ...pkg,
        updateAvailable: availableByKey.get(packageKey(pkg)) ?? false,
      }));
      notice = null;
    } catch (error) {
      notice = errorText(error);
    }
    render();
  }

  // Every entry into the Installed page re-runs the list + update check with all
  // update buttons disabled first; concurrent activations share one in-flight load.
  function load() {
    if (pendingLoad) return pendingLoad;
    pendingLoad = runLoad().finally(() => {
      pendingLoad = null;
    });
    return pendingLoad;
  }

  function render() {
    renderGroups();
    const selected = packages.find((pkg) => packageKey(pkg) === selectedKey);
    renderDetail(selected || null);
    renderFooter();
  }

  function renderGroups() {
    groupsEl.replaceChildren();
    if (notice && !packages.length) {
      groupsEl.appendChild(empty(root, notice));
      return;
    }
    if (!packages.length) {
      groupsEl.appendChild(empty(root, t("extensions.noInstalled")));
      return;
    }
    for (const scope of ["global", "project"]) {
      const scoped = packages.filter((pkg) => pkg.scope === scope);
      if (!scoped.length) continue;
      const heading = root.createElement("div");
      heading.className = "pkg-manager-group-header";
      heading.textContent = scopeLabel(scope, t).toUpperCase();
      groupsEl.appendChild(heading);
      for (const pkg of scoped) groupsEl.appendChild(renderSidebarRow(pkg));
    }
  }

  function renderSidebarRow(pkg) {
    const row = root.createElement("button");
    row.type = "button";
    row.className = `pkg-manager-sidebar-row${packageKey(pkg) === selectedKey ? " is-selected" : ""}`;
    row.addEventListener("click", () => {
      selectedKey = packageKey(pkg);
      render();
    });
    const name = root.createElement("div");
    name.className = "pkg-manager-sidebar-name";
    name.textContent = pkg.packageName || pkg.source;
    const meta = root.createElement("div");
    meta.className = "pkg-manager-sidebar-meta";
    const dot = root.createElement("span");
    dot.className = `pkg-manager-status-dot is-${statusFor(pkg)}`;
    const status = statusFor(pkg);
    dot.setAttribute(
      "aria-label",
      t(`extensions.status${status[0].toUpperCase()}${status.slice(1)}`),
    );
    meta.append(
      dot,
      text(
        root,
        [resourceSummary(pkg, t), pkg.version ? `v${pkg.version}` : ""].filter(Boolean).join(" · "),
      ),
    );
    if (pkg.updateAvailable === true) {
      const update = root.createElement("span");
      update.className = "pkg-manager-update-badge";
      update.textContent = t("extensions.updateAvailable");
      update.title = t("extensions.updateAvailable");
      update.setAttribute("role", "status");
      meta.appendChild(update);
    }
    row.append(name, meta);
    return row;
  }

  function renderDetail(pkg) {
    if (!detailEl) return;
    detailEl.replaceChildren();
    if (!pkg) return;
    const key = packageKey(pkg);
    const busy = busyKey === key;
    const header = root.createElement("div");
    header.className = "pkg-manager-detail-header";
    const toggle = root.createElement("button");
    toggle.type = "button";
    toggle.className = `pkg-manager-toggle${pkg.disabled ? "" : " is-on"}`;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(!pkg.disabled));
    toggle.setAttribute(
      "aria-label",
      pkg.disabled ? t("extensions.enablePackage") : t("extensions.disablePackage"),
    );
    toggle.disabled = busy;
    toggle.appendChild(root.createElement("span"));
    toggle.addEventListener("click", () => setDisabled(pkg, key));
    header.appendChild(toggle);
    const scope = root.createElement("span");
    scope.className = "pkg-manager-scope";
    scope.textContent = scopeLabel(pkg.scope, t);
    const source = root.createElement("span");
    source.className = "pkg-manager-source";
    source.textContent = pkg.source;
    source.title = pkg.source;
    header.append(scope, source);
    if (pkg.updateAvailable === true) {
      const updateBadge = root.createElement("span");
      updateBadge.className = "pkg-manager-update-badge";
      updateBadge.textContent = t("extensions.updateAvailable");
      updateBadge.setAttribute("role", "status");
      header.appendChild(updateBadge);
    }
    detailEl.appendChild(header);

    const actions = root.createElement("div");
    actions.className = "settings-extension-actions pkg-manager-actions";
    const update = button(root, t("extensions.update"), {
      disabled: busy || pkg.updateAvailable !== true,
    });
    update.addEventListener("click", () => updatePackage(pkg, key));
    const remove = button(root, t("extensions.remove"), { danger: true, disabled: busy });
    remove.addEventListener("click", () => removePackage(pkg, key));
    actions.append(update, remove);
    detailEl.appendChild(actions);

    const status = root.createElement("div");
    status.className = "pkg-manager-status-grid";
    addStatus(
      status,
      t("extensions.status"),
      t(`extensions.status${statusFor(pkg)[0].toUpperCase()}${statusFor(pkg).slice(1)}`),
    );
    if (pkg.version) addStatus(status, t("extensions.version"), pkg.version);
    if (pkg.packageName) addStatus(status, t("extensions.package"), pkg.packageName);
    if (pkg.description)
      addStatus(status, t("extensions.description"), pkg.description, { wrap: true });
    addStatus(status, t("extensions.resources"), resourceSummary(pkg, t));
    addStatus(
      status,
      t("extensions.installPath"),
      pkg.installedPath ? shortenPath(pkg.installedPath) : t("extensions.notOnDisk"),
    );
    detailEl.appendChild(status);

    const title = root.createElement("div");
    title.className = "settings-section-title settings-section-title-small";
    title.textContent = t("extensions.resolvedResources");
    detailEl.appendChild(title);
    const resources = root.createElement("div");
    resources.className = "pkg-manager-resource-list";
    if (!pkg.resources.length) {
      resources.appendChild(empty(root, t("extensions.noResources")));
    } else {
      for (const resource of pkg.resources) {
        const row = root.createElement("div");
        row.className = "pkg-manager-resource-row";
        const name = text(root, resource.name || "");
        name.className = "pkg-manager-resource-name";
        const path = text(root, resource.relativePath || "");
        path.className = "pkg-manager-resource-path";
        row.append(name, path);
        resources.appendChild(row);
      }
    }
    detailEl.appendChild(resources);
  }

  function addStatus(parent, label, value, { wrap = false } = {}) {
    const row = root.createElement("div");
    row.className = "pkg-manager-status-row";
    const valueEl = text(root, value);
    // Long values such as descriptions wrap instead of single-line truncating.
    if (wrap) valueEl.classList.add("is-wrap");
    row.append(text(root, label), valueEl);
    parent.appendChild(row);
  }

  function renderFooter() {
    if (!footerEl) return;
    footerEl.replaceChildren();
    if (notice) footerEl.appendChild(empty(root, notice));
    const summary = root.createElement("span");
    summary.className = "pkg-manager-footer-summary";
    const totals = Object.fromEntries(RESOURCE_GROUPS.map(([key]) => [key, 0]));
    for (const pkg of packages)
      for (const [key] of RESOURCE_GROUPS) totals[key] += Number(pkg.counts?.[key] || 0);
    summary.textContent = packages.length
      ? RESOURCE_GROUPS.map(([key, label]) => `${totals[key]} ${label}`).join(" · ")
      : t("extensions.noPackagesSummary");
    footerEl.appendChild(summary);
    const reload = button(
      root,
      restarting ? t("extensions.reloadingAgent") : t("extensions.reloadAgent"),
      { disabled: !packages.length || Boolean(busyKey) || restarting },
    );
    reload.id = "pkg-manager-reload-btn";
    reload.addEventListener("click", restartRuntime);
    const refresh = button(root, t("extensions.refresh"), { disabled: restarting });
    refresh.addEventListener("click", () => load());
    footerEl.append(reload, refresh);
  }

  async function setDisabled(pkg, key) {
    if (busyKey) return;
    busyKey = key;
    render();
    try {
      await transport.setPiPackageDisabled(pkg.source, pkg.scope, !pkg.disabled, "");
      pkg.disabled = !pkg.disabled;
      notice = t(
        pkg.disabled ? "extensions.packageDisabledMessage" : "extensions.packageEnabledMessage",
        { source: pkg.source },
      );
    } catch (error) {
      notice = errorText(error);
    } finally {
      busyKey = null;
      render();
    }
  }

  async function updatePackage(pkg, key) {
    if (busyKey) return;
    busyKey = key;
    render();
    try {
      await transport.updatePiPackage(pkg.source, { local: pkg.scope === "project" });
      notice = t("extensions.updateMessage", { source: pkg.source });
      await load();
    } catch (error) {
      notice = errorText(error);
      render();
    } finally {
      busyKey = null;
      render();
    }
  }

  async function removePackage(pkg, key) {
    if (busyKey) return;
    busyKey = key;
    render();
    try {
      await transport.removePiPackage(pkg.source, { local: pkg.scope === "project" });
      packages = packages.filter((entry) => packageKey(entry) !== key);
      selectedKey = packages[0] ? packageKey(packages[0]) : null;
      notice = t("extensions.removeMessage", { source: pkg.source });
    } catch (error) {
      notice = errorText(error);
    } finally {
      busyKey = null;
      render();
    }
  }

  async function restartRuntime() {
    if (restarting || busyKey) return;
    // The host resolves the workspace and active session from the authenticated
    // owner, so a missing client-side session id must not block the reload.
    const workspaceId = getWorkspaceId?.() || "";
    const sessionId = getSessionId?.() || "";
    restarting = true;
    notice = t("extensions.reloadingAgent");
    render();
    try {
      await transport.restartRuntime(workspaceId, sessionId);
      notice = null;
      onRestarted?.();
    } catch (error) {
      notice = errorText(error);
    } finally {
      restarting = false;
      render();
    }
  }

  return { load, refresh: () => load(), getPackages: () => packages.slice() };
}
