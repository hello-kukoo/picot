// ABOUTME: Lists sessions grouped by project and handles session switching.
// ABOUTME: Coordinates recent, pinned, and live workspace state for the sidebar.

/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

import { onLocaleChange, t } from "../i18n.js";
import { createIcon } from "../icons.js";
import { createPinnedItemsStore } from "../pinned-items.js";
import {
  readRecentSessions,
  recordRecentSession,
  writeRecentSessions,
} from "../recent-sessions.js";
import {
  buildSidebarSection,
  buildSidebarWorkspaceGroup,
  createSectionChevron,
} from "../sidebar-workspace-group.js";
import { getSuperAgentProject, isSuperAgentProjectPath } from "../super-agent/session.js";
import { isSuperAgentEnabled } from "../super-agent/settings.js";
import { basenameLocalPath } from "../workspace/path-utils.js";
import { mergeWorkspaceProjects, resolvePinnedWorkspaceGroups } from "../workspace-projects.js";
import { WorkspaceQuickInfo } from "../workspace-quick-info.js";
import {
  buildSessionItem as buildSessionItemNode,
  formatSessionTime,
  getSessionDisplayTitle,
} from "./build-session-item.js";

function readJsonArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function createActionIcon(kind, options = {}) {
  const size = typeof options === "number" ? options : options.size || 16;
  const iconName = kind === "folder" ? "folder" : kind === "archive" ? "archive" : kind;
  return createIcon(iconName, { size });
}

function appendHighlightedText(container, text, query) {
  const source = String(text || "");
  if (!query) {
    container.textContent = source;
    return;
  }
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "gi");
  let cursor = 0;
  for (const match of source.matchAll(expression)) {
    if (match.index > cursor)
      container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    container.appendChild(mark);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}

export class SessionSidebar {
  constructor(container, onSessionSelect, onNewChat, options = {}) {
    this.projectSessionInitialLimit = 5;
    this.projectSessionStep = 10;
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewChat = onNewChat;
    this.onOpenProject = options.onOpenProject || null;
    this.onSessionNotice = options.onSessionNotice || null;
    this.getLiveInstances = options.getLiveInstances || null;
    this.isFocusActive = options.isFocusActive || null;
    this.onFocusRefresh = options.onFocusRefresh || null;
    this.onWorkspaceFocus = options.onWorkspaceFocus || null;
    this.isCurrentWorkspace = options.isCurrentWorkspace || null;
    this.superAgentPath = options.superAgentPath || "";
    this.activeSessionFile = null;
    this.projects = [];
    // Instance-level fold state. Workspaces default to collapsed (empty set =
    // none expanded); only IDs added here render expanded. Kept in memory only,
    // so a fresh app start always begins with every workspace collapsed while
    // subsequent reloads (refresh button, + new session, pin/unpin) preserve
    // the user's current expand/collapse choices.
    this.expandedWorkspaces = new Set();
    this.pinnedCollapsed = false;
    this.projectsCollapsed = false;
    this.searchQuery = "";
    this.recent = readRecentSessions();
    this.recentCollapsed = false;
    this.archived = readJsonArray("pi-studio-archived");
    // ARCHIVED starts collapsed on every app launch (in-memory, like PINNED /
    // PROJECTS) so a previous session's expand choice does not carry over.
    this.archivedCollapsed = true;
    this.unread = new Set(readJsonArray("pi-studio-unread"));
    this.pinStore = options.pinStore || createPinnedItemsStore();
    this.quickInfo = options.quickInfo || new WorkspaceQuickInfo({ pinStore: this.pinStore });
    this.lastPinnedWorkspaceIds = this.snapshotPinnedWorkspaceIds();
    this.unsubscribePinStore =
      this.pinStore.subscribe?.((next) => {
        // Auto-expand any workspace that was just pinned (regardless of entry
        // point: context menu, quick-info card, or any future caller) without
        // touching the expansion state of existing pinned workspaces.
        const nextIds = new Set(
          (next?.workspaces || []).map((workspace) => workspace?.id).filter(Boolean),
        );
        for (const id of nextIds) {
          if (!this.lastPinnedWorkspaceIds.has(id)) this.expandedWorkspaces.add(id);
        }
        this.lastPinnedWorkspaceIds = nextIds;
        this.render({ preserveQuickInfo: true });
      }) || null;
    this.pinStore.migrateLegacyFavourites?.({ excludedSessions: this.archived });
    this.streamingFiles = new Set();
    this.projectVisibleSessionCounts = new Map();
    this.contextMenu = null;
    // `loadSeq` counts issued loads; `loadCommitted` is the highest seq that has
    // actually rendered. We discard a response only when a *newer* one has
    // already committed (out-of-order arrival), never just because a newer load
    // was issued — an in-flight later load must not starve an earlier fetch that
    // already returned fresh data (e.g. the first response that observes a
    // brand-new session's just-written .jsonl).
    this.loadSeq = 0;
    this.loadCommitted = 0;
    this.loadInvalidatedThrough = 0;

    // Close context menu on click anywhere
    document.addEventListener("click", () => {
      this.closeContextMenu();
    });
    document.addEventListener("contextmenu", (e) => {
      if (!e.target.closest(".workspace-header, .sidebar-context-menu")) this.closeContextMenu();
    });

    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container || this.container.children.length === 0) return;
      if (this.loadSeq > this.loadCommitted) return; // load in-flight
      const savedScroll = this.container.scrollTop;
      this.render();
      this.container.scrollTop = savedScroll;
    });
  }

  saveArchived() {
    localStorage.setItem("pi-studio-archived", JSON.stringify(this.archived));
  }

  saveUnread() {
    localStorage.setItem("pi-studio-unread", JSON.stringify(Array.from(this.unread)));
  }

  isUnread(filePath) {
    return this.unread.has(filePath);
  }

  isStreaming(filePath) {
    return this.streamingFiles.has(filePath);
  }

  markUnread(filePath) {
    if (!filePath) return;
    if (filePath === this.activeSessionFile) return;
    if (this.unread.has(filePath)) return;
    this.unread.add(filePath);
    this.saveUnread();
    this.applyStatusToItem(filePath);
  }

  markRead(filePath) {
    if (!filePath) return;
    if (!this.unread.has(filePath)) return;
    this.unread.delete(filePath);
    this.saveUnread();
    this.applyStatusToItem(filePath);
  }

  setStreaming(filePath, streaming) {
    if (!filePath) return;
    const had = this.streamingFiles.has(filePath);
    if (streaming && !had) {
      this.streamingFiles.add(filePath);
    } else if (!streaming && had) {
      this.streamingFiles.delete(filePath);
    } else {
      return;
    }
    this.applyStatusToItem(filePath);
  }

  clearStreaming() {
    if (this.streamingFiles.size === 0) return;
    const files = Array.from(this.streamingFiles);
    this.streamingFiles.clear();
    files.forEach((f) => {
      this.applyStatusToItem(f);
    });
  }

  applyStatusToItem(filePath) {
    const items = this.container.querySelectorAll(
      `.session-item[data-file-path="${CSS.escape(filePath)}"]`,
    );
    items.forEach((el) => {
      el.classList.toggle("unread", this.unread.has(filePath));
      el.classList.toggle("streaming", this.streamingFiles.has(filePath));
      el.classList.toggle("mirror-live", this.streamingFiles.has(filePath));
    });
  }

  isArchived(filePath) {
    return this.archived.includes(filePath);
  }

  toggleArchived(filePath) {
    const idx = this.archived.indexOf(filePath);
    if (idx >= 0) {
      this.archived.splice(idx, 1);
    } else {
      this.archived.push(filePath);
    }
    this.saveArchived();
    this.render();
  }

  async deleteArchivedSession(filePath) {
    if (!filePath) return;
    const ok = await this.confirmArchivedDeletion(1);
    if (!ok) return;

    try {
      const res = await fetch("/api/sessions/delete-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePaths: [filePath] }),
      });
      const data = await res.json();
      const running = new Set(data.running || []);
      const errors = new Set(data.errors || []);
      if (running.has(filePath)) {
        this.onSessionNotice?.(t("sidebar.deleteSessionRunning"));
        return;
      }
      if (errors.has(filePath)) return;
      this.archived = this.archived.filter((p) => p !== filePath);
      this.saveArchived();
      this.removeFromRecentSessions(filePath);
      this.pinStore.unpinSession(filePath);
    } catch (err) {
      console.error("[Sidebar] deleteArchivedSession failed:", err);
    }

    await this.loadSessions();
  }

  removeFromRecentSessions(filePath) {
    const current = readRecentSessions();
    const next = current.filter((p) => p !== filePath);
    if (next.length !== current.length) writeRecentSessions(next);
  }

  async confirmArchivedDeletion(count) {
    const message =
      count === 1
        ? t("sidebar.deleteArchivedConfirmOne", { count })
        : t("sidebar.deleteArchivedConfirmMany", { count });
    return this.showFallbackConfirmDialog(message);
  }

  showFallbackConfirmDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sidebar-confirm-overlay";
      const dialog = document.createElement("div");
      dialog.className = "sidebar-confirm-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", t("sidebar.deleteArchivedAriaLabel"));
      const messageElement = document.createElement("div");
      messageElement.className = "sidebar-confirm-message";
      messageElement.textContent = message;
      const actions = document.createElement("div");
      actions.className = "sidebar-confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "sidebar-confirm-no";
      cancel.textContent = t("actions.cancel");
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "sidebar-confirm-yes";
      confirm.textContent = t("actions.delete");
      actions.append(cancel, confirm);
      dialog.append(messageElement, actions);
      overlay.appendChild(dialog);

      const cleanup = (result) => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") cleanup(false);
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) cleanup(false);
      });

      overlay.querySelector(".sidebar-confirm-no").addEventListener("click", () => cleanup(false));
      overlay.querySelector(".sidebar-confirm-yes").addEventListener("click", () => cleanup(true));

      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
    });
  }

  async loadSessions({ retries = 4, retryDelayMs = 250, quiet = false } = {}) {
    const seq = ++this.loadSeq;
    if (!quiet) {
      this.container.replaceChildren();
      for (let index = 0; index < 6; index += 1) {
        const skeleton = document.createElement("div");
        skeleton.className = "session-skeleton";
        const title = document.createElement("div");
        title.className = "session-skeleton-title";
        const meta = document.createElement("div");
        meta.className = "session-skeleton-meta";
        skeleton.append(title, meta);
        this.container.appendChild(skeleton);
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const historyProjects = Array.isArray(data.projects) ? data.projects : [];
        let instances = [];
        try {
          const instancesRes = await fetch("/api/instances");
          if (instancesRes.ok) {
            const instancesData = await instancesRes.json();
            instances = Array.isArray(instancesData.instances) ? instancesData.instances : [];
          }
        } catch {
          // History still receives stable workspace IDs when live-instance lookup fails.
        }
        const merged = mergeWorkspaceProjects(historyProjects, instances, this.projects);
        const projects = merged.projects;
        if (seq <= this.loadInvalidatedThrough || seq < this.loadCommitted) return this.projects;
        for (const reconciliation of merged.reconciliations) {
          this.pinStore.reconcileWorkspace?.(reconciliation);
          // A live workspace's provisional `path:` id resolves to its stable
          // `history:` id on this load; carry over any expansion the user
          // already set so it does not snap back to collapsed after render.
          if (this.expandedWorkspaces.delete(reconciliation.fromId)) {
            this.expandedWorkspaces.add(reconciliation.toId);
          }
        }
        this.loadCommitted = seq;
        this.projects = projects;
        this.render();
        return this.projects;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        }
      }
    }

    console.error("[Sidebar] Failed to load sessions:", lastError);
    if (seq <= this.loadInvalidatedThrough || seq < this.loadCommitted) return this.projects;
    const reason = String(lastError?.message || lastError || "").toLowerCase();
    const likelyRuntimeDown =
      reason.includes("failed to fetch") ||
      reason.includes("networkerror") ||
      reason.includes("load failed");
    const message = likelyRuntimeDown
      ? t("sidebar.failedToLoadSessionsRuntime")
      : t("sidebar.failedToLoadSessions");
    this.container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "session-loading";
    loading.textContent = message;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "retry-link";
    retryBtn.id = "retry-load-sessions";
    retryBtn.textContent = t("sidebar.retry");
    retryBtn.addEventListener("click", () => this.loadSessions());
    loading.append(" ", retryBtn);
    this.container.appendChild(loading);
  }

  invalidateSessionLoads() {
    this.loadInvalidatedThrough = Math.max(this.loadInvalidatedThrough, this.loadSeq);
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Clear pending full-text search
    if (this._searchTimer) clearTimeout(this._searchTimer);

    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }

    // Instant: filter titles
    this.applySearch();

    // Debounced: full-text search (300ms)
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.fullTextSearch(this.searchQuery), 300);
    }
  }

  async fullTextSearch(query) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== this.searchQuery) return; // stale

      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      console.error("[Sidebar] Search failed:", err);
    }
  }

  renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;

    // Remove previous search results section
    const existing = this.container.querySelector(".search-results-group");
    if (existing) existing.remove();

    const group = document.createElement("div");
    group.className = "search-results-group";

    const header = document.createElement("div");
    header.className = "project-header search-results-header";
    const searchIcon = document.createElement("span");
    searchIcon.setAttribute("aria-hidden", "true");
    const searchGlyph = createActionIcon("search", 14);
    if (searchGlyph) searchIcon.appendChild(searchGlyph);
    const label = document.createElement("span");
    label.textContent = t("sidebar.messageMatches");
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = String(this._searchResults.length);
    header.append(searchIcon, label, count);
    group.appendChild(header);

    const sessionsDiv = document.createElement("div");
    sessionsDiv.className = "project-sessions";

    for (const result of this._searchResults) {
      const item = document.createElement("div");
      item.className = "session-item search-result-item";
      item.dataset.filePath = result.filePath;
      item.dataset.name = String(result.sessionName || "").toLowerCase();
      item.dataset.firstMessage = String(result.firstMessage || "").toLowerCase();

      if (result.filePath === this.activeSessionFile) {
        item.classList.add("active");
      }

      const title = getSessionDisplayTitle({
        name: result.sessionName,
        firstMessage: result.firstMessage,
      });
      const snippet = result.matches[0]?.snippet || "";
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";
      const titleElement = document.createElement("div");
      titleElement.className = "session-title";
      titleElement.title = title;
      titleElement.textContent = title;
      titleRow.appendChild(titleElement);
      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "session-rename-btn";
      renameButton.title = t("sidebar.rename");
      renameButton.setAttribute("aria-label", t("sidebar.renameSessionAriaLabel"));
      const renameIcon = createActionIcon("pencil", 13);
      if (renameIcon) renameButton.appendChild(renameIcon);
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.startRename(item, {
          filePath: result.filePath,
          name: result.sessionName || "",
          firstMessage: result.firstMessage || "",
        });
      });
      titleRow.appendChild(renameButton);
      const snippetElement = document.createElement("div");
      snippetElement.className = "search-snippet";
      appendHighlightedText(snippetElement, snippet, this.searchQuery);
      const meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = time;
      if (matchCount > 1) meta.append(` · ${t("sidebar.matchCount", { count: matchCount })}`);
      item.append(titleRow, snippetElement, meta);

      // Find the matching project/session to pass to onSessionSelect
      item.addEventListener("contextmenu", (event) => {
        this.showSessionContextMenu(event, item, {
          filePath: result.filePath,
          name: result.sessionName || "",
          firstMessage: result.firstMessage || "",
        });
      });
      item.addEventListener("click", () => {
        for (const project of this.projects) {
          const session = project.sessions.find((s) => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list (unlikely) — try switching by path
        this.onSessionSelect(
          { filePath: result.filePath, name: result.sessionName },
          { path: result.project },
        );
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
  }

  highlightMatch(text, query) {
    const fragment = document.createDocumentFragment();
    appendHighlightedText(fragment, text, query);
    return fragment;
  }
  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll(".session-item").forEach((el) => {
        el.classList.remove("hidden");
      });
      this.container
        .querySelectorAll(".project-group, .pinned-group, .archived-group, .recent-group")
        .forEach((el) => {
          el.style.display = "";
        });
      const searchGroup = this.container.querySelector(".search-results-group");
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search RECENT section
    const recentSection = this.container.querySelector(".recent-group");
    if (recentSection) {
      let hasVisible = false;
      recentSection.querySelectorAll(".session-item").forEach((item) => {
        const matches = this.sessionItemMatchesSearch(item);
        item.classList.toggle("hidden", !matches);
        if (matches) hasVisible = true;
      });
      recentSection.style.display = hasVisible ? "" : "none";
    }

    this.container.querySelectorAll(".project-group, .archived-group").forEach((group) => {
      let hasVisible = false;
      const projectMatches = (group.dataset.projectSearchText || "").includes(this.searchQuery);
      group.querySelectorAll(".session-item").forEach((item) => {
        const matches = projectMatches || this.sessionItemMatchesSearch(item);
        item.classList.toggle("hidden", !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? "" : "none";
    });
  }

  sessionItemMatchesSearch(item) {
    const searchable = [
      item.dataset.name || "",
      item.dataset.firstMessage || "",
      item.dataset.projectSearchText || "",
    ];
    return searchable.some((value) => value.includes(this.searchQuery));
  }

  resolveRecentSessions() {
    const sessionsByPath = new Map();
    for (const project of this.projects) {
      for (const session of project.sessions) {
        if (!this.isArchived(session.filePath)) {
          sessionsByPath.set(session.filePath, { session, project });
        }
      }
    }

    const resolved = this.recent.map((filePath) => sessionsByPath.get(filePath)).filter(Boolean);
    const validPaths = resolved.map(({ session }) => session.filePath);
    if (JSON.stringify(validPaths) !== JSON.stringify(this.recent)) {
      this.recent = writeRecentSessions(validPaths);
    }
    return resolved;
  }

  recordRecent(filePath) {
    const next = recordRecentSession(filePath);
    const changed = JSON.stringify(next) !== JSON.stringify(this.recent);
    this.recent = next;
    return changed;
  }
  setActive(filePath) {
    this.activeSessionFile = filePath;
    if (filePath && this.unread.has(filePath)) {
      this.unread.delete(filePath);
      this.saveUnread();
    }
    this.container.querySelectorAll(".session-item").forEach((el) => {
      const isActive = el.dataset.filePath === filePath;
      el.classList.toggle("active", isActive);
      if (isActive) {
        el.classList.remove("unread");
      }
    });

    if (this.recordRecent(filePath) && this.projects.length > 0) {
      this.render();
    }
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll(".session-item").forEach((el) => {
      el.classList.remove("active");
    });
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showWorkspaceContextMenu(event, workspace) {
    event.preventDefault();
    this.closeContextMenu();

    const isPinned = this.pinStore.isWorkspacePinned(workspace.workspaceId);
    const items = [
      {
        iconKind: "pin",
        label: isPinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace"),
        action: () => {
          this.quickInfo.close();
          if (isPinned) this.pinStore.unpinWorkspace(workspace.workspaceId);
          else this.pinStore.pinWorkspace(workspace.workspaceId, workspace.path);
        },
      },
      {
        iconKind: "folder",
        label: t("sidebar.openInFinder"),
        action: () => this.onOpenProject?.(workspace),
      },
      {
        iconKind: "archive",
        label: t("sidebar.archiveWorkspaceSessions"),
        action: () => this.archiveWorkspaceSessions(workspace),
      },
    ];

    const menu = document.createElement("div");
    menu.className = "sidebar-context-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "context-menu-item";
      row.setAttribute("role", "menuitem");

      const icon = document.createElement("span");
      icon.className = `context-menu-icon${item.iconClass ? ` ${item.iconClass}` : ""}`;
      icon.setAttribute("aria-hidden", "true");
      if (item.iconKind) {
        const iconNode = createActionIcon(item.iconKind);
        if (iconNode) icon.appendChild(iconNode);
      }
      const label = document.createElement("span");
      label.textContent = item.label;
      row.append(icon, label);
      row.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.contextMenu = menu;
  }

  archiveDisabledReason(filePath) {
    if (filePath === this.activeSessionFile) return t("sidebar.archiveDisabledActive");
    if (this.streamingFiles.has(filePath)) return t("sidebar.archiveDisabledStreaming");
    if (this.isLiveSession(filePath)) return t("sidebar.archiveDisabledRunning");
    return null;
  }

  isLiveSession(filePath) {
    if (typeof this.getLiveInstances !== "function") return false;
    const live = this.getLiveInstances();
    return Array.isArray(live) && live.some((instance) => instance?.sessionFile === filePath);
  }

  archiveWorkspaceSessions(workspace) {
    const filePaths = (workspace?.sessions || [])
      .map((session) => session?.filePath)
      .filter(
        (filePath) =>
          typeof filePath === "string" &&
          filePath &&
          !this.isArchived(filePath) &&
          this.archiveDisabledReason(filePath) === null,
      );
    if (filePaths.length === 0) return;
    this.archived.push(...filePaths);
    this.saveArchived();
    this.render();
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  showSessionContextMenu(event, itemEl, session) {
    event?.preventDefault();
    this.closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "sidebar-context-menu";
    menu.setAttribute("role", "menu");
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "context-menu-item";
    rename.setAttribute("role", "menuitem");
    rename.textContent = t("sidebar.rename");
    rename.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      this.closeContextMenu();
      this.startRename(itemEl, session);
    });
    menu.appendChild(rename);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const anchor = event || itemEl.getBoundingClientRect();
    const clientX = event ? event.clientX : anchor.left;
    const clientY = event ? event.clientY : anchor.bottom;
    const x = Math.min(clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    this.contextMenu = menu;
  }

  renameSession(filePath, session, itemEl) {
    const targetItem =
      itemEl ||
      Array.from(this.container.querySelectorAll(".session-item")).find(
        (item) => item.dataset.filePath === filePath,
      );
    if (targetItem) this.startRename(targetItem, { ...session, filePath });
  }

  startRename(itemEl, session = null) {
    const titleEl = itemEl.querySelector(".session-title");
    if (!titleEl || itemEl.querySelector(".session-rename-input")) return;
    const target = session ||
      this.projects
        .flatMap((project) => project.sessions || [])
        .find((candidate) => candidate.filePath === itemEl.dataset.filePath) || {
        filePath: itemEl.dataset.filePath,
        name: itemEl.dataset.name || "",
        firstMessage: itemEl.dataset.firstMessage || "",
      };
    const currentName = target.name || "";
    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.value = currentName;
    input.placeholder = target.firstMessage || t("sidebar.renameInputPlaceholder");
    input.setAttribute("aria-label", t("sidebar.renameSessionAriaLabel"));
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    let submitting = false;
    const showError = (message) => {
      let error = itemEl.querySelector(".session-rename-error");
      if (!error) {
        error = document.createElement("div");
        error.className = "session-rename-error";
        input.parentElement?.appendChild(error);
      }
      error.textContent = message;
    };
    const restore = () => {
      if (finished) return;
      finished = true;
      const replacement = document.createElement("div");
      replacement.className = "session-title";
      replacement.title = getSessionDisplayTitle(target);
      replacement.textContent = getSessionDisplayTitle(target);
      input.replaceWith(replacement);
      itemEl.querySelector(".session-rename-error")?.remove();
    };
    let canRetry = false;
    const commit = async () => {
      if (submitting || finished) return;
      const newName = input.value.trim();
      if (!newName) {
        showError(t("sidebar.renameErrorInvalid"));
        input.focus();
        return;
      }
      if (newName === currentName) {
        restore();
        return;
      }
      submitting = true;
      input.disabled = true;
      input.classList.add("busy");
      try {
        const response = await fetch("/api/sessions/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: target.filePath, name: newName }),
        });
        if (!response.ok) {
          canRetry = response.status === 500;
          const key =
            response.status === 400
              ? "sidebar.renameErrorInvalid"
              : response.status === 404
                ? "sidebar.renameErrorNotFound"
                : response.status === 413
                  ? "sidebar.renameErrorTooLarge"
                  : "sidebar.renameErrorServer";
          throw new Error(t(key));
        }
        this.invalidateSessionLoads();
        target.name = newName;
        for (const project of this.projects) {
          for (const candidate of project.sessions || []) {
            if (candidate.filePath === target.filePath) candidate.name = newName;
          }
        }
        this.container.querySelectorAll(".session-item").forEach((row) => {
          if (row.dataset.filePath !== target.filePath) return;
          row.dataset.name = newName.toLowerCase();
          const title = row.querySelector(".session-title");
          if (title) {
            title.textContent = newName;
            title.title = newName;
          }
        });
        restore();
        await this.loadSessions({ quiet: true });
      } catch (error) {
        submitting = false;
        input.disabled = false;
        input.classList.remove("busy");
        const message = error instanceof Error ? error.message : t("sidebar.renameErrorServer");
        showError(message);
        if (
          canRetry &&
          !itemEl.querySelector(".session-rename-retry") &&
          input.disabled === false
        ) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "session-rename-retry";
          retry.textContent = t("sidebar.renameRetry");
          const keepEditorFocused = (event) => event.preventDefault();
          retry.addEventListener("pointerdown", keepEditorFocused);
          retry.addEventListener("mousedown", keepEditorFocused);
          retry.addEventListener("click", () => commit());
          itemEl.querySelector(".session-rename-error")?.append(" ", retry);
        }
        input.focus();
      }
    };
    input.addEventListener("blur", () => {
      if (!submitting) restore();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        restore();
      }
    });
  }

  async exportSession(_session) {
    try {
      const data = await (
        await fetch("/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "export_html" }),
        })
      ).json();
      if (data?.success && data.data?.path) {
        const downloadUrl = `/api/sessions/${encodeURIComponent(data.data.path)}`;
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = "";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch {
      /* silent */
    }
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session, project, options = {}) {
    const {
      showArchiveButton = true,
      showPinButton = true,
      showDeleteButton = false,
      archiveDisabledReason = null,
      onDelete = null,
    } = options;
    return buildSessionItemNode({
      session,
      project,
      isActive: session.filePath === this.activeSessionFile,
      isUnread: this.unread.has(session.filePath),
      isStreaming: this.streamingFiles.has(session.filePath),
      isArchived: this.isArchived(session.filePath),
      isPinned: this.pinStore.isSessionPinned(session.filePath),
      showPinButton,
      showArchiveButton,
      showDeleteButton,
      archiveDisabledReason: showArchiveButton
        ? (archiveDisabledReason ?? this.archiveDisabledReason(session.filePath))
        : null,
      projectSearchText: this.getProjectSearchText(project),
      formattedTime: this.formatTime(session.timestamp),
      onSelect: this.onSessionSelect ? (s, p) => this.onSessionSelect(s, p) : null,
      onPinToggle: (filePath) => {
        if (this.pinStore.isSessionPinned(filePath)) this.pinStore.unpinSession(filePath);
        else this.pinStore.pinSession(filePath);
      },
      onArchiveToggle: (filePath) => this.toggleArchived(filePath),
      onDelete,
      onRename: (filePath, session, item) => this.renameSession(filePath, session, item),
      onContextMenu: (event, item, session) => this.showSessionContextMenu(event, item, session),
      createIcon: createActionIcon,
    });
  }

  /**
   * Pins the latest Super Agent session at the top of the sidebar as the
   * "Agent Inbox" entry. Only the most recent session is shown; the rest of
   * the Super Agent project's history stays out of the regular project list.
   */
  buildPinnedSuperAgentGroup(pinned) {
    if (!pinned) return null;

    const group = document.createElement("div");
    group.className = "super-agent-pinned-group";
    group.dataset.projectSearchText = this.getProjectSearchText(pinned.project);

    const header = document.createElement("div");
    header.className = "project-header super-agent-pinned-header";
    const star = document.createElement("span");
    star.className = "fav-star";
    const starIcon = createActionIcon("pin", 14);
    if (starIcon) star.appendChild(starIcon);
    const title = document.createElement("span");
    title.textContent = "Agent Inbox";
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = "Pinned";
    header.append(star, title, count);
    group.appendChild(header);

    const sessionsDiv = document.createElement("div");
    sessionsDiv.className = "project-sessions";
    sessionsDiv.appendChild(
      this.buildSessionItem(pinned.session, pinned.project, {
        showArchiveButton: false,
      }),
    );
    group.appendChild(sessionsDiv);

    return group;
  }

  getProjectVisibilityKey(project) {
    return project?.path || project?.dirName || "";
  }

  // Snapshot of pinned workspace IDs, used to detect newly-pinned workspaces
  // across pin-store notifications. Falls back to getRenderableState for stubs
  // (and the legacy test pin store) that do not expose getState.
  snapshotPinnedWorkspaceIds() {
    const state = (typeof this.pinStore.getState === "function" && this.pinStore.getState()) ||
      this.pinStore.getRenderableState?.() || { workspaces: [], sessions: [] };
    return new Set((state.workspaces || []).map((workspace) => workspace?.id).filter(Boolean));
  }

  // Stable expansion key for a workspace record. Prefers the canonical
  // workspaceId; falls back to the path/dirName visibility key so test
  // fixtures and live-only workspaces without an id still track distinctly.
  getWorkspaceExpansionKey(workspace) {
    return workspace?.workspaceId || this.getProjectVisibilityKey(workspace) || "";
  }

  isWorkspaceExpanded(workspace) {
    const key = this.getWorkspaceExpansionKey(workspace);
    return Boolean(key) && this.expandedWorkspaces.has(key);
  }

  setWorkspaceExpanded(workspace, expanded) {
    const key = this.getWorkspaceExpansionKey(workspace);
    if (!key) return;
    if (expanded) this.expandedWorkspaces.add(key);
    else this.expandedWorkspaces.delete(key);
  }

  getProjectVisibleSessionCount(project, sessionCount) {
    const key = this.getProjectVisibilityKey(project);
    const stored = this.projectVisibleSessionCounts.get(key);
    if (typeof stored === "number" && Number.isFinite(stored)) {
      return Math.max(this.projectSessionInitialLimit, Math.min(sessionCount, Math.floor(stored)));
    }
    return Math.min(sessionCount, this.projectSessionInitialLimit);
  }

  setProjectVisibleSessionCount(project, sessionCount) {
    const key = this.getProjectVisibilityKey(project);
    if (!key) return;
    this.projectVisibleSessionCounts.set(
      key,
      Math.max(this.projectSessionInitialLimit, sessionCount),
    );
  }

  buildProjectSessionsToggleRow(project, visibleCount, totalCount) {
    const hasMore = visibleCount < totalCount;
    const canShowLess = visibleCount > this.projectSessionInitialLimit;
    if (!hasMore && !canShowLess) return null;

    const toggleRow = document.createElement("div");
    toggleRow.className = "project-sessions-toggle-row";

    if (hasMore) {
      const showMoreButton = document.createElement("button");
      showMoreButton.type = "button";
      showMoreButton.className = "project-sessions-toggle";
      showMoreButton.textContent = t("sidebar.showMore");
      showMoreButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProjectVisibleSessionCount(project, visibleCount + this.projectSessionStep);
        this.render();
      });
      toggleRow.appendChild(showMoreButton);
    }

    if (canShowLess) {
      const showLessButton = document.createElement("button");
      showLessButton.type = "button";
      showLessButton.className = "project-sessions-toggle project-sessions-toggle-less";
      showLessButton.textContent = t("sidebar.showLess");
      showLessButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProjectVisibleSessionCount(
          project,
          Math.max(this.projectSessionInitialLimit, visibleCount - this.projectSessionStep),
        );
        this.render();
      });
      toggleRow.appendChild(showLessButton);
    }

    return toggleRow;
  }
  renderPinnedSection() {
    const state = this.pinStore.getRenderableState();
    const pinnedGroups = resolvePinnedWorkspaceGroups({
      pinState: state,
      projects: this.projects,
      archivedPaths: this.archived,
    });
    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      count: pinnedGroups.length,
      expanded: !this.pinnedCollapsed,
      onToggle: (expanded) => {
        this.pinnedCollapsed = !expanded;
      },
      renderSessions: (body) => {
        for (const pinned of pinnedGroups) {
          const workspace = pinned.workspace;
          const unavailableFilePath = pinned.sessions[0]?.filePath || "";
          const workspacePath = workspace?.path || "";
          const folderName =
            workspace?.folderName ||
            basenameLocalPath(workspacePath) ||
            unavailableFilePath ||
            t("sidebar.unavailable");
          const workspaceId = workspace?.workspaceId || `pinned-session:${unavailableFilePath}`;
          const expansionWorkspace = { workspaceId };
          const pinnedActive =
            !pinned.unavailable &&
            Array.isArray(pinned.sessions) &&
            pinned.sessions.some((s) => s?.filePath === this.activeSessionFile);
          const pinnedCurrent = !pinned.unavailable && this.isCurrentWorkspace?.(workspace);
          const { group, header } = buildSidebarWorkspaceGroup({
            workspaceId,
            folderName,
            workspacePath,
            sessionCount: pinned.sessions.length,
            expanded: this.isWorkspaceExpanded(expansionWorkspace),
            onToggle: (expanded) => this.setWorkspaceExpanded(expansionWorkspace, expanded),
            onNewChat: !pinned.unavailable && workspace ? () => this.onNewChat(workspace) : null,
            onContextMenu:
              !pinned.unavailable && workspace
                ? (event) => this.showWorkspaceContextMenu(event, workspace)
                : null,
            onMoreActions:
              !pinned.unavailable && workspace
                ? (event) => this.showWorkspaceContextMenu(event, workspace)
                : null,
            focusEnabled: (pinnedActive || pinnedCurrent) && !!this.onWorkspaceFocus,
            onFocus:
              pinnedActive || pinnedCurrent ? () => this.onWorkspaceFocus?.(workspace) : null,
            renderSessions: (container) => {
              if (pinned.unavailable) {
                const unavailable = document.createElement("div");
                unavailable.className = "pinned-unavailable";
                unavailable.textContent =
                  workspacePath || unavailableFilePath || t("sidebar.unavailable");
                container.appendChild(unavailable);

                const unpin = document.createElement("button");
                unpin.type = "button";
                unpin.textContent = pinned.workspacePin
                  ? t("sidebar.unpinWorkspace")
                  : t("sidebar.unpinSession");
                unpin.addEventListener("click", () => {
                  if (pinned.workspacePin) this.pinStore.unpinWorkspace(workspace.workspaceId);
                  else this.pinStore.unpinSession(unavailableFilePath);
                });
                container.appendChild(unpin);
                return;
              }

              const pinnedSessions = pinned.sessions;
              const pinnedVisibleCount = this.getProjectVisibleSessionCount(
                workspace,
                pinnedSessions.length,
              );
              const pinnedToRender = pinnedSessions.slice(0, pinnedVisibleCount);
              for (const session of pinnedToRender) {
                container.appendChild(this.buildSessionItem(session, workspace));
              }
              const pinnedToggle = this.buildProjectSessionsToggleRow(
                workspace,
                pinnedToRender.length,
                pinnedSessions.length,
              );
              if (pinnedToggle) container.appendChild(pinnedToggle);
            },
          });
          group.classList.add("pinned-workspace-group");

          if (!pinned.unavailable && workspace) this.quickInfo.bindHeader(header, workspace);

          body.appendChild(group);
        }
      },
    });
    section.className = `pinned-group ${section.className}`;
    this.container.appendChild(section);
  }

  render({ preserveQuickInfo = false } = {}) {
    // While Focus mode owns the sidebar, delegate any render request to the
    // focus view instead of rebuilding the normal session list. This keeps
    // loadSessions()/setActive() refreshes from clobbering the focus view.
    if (this.isFocusActive?.() && typeof this.onFocusRefresh === "function") {
      this.onFocusRefresh();
      return;
    }
    const recentSessions = this.resolveRecentSessions();

    const pinnedSuperAgent = isSuperAgentEnabled()
      ? getSuperAgentProject(this.projects, this.superAgentPath)
      : null;
    const pinnedSessionFile = pinnedSuperAgent?.session?.filePath || null;

    this.container.replaceChildren();
    this.quickInfo.clearHeaders({ preserveCard: preserveQuickInfo });
    this.quickInfo.setWorkspaces(this.projects);

    const pinnedSuperAgentGroup = this.buildPinnedSuperAgentGroup(pinnedSuperAgent);
    if (pinnedSuperAgentGroup) {
      this.container.appendChild(pinnedSuperAgentGroup);
    }

    const archivedSessions = [];
    for (const project of this.projects) {
      const isSuperAgentProject = isSuperAgentProjectPath(project.path, this.superAgentPath);
      for (const session of project.sessions || []) {
        if (session.filePath === pinnedSessionFile || isSuperAgentProject) continue;
        if (this.isArchived(session.filePath)) archivedSessions.push({ session, project });
      }
    }

    if (recentSessions.length > 0) {
      const recentGroup = document.createElement("div");
      recentGroup.className = "recent-group";

      const header = document.createElement("div");
      header.className = `project-header recent-header sidebar-section-header${
        this.recentCollapsed ? " collapsed" : ""
      }`;
      header.setAttribute("role", "button");
      header.tabIndex = 0;
      header.setAttribute("aria-expanded", String(!this.recentCollapsed));
      header.appendChild(createSectionChevron());
      const label = document.createElement("span");
      label.className = "sidebar-section-title";
      label.textContent = t("sidebar.recent");
      header.appendChild(label);
      recentGroup.appendChild(header);

      const sessionsDiv = document.createElement("div");
      sessionsDiv.className = `project-sessions${this.recentCollapsed ? " collapsed" : ""}`;
      for (const { session, project } of recentSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      const toggleRecent = () => {
        this.recentCollapsed = !this.recentCollapsed;
        header.classList.toggle("collapsed", this.recentCollapsed);
        header.setAttribute("aria-expanded", String(!this.recentCollapsed));
        sessionsDiv.classList.toggle("collapsed", this.recentCollapsed);
      };
      header.addEventListener("click", toggleRecent);
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleRecent();
      });

      recentGroup.appendChild(sessionsDiv);
      this.container.appendChild(recentGroup);
    }
    this.renderPinnedSection();

    const { section: projectsSection, sessionsContainer: projectsGroup } = buildSidebarSection({
      region: "projects",
      titleKey: "sidebar.projects",
      count: this.projects.length,
      expanded: !this.projectsCollapsed,
      onToggle: (expanded) => {
        this.projectsCollapsed = !expanded;
      },
    });
    projectsSection.className = `projects-group ${projectsSection.className}`;
    for (const project of this.projects) {
      if (isSuperAgentProjectPath(project.path, this.superAgentPath)) continue;
      const visibleSessions = (project.sessions || []).filter(
        (session) => session.filePath !== pinnedSessionFile && !this.isArchived(session.filePath),
      );
      const visibleCount = this.getProjectVisibleSessionCount(project, visibleSessions.length);
      const sessionsToRender = this.searchQuery
        ? visibleSessions
        : visibleSessions.slice(0, visibleCount);
      const projectActive = Array.isArray(project.sessions)
        ? project.sessions.some((s) => s?.filePath === this.activeSessionFile)
        : false;
      const { group, header } = buildSidebarWorkspaceGroup({
        workspaceId: project.workspaceId,
        folderName:
          project.folderName ||
          basenameLocalPath(project.path) ||
          project.path ||
          t("sidebar.unavailable"),
        workspacePath: project.path,
        sessionCount: visibleSessions.length,
        expanded: this.isWorkspaceExpanded(project),
        onToggle: (expanded) => this.setWorkspaceExpanded(project, expanded),
        onNewChat: this.onNewChat ? () => this.onNewChat(project) : null,
        onContextMenu: (event) => this.showWorkspaceContextMenu(event, project),
        onMoreActions: (event) => this.showWorkspaceContextMenu(event, project),
        focusEnabled:
          (projectActive || this.isCurrentWorkspace?.(project)) && !!this.onWorkspaceFocus,
        onFocus:
          projectActive || this.isCurrentWorkspace?.(project)
            ? () => this.onWorkspaceFocus?.(project)
            : null,
        renderSessions: (sessionsDiv) => {
          for (const session of sessionsToRender) {
            sessionsDiv.appendChild(this.buildSessionItem(session, project));
          }
          if (!this.searchQuery) {
            const toggleRow = this.buildProjectSessionsToggleRow(
              project,
              sessionsToRender.length,
              visibleSessions.length,
            );
            if (toggleRow) sessionsDiv.appendChild(toggleRow);
          }
        },
      });
      group.dataset.projectSearchText = this.getProjectSearchText(project);
      projectsGroup.appendChild(group);
      this.quickInfo.bindHeader(header, project);
    }
    this.container.appendChild(projectsSection);

    {
      archivedSessions.sort((a, b) => {
        const aCreated = a.session.timestamp
          ? new Date(a.session.timestamp).getTime()
          : a.session.ctime || 0;
        const bCreated = b.session.timestamp
          ? new Date(b.session.timestamp).getTime()
          : b.session.ctime || 0;
        return bCreated - aCreated;
      });
      const archivedGroup = document.createElement("div");
      archivedGroup.className = "archived-group";

      const header = document.createElement("div");
      header.className = `project-header archived-header sidebar-section-header${
        this.archivedCollapsed ? " collapsed" : ""
      }`;
      header.setAttribute("role", "button");
      header.tabIndex = 0;
      header.setAttribute("aria-expanded", String(!this.archivedCollapsed));
      header.appendChild(createSectionChevron());
      const archivedLabel = document.createElement("span");
      archivedLabel.className = "sidebar-section-title";
      archivedLabel.textContent = t("sidebar.archived");
      const archivedCount = document.createElement("span");
      archivedCount.className = "project-count sidebar-section-count";
      archivedCount.textContent = String(archivedSessions.length);
      header.append(archivedLabel, archivedCount);
      archivedGroup.appendChild(header);

      const sessionsDiv = document.createElement("div");
      sessionsDiv.className = `project-sessions${this.archivedCollapsed ? " collapsed" : ""}`;
      for (const { session, project } of archivedSessions) {
        sessionsDiv.appendChild(
          this.buildSessionItem(session, project, {
            showPinButton: false,
            showArchiveButton: false,
            showDeleteButton: true,
            onDelete: (filePath) => this.deleteArchivedSession(filePath),
          }),
        );
      }

      const toggleArchived = () => {
        this.archivedCollapsed = !this.archivedCollapsed;
        header.classList.toggle("collapsed", this.archivedCollapsed);
        header.setAttribute("aria-expanded", String(!this.archivedCollapsed));
        sessionsDiv.classList.toggle("collapsed", this.archivedCollapsed);
      };
      header.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        toggleArchived();
      });
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleArchived();
      });

      archivedGroup.appendChild(sessionsDiv);
      this.container.appendChild(archivedGroup);
    }

    const nonSuperAgentProjects = this.projects.filter(
      (project) => !isSuperAgentProjectPath(project.path, this.superAgentPath),
    );
    const pinState = this.pinStore.getRenderableState();
    if (
      !pinnedSuperAgent &&
      nonSuperAgentProjects.length === 0 &&
      recentSessions.length === 0 &&
      archivedSessions.length === 0 &&
      pinState.workspaces.length === 0 &&
      pinState.sessions.length === 0
    ) {
      this.renderEmptyState({ append: true });
    }

    if (this.searchQuery) this.applySearch();
  }

  renderEmptyState({ append = false } = {}) {
    const empty = document.createElement("div");
    empty.className = "session-empty-state";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-empty-open-project";
    openButton.title = t("sidebar.openProject");
    openButton.setAttribute("aria-label", t("sidebar.openProject"));
    openButton.textContent = t("sidebar.openProject");
    openButton.addEventListener("click", () => this.onOpenProject?.());
    empty.appendChild(openButton);
    if (append) this.container.appendChild(empty);
    else this.container.replaceChildren(empty);
  }

  getProjectSearchText(project) {
    const path = typeof project?.path === "string" ? project.path : "";
    const dirName = typeof project?.dirName === "string" ? project.dirName : "";
    const shortPath = basenameLocalPath(path) || path;
    return [shortPath, dirName, path].join(" ").toLowerCase();
  }

  formatTime(isoTimestamp) {
    return formatSessionTime(isoTimestamp);
  }
}
