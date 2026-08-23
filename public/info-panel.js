// ABOUTME: Info right-side panel — fixed workspace actions plus scrollable history.
// ABOUTME: Session rows visualize Pi's native tree and synchronize with chat anchors.

/**
 * Info panel — the right-side panel from the 2026-08-21 design.
 *
 * Two independent sections:
 * 1. **Workspace** (fixed, never scrolls away): workspace path + the shared
 *    workspace-action rows (Copy path / Open in VS Code / Zed / Terminal),
 *    rendered from the ONE shared controller instance the header uses —
 *    never a second implementation.
 * 2. **Session history** (own vertical scroll): the session tree projected by
 *    `session-tree.js` from Pi's authoritative entries + leafId.
 *
 * Interaction contract (design):
 * - Clicking an ACTIVE node scrolls the main chat to the rendered message
 *   (`[data-entry-id]` anchor); it never changes leaf or composer.
 * - Inactive nodes are non-navigable divs (no fake buttons, not focusable).
 * - Inactive branches collapse at their fork point; the summary row is a real
 *   expand/collapse button; only full-tree leaves expose "Resume branch"
 *   (real button, keyboard-reachable, hover-revealed).
 */

import { createIcon } from "./icons.js";
import { buildSessionTree } from "./session-tree.js";
import { displayLocalPath } from "./workspace/path-utils.js";
import { populateAppLogo } from "./workspace-actions.js";

// Workspace app rows, in design order. Rows whose app is not installed are
// hidden (the shared controller decides what exists).
const WORKSPACE_APP_ORDER = ["vscode", "zed", "terminal"];

// Live appends keep the panel's cache current turn to turn, but entries can
// be persisted without a message_end enrichment (compaction summaries,
// enrichment failures). Calibrate by age: once the cache has gone this long
// without an authoritative full snapshot, the next append requests a full
// sync. Age-based (not append-count-based) because local re-renders and
// per-turn refreshes reset no counter.
const FULL_SYNC_MAX_AGE_MS = 10 * 60_000;

export class InfoPanel {
  /**
   * @param {{
   *   panel: HTMLElement,
   *   actions: { apps: Array, copyWorkspacePath: Function, openWorkspaceInApp: Function },
   *   t: (key: string, params?: object) => string,
   *   onNavigateLeaf: (entryId: string) => void,
   *   onSelectEntry: (entryId: string) => void,
   *   isStreaming: () => boolean,
   * }} options
   */
  constructor({ panel, actions, t, onNavigateLeaf, onSelectEntry, isStreaming }) {
    this.panel = panel;
    this.actions = actions;
    this.t = t;
    this.onNavigateLeaf = onNavigateLeaf || (() => {});
    this.onSelectEntry = onSelectEntry || (() => {});
    this.isStreaming = isStreaming || (() => false);
    this.workspacePath = "";
    this.expandedBranches = new Set();
    this.tree = null;
    // Authoritative Pi entries + leafId cache. Full snapshots (mirror_sync /
    // get_session_tree / tab re-entry) replace it; live turns append into it
    // so per-turn refreshes skip the full-tree round trip (~1 MB/turn on long
    // sessions). A full sync recalibrates eventually anyway.
    this.entries = null;
    this.leafId = null;
    // Epoch ms of the last authoritative full snapshot (updateTree). Drives
    // age-based recalibration in appendLiveEntry.
    this._lastFullSyncAt = 0;
    // Monotonic counter bumped on every cache mutation (successful live
    // append). Lets an in-flight full sync detect that it raced an append.
    this._generation = 0;
    this.selectedEntryId = null;
    this._pendingSelectedScroll = false;
    this._copiedTimer = null;
    this._buildDom();
  }

  _buildDom() {
    const p = this.panel;
    p.classList.add("info-panel");
    p.setAttribute("aria-label", this.t("infoPanel.title"));
    p.replaceChildren();

    this.workspaceSection = document.createElement("section");
    this.workspaceSection.className = "info-panel-workspace";

    this.historySection = document.createElement("section");
    this.historySection.className = "info-panel-history";
    this.historySection.setAttribute("aria-labelledby", "info-panel-history-heading");

    p.append(this.workspaceSection, this.historySection);
    this._renderWorkspace();
    this._renderHistory();
  }

  // ── Workspace ───────────────────────────────────────────────────────────

  _renderWorkspace() {
    const t = this.t;
    const section = this.workspaceSection;
    section.replaceChildren();

    section.setAttribute("aria-label", t("infoPanel.workspace"));
    this.pathEl = document.createElement("div");
    this.pathEl.className = "file-sidebar-path info-panel-path";
    this.pathEl.textContent = displayLocalPath(this.workspacePath) || "—";
    this.pathEl.title = this.workspacePath;
    section.append(this.pathEl);

    const nav = document.createElement("nav");
    nav.className = "info-panel-actions";
    nav.setAttribute("aria-label", t("infoPanel.workspace"));

    // Copy path — clipboard icon (mono action icon, per icon semantics).
    const copyRow = document.createElement("a");
    copyRow.href = "#";
    copyRow.className = "info-panel-link";
    copyRow.setAttribute("aria-label", t("infoPanel.copyPath"));
    const copyIcon = document.createElement("span");
    copyIcon.className = "info-panel-link-icon";
    copyIcon.setAttribute("aria-hidden", "true");
    copyIcon.append(createIcon("clipboard", { size: 14 }));
    this.copyLabel = document.createElement("span");
    this.copyLabel.textContent = t("infoPanel.copyPath");
    copyRow.append(copyIcon, this.copyLabel);
    copyRow.addEventListener("click", (event) => {
      event.preventDefault();
      void this._copyPath();
    });
    nav.append(copyRow);

    // Open-in-app rows — from the shared controller's app list only.
    this._appRows = new Map();
    for (const appId of WORKSPACE_APP_ORDER) {
      const row = document.createElement("a");
      row.href = "#";
      row.className = "info-panel-link info-panel-link-app hidden";
      const logo = document.createElement("span");
      logo.className = "info-panel-link-icon open-app-logo";
      logo.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      row.append(logo, label);
      row.addEventListener("click", (event) => {
        event.preventDefault();
        const app = this.actions.apps.find((a) => a?.id === appId);
        if (app) void this.actions.openWorkspaceInApp(app);
      });
      this._appRows.set(appId, { row, logo, label });
      nav.append(row);
    }
    section.append(nav);
    this._refreshAppRows();
  }

  _refreshAppRows() {
    for (const [appId, { row, logo, label }] of this._appRows) {
      const app = this.actions.apps.find((a) => a?.id === appId);
      if (!app) {
        row.classList.add("hidden");
        continue;
      }
      row.classList.remove("hidden");
      populateAppLogo(logo, app);
      const name = this.t("nav.openInApp", { app: app.label });
      label.textContent = name;
      row.setAttribute("aria-label", name);
      row.title = name;
    }
  }

  async _copyPath() {
    if (!this.copyLabel) return;
    const copied = await this.actions.copyWorkspacePath();
    if (!copied) return;
    this.copyLabel.textContent = this.t("infoPanel.copied");
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => {
      this.copyLabel.textContent = this.t("infoPanel.copyPath");
    }, 1200);
  }

  /** Update the workspace path (and re-resolve app rows from the controller). */
  updateWorkspace(path) {
    this.workspacePath = path || "";
    if (this.pathEl) {
      this.pathEl.textContent = displayLocalPath(this.workspacePath) || "—";
      this.pathEl.title = this.workspacePath;
    }
    this._refreshAppRows();
  }

  /** The shared controller reloaded its app list — re-render rows. */
  refreshApps() {
    this._refreshAppRows();
  }

  // ── Session history ─────────────────────────────────────────────────────

  _renderHistory() {
    const t = this.t;
    const section = this.historySection;
    section.replaceChildren();

    const heading = document.createElement("div");
    heading.className = "info-panel-history-heading";
    const h3 = document.createElement("h3");
    h3.className = "info-panel-title";
    h3.id = "info-panel-history-heading";
    h3.dataset.i18n = "infoPanel.sessionHistory";
    h3.textContent = t("infoPanel.sessionHistory");
    const status = document.createElement("span");
    status.className = "info-panel-status";
    status.textContent = `● ${t("infoPanel.activePath")}`;
    heading.append(h3, status);

    this.treeScroll = document.createElement("div");
    this.treeScroll.className = "info-panel-tree-scroll";
    this.treeScroll.setAttribute("role", "tree");
    this.treeScroll.setAttribute("aria-labelledby", "info-panel-history-heading");

    section.append(heading, this.treeScroll);
    this._renderTree();
  }

  /** Replace the tree data (Pi-authoritative snapshot) and re-render. */
  updateTree({ entries, leafId } = {}) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.leafId = leafId ?? null;
    // A full snapshot genuinely recalibrates the staleness clock.
    this._lastFullSyncAt = Date.now();
    this._rebuildTree();
  }

  /**
   * Re-render from the cached snapshot WITHOUT recalibrating the staleness
   * clock — a local re-render is not a fresh sync, and stamping
   * `_lastFullSyncAt` here would defeat age-based recalibration.
   */
  rerenderTree() {
    this._rebuildTree();
  }

  _rebuildTree() {
    this.tree = buildSessionTree({ entries: this.entries, leafId: this.leafId });
    // Prune expand-state for branches that no longer exist.
    const alive = new Set();
    const collect = (rows) => {
      for (const row of rows) {
        if (row.kind === "branch") {
          alive.add(row.entryId);
          collect(row.rows);
        }
      }
    };
    collect(this.tree.rows);
    for (const id of [...this.expandedBranches]) {
      if (!alive.has(id)) this.expandedBranches.delete(id);
    }
    this._renderTree();
    if (this._pendingSelectedScroll && this.selectedEntryId) {
      this._pendingSelectedScroll = false;
      this.scrollToSelectedEntry();
    }
  }

  /** Cache generation — bumped once per successful live append. */
  get generation() {
    return this._generation;
  }

  /**
   * Live-turn incremental update. Appends the just-persisted entry to the
   * cached authoritative snapshot and advances the leaf, avoiding a full
   * get_session_tree round trip per agent turn. Best-effort: any mismatch
   * (no cached snapshot, duplicate id, unknown parent, or a cache older than
   * FULL_SYNC_MAX_AGE_MS) returns false so the caller falls back to a full
   * sync. The returned-false entry is still pushed to the cache — the
   * caller's full sync replaces the cache wholesale anyway.
   */
  appendLiveEntry(entry) {
    if (!this.entries || !entry || typeof entry.id !== "string") return false;
    if (this.entries.some((e) => e?.id === entry.id)) return false;
    const parentKnown =
      entry.parentId == null || this.entries.some((e) => e?.id === entry.parentId);
    if (!parentKnown) return false;
    this.entries.push(entry);
    this.leafId = entry.id;
    this._generation += 1;
    if (Date.now() - this._lastFullSyncAt > FULL_SYNC_MAX_AGE_MS) return false; // stale cache: periodic recalibration
    this.tree = buildSessionTree({ entries: this.entries, leafId: this.leafId });
    this._renderTree();
    return true;
  }

  _renderTree() {
    if (!this.treeScroll) return;
    this.treeScroll.replaceChildren();
    const rows = this.tree?.rows ?? [];
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "info-panel-tree-empty";
      empty.textContent = this.t("infoPanel.empty");
      this.treeScroll.append(empty);
      return;
    }
    for (const row of rows) {
      this.treeScroll.append(
        row.kind === "branch" ? this._renderBranch(row) : this._nodeRowEl(row, true),
      );
    }
  }

  /**
   * A node row. `topLevel` marks rows rendered directly in the active-path
   * list (vs rows inside a collapsed branch's expanded group).
   */
  _nodeRowEl(row, topLevel = false) {
    const t = this.t;
    const el = document.createElement(row.isActive ? "button" : "div");
    el.className = "info-panel-row";
    if (topLevel) el.classList.add("info-panel-row-top");
    el.dataset.entryId = row.entryId;
    el.style.setProperty("--row-depth", String(row.depth));
    if (row.isActive) {
      el.type = "button";
      el.classList.add("active");
      // Same tree semantics as inactive rows: every row under the role=tree
      // container identifies as a treeitem; the aria-label carries role +
      // preview text.
      el.setAttribute("role", "treeitem");
      el.setAttribute(
        "aria-label",
        `${roleName(t, row)}: ${row.previewText || previewFallback(t, row)}`,
      );
      el.addEventListener("click", (event) => {
        if (event.target.closest(".info-panel-resume")) return;
        this._scrollToMessage(row.entryId);
      });
    } else {
      el.classList.add("inactive");
      el.setAttribute("role", "treeitem");
      el.setAttribute("aria-disabled", "true");
    }
    if (this.selectedEntryId === row.entryId) el.classList.add("selected");
    if (row.isCurrentLeaf) {
      el.classList.add("current-leaf");
      // The marker class is visual-only; expose the current leaf to assistive
      // technology as well.
      el.setAttribute("aria-current", "true");
    }

    const role = document.createElement("span");
    role.className = `info-panel-role ${row.role === "user" ? "user" : "assistant"}`;
    role.textContent = row.role === "user" ? "●" : "✦";
    role.setAttribute("aria-hidden", "true");

    const preview = document.createElement("span");
    preview.className = "info-panel-preview";
    preview.textContent = row.previewText || previewFallback(t, row);

    el.append(role, preview);

    // Resume affordance: only on full-tree leaves of an inactive branch.
    if (!row.isActive && row.isFullLeaf) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "info-panel-resume";
      resume.textContent = t("infoPanel.resumeBranch");
      resume.setAttribute(
        "aria-label",
        `${t("infoPanel.resumeBranch")}: ${row.previewText || previewFallback(t, row)}`,
      );
      if (this.isStreaming()) {
        resume.disabled = true;
        resume.title = t("infoPanel.resumeStreamingBlocked");
      }
      resume.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!resume.disabled) this.onNavigateLeaf(row.entryId);
      });
      el.append(resume);
    }
    return el;
  }

  /** Collapsed inactive branch: summary toggle + (expanded) subtree rows. */
  _renderBranch(branch) {
    const t = this.t;
    const wrap = document.createElement("div");
    wrap.className = "info-panel-branch";
    wrap.dataset.branchId = branch.entryId;

    const expanded = this.expandedBranches.has(branch.entryId);
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "info-panel-branch-summary";
    summary.style.setProperty("--row-depth", String(branch.depth));
    summary.setAttribute("aria-expanded", String(expanded));
    summary.setAttribute(
      "aria-label",
      `${t("infoPanel.branch")} · ${t("infoPanel.turns", { count: branch.turnCount })}`,
    );
    const caret = document.createElement("span");
    caret.className = "info-panel-caret";
    caret.textContent = expanded ? "▾" : "▸";
    caret.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "info-panel-preview";
    text.textContent = `${t("infoPanel.branch")} · ${t("infoPanel.turns", { count: branch.turnCount })}`;
    summary.append(caret, text);
    summary.addEventListener("click", () => {
      if (this.expandedBranches.has(branch.entryId)) {
        this.expandedBranches.delete(branch.entryId);
      } else {
        this.expandedBranches.add(branch.entryId);
      }
      this._renderTree();
    });
    wrap.append(summary);

    if (expanded) {
      const group = document.createElement("div");
      group.className = "info-panel-branch-group";
      group.setAttribute("role", "group");
      for (const row of branch.rows) {
        group.append(row.kind === "branch" ? this._renderBranch(row) : this._nodeRowEl(row));
      }
      wrap.append(group);
    }
    return wrap;
  }

  selectEntry(entryId) {
    this.selectedEntryId = entryId == null ? null : String(entryId);
    const rows = this.treeScroll?.querySelectorAll(".info-panel-row") || [];
    for (const row of rows) {
      row.classList.toggle("selected", row.dataset.entryId === this.selectedEntryId);
    }
  }

  scrollToSelectedEntry() {
    if (!this.selectedEntryId || this.panel.classList.contains("hidden")) {
      this._pendingSelectedScroll = Boolean(this.selectedEntryId);
      return;
    }
    const row = this.treeScroll?.querySelector(
      `[data-entry-id="${escapeAttribute(this.selectedEntryId)}"]`,
    );
    if (!row) {
      this._pendingSelectedScroll = true;
      return;
    }
    this._pendingSelectedScroll = false;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  _scrollToMessage(entryId) {
    this.selectEntry(entryId);
    // Attribute-safe escape (Pi entry ids are generated hex, but stay robust
    // for any id without depending on CSS.escape availability).
    const safeId = escapeAttribute(entryId);
    const target = [...document.querySelectorAll(`[data-entry-id="${safeId}"]`)].find(
      (candidate) => !this.panel.contains(candidate),
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("info-panel-flash");
    target.addEventListener("animationend", () => target.classList.remove("info-panel-flash"), {
      once: true,
    });
  }
}

// Local helpers — kept module-private.

function roleName(t, row) {
  return row.role === "user" ? t("infoPanel.roleUser") : t("infoPanel.roleAssistant");
}

function escapeAttribute(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function previewFallback(t, row) {
  if (row.statusOnly) {
    return row.stopReason === "aborted" ? t("infoPanel.statusAborted") : t("infoPanel.statusError");
  }
  if (row.hasImages) return t("infoPanel.imageMessage");
  return "";
}
