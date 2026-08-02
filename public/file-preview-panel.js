// ABOUTME: Coordinates file preview tabs, transient chat tabs, and panel layout.
// ABOUTME: Owns dirty-buffer settlement, renderer lifecycle, and tab interactions.

/**
 * File Preview Panel — orchestrator module.
 *
 * Owns panel lifecycle, tab bar rendering, active-tab selection, panel
 * enlarge/collapse, splitter behavior, dirty/save/auto-save/conflict flows,
 * floating toolbar, and renderer mounting. Does NOT own directory listing,
 * Markdown parsing, or CodeMirror configuration.
 */

import { classifyFilePath } from "./file-language.js";
import { createFileRenderer } from "./file-preview-renderers.js";
import { FileTabState } from "./file-tab-state.js";
import { createFileTypeIcon } from "./file-type-icons.js";
import { createGitDiffRenderer } from "./git-diff-renderer.js";
import { onLocaleChange, t } from "./i18n.js";
import { createIcon, setButtonIcon } from "./icons.js";
import { normalizeLocalPath, relativeLocalPath } from "./workspace/path-utils.js";

const AUTO_SAVE_DELAY = 1500;
const DEFAULT_PANEL_RATIO = 0.42;
const MIN_PANEL_WIDTH = 320;

function appendCloseIcon(button) {
  setButtonIcon(button, "x", { size: 10 });
}

function appendTabBarActionIcon(button, icon) {
  if (icon === "chat-plus") button.appendChild(createIcon("message-square-plus", { size: 14 }));
}

export class FilePreviewPanel {
  constructor({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    onOpenDesktop,
    onCopyText,
    onStateChange,
    confirmDirty,
    resolveConflict,
    storage,
  } = {}) {
    this.panel = panel;
    this.resizer = resizer;
    this.tabBar = tabBar;
    this.content = content;
    this.mainContainer = mainContainer;
    // The content region is the single tabpanel for every tab strip tab. It
    // swaps which content is visible on activation rather than rendering one
    // panel per tab, so the panel role + label live here permanently.
    if (this.content) {
      this.content.setAttribute("role", "tabpanel");
      if (!this.content.id) this.content.id = "file-preview-tabpanel";
      this.content.setAttribute("aria-label", t("files.preview.tabpanelLabel"));
    }
    this.onOpenDesktop = onOpenDesktop || (() => {});
    this.onCopyText = onCopyText || ((text) => navigator.clipboard?.writeText(text));
    this.onStateChange = onStateChange || (() => {});
    this.confirmDirty = confirmDirty || ((tabs, reason) => this._showDirtyDialog(tabs, reason));
    this.resolveConflict = resolveConflict || ((tab) => this._showConflictDialog(tab));

    if (storage !== undefined) {
      this.storage = storage;
    } else {
      try {
        this.storage = globalThis.window?.localStorage ?? null;
      } catch {
        this.storage = null;
      }
    }
    this.state = new FileTabState({ storage: this.storage });
    this.currentRenderer = null;
    this.workspaceRoot = "";
    this.loadTokens = new Map();
    this.loadAbortControllers = new Map();
    this.savePromises = new Map();
    this.autoSaveTimers = new Map();
    this.autoSaveEnabled = true;
    this.wrapLines = false;
    this.panelOpen = false;
    this.enlarged = false;
    this.panelRatio = DEFAULT_PANEL_RATIO;
    this.toolbarOpen = false;
    this.goToLineInputOpen = false;
    this.transientStatus = "";
    this.cleanupListeners = [];
    this.activeDialogCancel = null;
    // Transient (non-file) content tabs — Side Chats — projected into the same
    // tab strip as file tabs but never persisted to FileTabState.
    this.transientTabs = new Map();
    this.diffTabs = new Map();
    // Discriminated active content: { kind: "file" | "transient", id } | null.
    this.activeContent = null;
    // Tab-bar actions (e.g. "New Side Chat") registered by an external manager.
    this.tabBarActions = new Map();
    this._interactionLocked = false;
    this._riskVersion = 0;

    this._restorePreferences();
    this._setupListeners();
    this._setupResizer();
    this._setupControls();
    this._unsubscribeLocale = onLocaleChange(() => {
      this._renderTabBar();
      this._renderToolbar();
    });
  }

  async setWorkspaceRoot(root) {
    const normalized = normalizeLocalPath(root) || "/";
    if (normalized === this.workspaceRoot) return true;

    this._captureActiveRenderer();
    const dirtyTabs = this.state.getTabs().filter((tab) => tab.dirty);
    if (dirtyTabs.length > 0) {
      const settled = await this._settleDirtyTabs(dirtyTabs, "workspace");
      if (!settled) return false;
    }

    this._abortAllTabLoads();
    this._destroyRenderer();
    this.diffTabs.clear();
    this.workspaceRoot = normalized;
    this.state.load(normalized);
    this._renderTabBar();
    this._renderToolbar();

    if (this.state.getTabs().length === 0) {
      this.activeContent = null;
      this._closePanel();
      return true;
    }

    const activeTab = this.state.getActiveTab();
    this.activeContent = activeTab ? { kind: "file", id: activeTab.id } : null;
    // Defer opening the panel until the restored tab's content loads. During
    // a foreground workspace switch the persisted tabs can belong to a
    // workspace the current server is not scoped to, so the content fetch
    // returns 403; opening first would flash the panel open with a load
    // error before the authoritative state closes it again. Only open on a
    // successful load that is still the current workspace.
    if (activeTab) {
      const loaded = await this._loadTabContent(activeTab);
      if (loaded && this.workspaceRoot === normalized) {
        this._openPanel();
      } else if (this.workspaceRoot === normalized) {
        this.activeContent = null;
      }
    }
    return true;
  }

  async openFile(filePath, metadata = {}) {
    const normalizedPath = normalizeLocalPath(filePath);
    const existing = this.state.getTabs().find((tab) => tab.filePath === normalizedPath);
    const currentTab = this.state.getActiveTab();
    if (this.activeContent?.kind === "transient") this._deactivateCurrent();

    if (existing) {
      if (currentTab?.id !== existing.id) {
        if (this._isConversionTab(currentTab)) this._abortTabLoad(currentTab?.id);
        this._captureActiveRenderer();
        this.state.selectTab(existing.id);
        if (existing.content === null && existing.loading) {
          this._abortTabLoad(existing.id);
          this.state.updateTab(existing.id, { loading: false, error: null, errorDetail: null });
        }
      }
      this._openPanel();
      this._renderTabBar();
      const freshExisting = this.state.getTab(existing.id);
      if (freshExisting?.content === null && !freshExisting.loading) {
        await this._loadTabContent(freshExisting);
      } else if (currentTab?.id !== existing.id || !this.currentRenderer) {
        await this._mountRenderer(freshExisting);
      }
      this.activeContent = { kind: "file", id: existing.id };
      return existing;
    }

    if (this._isConversionTab(currentTab)) this._abortTabLoad(currentTab?.id);
    this._captureActiveRenderer();
    const defaultMode =
      metadata.mode ??
      (classifyFilePath(normalizedPath).contentType === "text" ? "edit" : "preview");
    const tab = this.state.openFile(normalizedPath, { ...metadata, mode: defaultMode });
    this._openToolbarForEditorTab(tab);
    this._openPanel();
    this._renderTabBar();
    await this._loadTabContent(tab);
    this.activeContent = { kind: "file", id: tab.id };
    this._renderTabBar();
    return tab;
  }

  async closePanel() {
    this._captureActiveRenderer();
    const dirtyTabs = this.state.getTabs().filter((tab) => tab.dirty);
    if (dirtyTabs.length > 0) {
      const settled = await this._settleDirtyTabs(dirtyTabs, "panel");
      if (!settled) return false;
    }
    this._closePanel();
    return true;
  }

  enlarge() {
    this.enlarged = true;
    this.panel.classList.add("enlarged");
    this.panel.classList.remove("collapsed");
    if (this.mainContainer) this.mainContainer.classList.add("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
  }

  collapse() {
    this.enlarged = false;
    this.panel.classList.remove("enlarged");
    if (this.mainContainer) this.mainContainer.classList.remove("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
    this._updatePanelWidth();
  }

  destroy() {
    for (const timer of this.autoSaveTimers.values()) clearTimeout(timer);
    this.autoSaveTimers.clear();
    this._abortAllTabLoads();
    this.loadTokens.clear();
    this._destroyRenderer();
    this.activeDialogCancel?.();
    this.activeDialogCancel = null;

    for (const cleanup of this.cleanupListeners.splice(0)) cleanup();
    this._unsubscribeState?.();
    this._unsubscribeLocale?.();
  }

  // ── Transient content tabs + close-risk participant APIs ────────────────

  openDiff(descriptor) {
    const id = "git-diff";
    this.diffTabs.set(id, { ...descriptor, id });
    this._deactivateCurrent();
    this.activeContent = { kind: "diff", id };
    this._destroyRenderer();
    this.currentRenderer = createGitDiffRenderer({ ...descriptor, wrapLines: this.wrapLines });
    this.currentRenderer.mount(this.content);
    this._openPanel();
    this._renderTabBar();
    this._renderToolbar();
    return id;
  }

  registerTransientTab(descriptor) {
    if (!descriptor?.id) return;
    this.transientTabs.set(descriptor.id, { ...descriptor });
    this._renderTabBar();
  }

  updateTransientTab(id, visualState = {}) {
    const entry = this.transientTabs.get(id);
    if (!entry) return;
    Object.assign(entry, visualState);
    this._renderTabBar();
  }

  activateContent({ kind, id } = {}) {
    if (kind !== "file" && kind !== "transient" && kind !== "diff") return;
    if (kind === "diff") {
      const descriptor = this.diffTabs.get(id);
      if (descriptor) this.openDiff(descriptor);
      return;
    }
    if (kind === "transient") {
      const entry = this.transientTabs.get(id);
      if (!entry) return;
      this._deactivateCurrent();
      if (this.content && entry.contentElement) {
        this.content.appendChild(entry.contentElement);
      }
      entry.onActivate?.();
      this.activeContent = { kind: "transient", id };
      this._openPanel();
      this._renderTabBar();
      this._renderToolbar();
    } else {
      this._deactivateCurrent();
      void this._selectTab(id).then(() => {
        this.activeContent = { kind: "file", id };
        this._notifyStateChange();
        this._renderTabBar();
      });
    }
  }

  requestCloseTransientTab(id) {
    const entry = this.transientTabs.get(id);
    return entry?.onRequestClose?.();
  }

  closeDiffTab(id) {
    if (!this.diffTabs.has(id)) return false;
    const wasActive = this.activeContent?.kind === "diff" && this.activeContent.id === id;
    const ids = Array.from(this.diffTabs.keys());
    const index = ids.indexOf(id);
    this.diffTabs.delete(id);
    if (wasActive) {
      this._deactivateCurrent();
      const next = ids[index + 1] || ids[index - 1];
      if (next) this.activateContent({ kind: "diff", id: next });
      else if (this.state.getActiveTab())
        this.activateContent({ kind: "file", id: this.state.activeTabId });
      else this._closePanel();
    }
    this._renderTabBar();
    return true;
  }

  unregisterTransientTab(id) {
    const entry = this.transientTabs.get(id);
    if (!entry) return;
    const wasActive = this.activeContent?.kind === "transient" && this.activeContent.id === id;
    const transientOrder = Array.from(this.transientTabs.keys());
    const closedIndex = transientOrder.indexOf(id);
    if (wasActive) this._deactivateCurrent();
    this.transientTabs.delete(id);
    this._renderTabBar();
    if (wasActive) {
      const nextTransient =
        transientOrder[closedIndex + 1] || transientOrder[closedIndex - 1] || null;
      if (nextTransient) {
        this.activateContent({ kind: "transient", id: nextTransient });
        Array.from(this.tabBar?.querySelectorAll("[data-transient-id]") || [])
          .find((tab) => tab.dataset.transientId === nextTransient)
          ?.focus();
      } else if (this.state.getActiveTab()) {
        this.activateContent({ kind: "file", id: this.state.activeTabId });
      } else {
        document.getElementById("side-chat-btn")?.focus();
      }
    }
    // If no tabs remain, hide the panel.
    if (this.transientTabs.size === 0 && this.state.getTabs().length === 0) {
      this._closePanel();
    }
  }

  showPanel() {
    this._openPanel();
  }

  hidePanel() {
    this._closePanel();
  }

  /**
   * Whether the given workspace has any persisted file tabs in storage, without
   * switching the active state. See FileTabState.hasTabsForRoot.
   */
  hasPersistedTabs(workspaceRoot) {
    return this.state.hasTabsForRoot?.(workspaceRoot) ?? false;
  }

  // Close-risk participant contract consumed by the window close coordinator.
  getCloseRisk() {
    this._riskVersion += 1;
    return {
      version: 3,
      riskVersion: this._riskVersion,
      dirtyFiles: this.state
        .getTabs()
        .filter((tab) => tab.dirty)
        .map((tab) => ({ id: tab.id, name: tab.fileName })),
    };
  }

  setInteractionLocked(locked) {
    this._interactionLocked = Boolean(locked);
    if (this.content) this.content.inert = this._interactionLocked;
    this._renderTabBar();
  }

  async settleCloseRisk(decision) {
    if (decision === "cancel") return this.getCloseRisk();
    const dirtyTabs = this.state.getTabs().filter((tab) => tab.dirty);
    if (dirtyTabs.length === 0) return this.getCloseRisk();
    if (decision === "discard") {
      for (const tab of dirtyTabs) {
        this.state.updateTab(tab.id, { content: tab.originalContent ?? "", dirty: false });
      }
      return this.getCloseRisk();
    }
    // decision === "save": flush every dirty tab.
    for (const tab of dirtyTabs) {
      await this._saveTab(tab.id).catch(() => {});
    }
    return this.getCloseRisk();
  }

  // Tab-bar action adapter so an external manager (SideChatManager) can place a
  // control (e.g. "New Side Chat") inside the tab strip without owning DOM.
  registerTabBarAction(actionId, { label, labelKey, onClick, icon = "" } = {}) {
    if (!actionId) return;
    this.tabBarActions.set(actionId, {
      label,
      labelKey,
      onClick,
      icon,
      enabled: true,
      visible: true,
      disabledReason: "",
    });
    this._renderTabBar();
  }

  setTabBarActionEnabled(actionId, enabled, disabledReason = "") {
    const action = this.tabBarActions.get(actionId);
    if (!action) return;
    action.enabled = Boolean(enabled);
    action.disabledReason = disabledReason;
    this._renderTabBar();
  }

  setTabBarActionVisible(actionId, visible) {
    const action = this.tabBarActions.get(actionId);
    if (!action) return;
    action.visible = Boolean(visible);
    this._renderTabBar();
  }

  _deactivateCurrent() {
    if (this.activeContent?.kind === "transient") {
      const entry = this.transientTabs.get(this.activeContent.id);
      entry?.onDeactivate?.();
      entry?.contentElement?.remove();
    } else if (this.activeContent?.kind === "file" || this.currentRenderer) {
      this._captureActiveRenderer();
      this._destroyRenderer();
      // Match the transient branch's element removal: clear any file renderer
      // DOM left in the content node so it cannot overlap a subsequently
      // mounted transient (Side Chat) view. _mountRenderer already does this
      // before re-mounting a file; only the deactivation path was missing it.
      this.content?.replaceChildren();
    }
    this.activeContent = null;
  }

  _notifyStateChange() {
    this.onStateChange({
      panelOpen: this.panelOpen,
      activeContent: this.activeContent,
    });
  }

  _openPanel() {
    this.panelOpen = true;
    this.panel?.classList.remove("collapsed");
    this.resizer?.classList.remove("collapsed");
    this._updatePanelWidth();
    this._updateControlButtons();
    this._renderToolbar();
    this._notifyStateChange();
  }

  _closePanel() {
    this.panelOpen = false;
    this.enlarged = false;
    this.panel?.classList.add("collapsed");
    this.panel?.classList.remove("enlarged");
    this.resizer?.classList.add("collapsed");
    this.mainContainer?.classList.remove("preview-enlarged");
    if (this.activeContent) this._deactivateCurrent();
    this._destroyRenderer();
    this.content?.replaceChildren();
    this._updateControlButtons();
    this._renderToolbar();
    this._notifyStateChange();
  }

  _destroyRenderer() {
    if (!this.currentRenderer) return;
    this.currentRenderer.destroy();
    this.currentRenderer = null;
  }

  _captureActiveRenderer() {
    const tab = this.state.getActiveTab();
    const value = this.currentRenderer?.getValue?.();
    if (!tab || typeof value !== "string" || value === tab.content) return;
    this.state.updateTab(tab.id, {
      content: value,
      dirty: value !== (tab.originalContent ?? ""),
    });
  }

  _updateControlButtons() {
    const enlargeBtn = document.getElementById("file-preview-enlarge");
    const collapseBtn = document.getElementById("file-preview-collapse");
    enlargeBtn?.classList.toggle("hidden", this.enlarged);
    collapseBtn?.classList.toggle("hidden", !this.enlarged);
  }

  _availableWidth() {
    const layoutWidth = this.panel?.parentElement?.offsetWidth || 0;
    const combinedWidth = (this.mainContainer?.offsetWidth || 0) + (this.panel?.offsetWidth || 0);
    return layoutWidth || combinedWidth || this.mainContainer?.offsetWidth || 800;
  }

  _applyPanelWidth(width) {
    const totalWidth = this._availableWidth();
    const maxWidth = Math.max(1, totalWidth * 0.7);
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    const clampedWidth = Math.max(minWidth, Math.min(maxWidth, width));
    this.panelRatio = clampedWidth / totalWidth;
    this.panel.style.width = `${Math.round(clampedWidth)}px`;
    this.panel.style.flexBasis = `${Math.round(clampedWidth)}px`;
    this.resizer?.setAttribute("aria-valuenow", String(Math.round(this.panelRatio * 100)));
  }

  _updatePanelWidth() {
    if (!this.panel || this.enlarged) return;
    this._applyPanelWidth(this._availableWidth() * this.panelRatio);
  }

  _createTabElement({
    kind,
    id,
    label,
    title,
    icon,
    iconIsElement,
    statusBadge,
    dirty,
    conflict,
    isActive,
    onActivate,
    onClose,
  }) {
    // Standard tabs pattern: the tab element carries role="tab" and roving
    // tabindex. The close action is a sibling button (not a descendant), so
    // the tab element has no interactive descendants — Enter/Space activation
    // and keyboard close never conflict. Both controls live inside a shared
    // item wrapper that only groups them visually.
    const item = document.createElement("div");
    item.className = "file-preview-tab-item";

    const tabEl = document.createElement("button");
    tabEl.type = "button";
    tabEl.className = `file-preview-tab ${kind}-tab${isActive ? " active" : ""}`;
    tabEl.dataset[kind === "diff" ? "diffId" : kind === "transient" ? "transientId" : "tabId"] = id;
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("aria-selected", String(isActive));
    tabEl.setAttribute("aria-controls", "file-preview-tabpanel");
    tabEl.setAttribute("tabindex", isActive ? "0" : "-1");
    if (title) tabEl.title = title;
    tabEl.disabled = this._interactionLocked;

    if (icon) {
      const iconEl = document.createElement("span");
      iconEl.className = "file-preview-tab-icon";
      iconEl.setAttribute("aria-hidden", "true");
      if (iconIsElement && icon instanceof Node) {
        iconEl.appendChild(icon);
      } else {
        iconEl.textContent = icon;
      }
      tabEl.appendChild(iconEl);
    }

    const name = document.createElement("span");
    name.className = "file-preview-tab-name";
    name.textContent = label;
    if (title) name.title = title;
    tabEl.appendChild(name);

    if (dirty) {
      const dot = document.createElement("span");
      dot.className = "file-preview-tab-dirty";
      dot.textContent = "●";
      dot.title = t("files.unsaved.title");
      dot.setAttribute("aria-label", t("files.unsaved.title"));
      tabEl.appendChild(dot);
    }
    if (conflict) {
      const warning = document.createElement("span");
      warning.className = "file-preview-tab-conflict";
      warning.textContent = "⚠";
      warning.title = t("files.preview.conflict");
      warning.setAttribute("aria-label", t("files.preview.conflict"));
      tabEl.appendChild(warning);
    }
    if (statusBadge) tabEl.appendChild(statusBadge);

    tabEl.addEventListener("click", () => onActivate());
    tabEl.addEventListener("keydown", (event) => this._onTabKeydown(event));

    item.appendChild(tabEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "file-preview-tab-close";
    closeBtn.type = "button";
    closeBtn.title = t("files.preview.close");
    closeBtn.setAttribute("aria-label", t("files.preview.close"));
    closeBtn.disabled = this._interactionLocked;
    appendCloseIcon(closeBtn);
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose();
    });
    item.appendChild(closeBtn);

    return { item, tabEl };
  }

  _renderTabBar() {
    if (!this.tabBar) return;
    this.tabBar.replaceChildren();
    this.tabBar.setAttribute("role", "tablist");

    for (const [id, entry] of this.diffTabs) {
      const isActive = this.activeContent?.kind === "diff" && this.activeContent.id === id;
      const { item, tabEl } = this._createTabElement({
        kind: "diff",
        id,
        label: entry.displayPath || "Diff",
        isActive,
        onActivate: () => this.activateContent({ kind: "diff", id }),
        onClose: () => this.closeDiffTab(id),
      });
      this.tabBar.appendChild(item);
      // Expose the tab element for keyboard navigation; the item wrapper only
      // groups the tab and its close button.
      void tabEl;
    }

    // Transient (Side Chat) tabs render before file tabs and preserve
    // registration order. They are in-memory only — never FileTabState.
    for (const [id, entry] of this.transientTabs) {
      const isActive = this.activeContent?.kind === "transient" && this.activeContent.id === id;
      let statusBadge = null;
      if (entry.status === "streaming" || entry.unread) {
        statusBadge = document.createElement("span");
        statusBadge.className = "transient-tab-status";
        const label =
          entry.status === "streaming" ? t("ephemeral.generating") : t("ephemeral.unread");
        statusBadge.textContent = entry.status === "streaming" ? "⋯" : "●";
        statusBadge.title = label;
        statusBadge.setAttribute("aria-label", label);
      }
      const { item } = this._createTabElement({
        kind: "transient",
        id,
        label: entry.title || "",
        title: entry.fullTitle || entry.title || "",
        statusBadge,
        isActive,
        onActivate: () => {
          if (!this._interactionLocked) this.activateContent({ kind: "transient", id });
        },
        onClose: () => this.requestCloseTransientTab(id),
      });
      this.tabBar.appendChild(item);
    }

    for (const tab of this.state.getTabs()) {
      const isActive =
        this.activeContent?.kind === "file"
          ? this.activeContent.id === tab.id
          : this.activeContent == null && tab.id === this.state.activeTabId;
      const { item, tabEl } = this._createTabElement({
        kind: "file",
        id: tab.id,
        label: tab.fileName,
        title: tab.filePath,
        icon: this._getFileIcon(tab.fileName),
        iconIsElement: true,
        dirty: tab.dirty,
        conflict: tab.conflict,
        isActive,
        onActivate: () => {
          if (!this._interactionLocked) {
            void this._selectTab(tab.id).then(() => this._renderTabBar());
          }
        },
        onClose: () => void this._closeTab(tab.id),
      });
      // File tabs trigger re-render on activation, and the tab button now owns
      // the keyboard activation so Enter/Space are handled by the button itself.
      tabEl.addEventListener("keydown", (event) => {
        this._onTabKeydown(event);
      });
      this.tabBar.appendChild(item);
    }

    // Tab-bar actions (e.g. "New Side Chat") registered by an external manager.
    for (const [actionId, action] of this.tabBarActions) {
      if (action.visible === false) continue;
      const label = action.labelKey ? t(action.labelKey) : action.label || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `file-preview-tab-action${action.icon ? " icon-btn" : ""}`;
      btn.dataset.actionId = actionId;
      btn.setAttribute("aria-label", label);
      btn.title = action.disabledReason || label;
      if (action.icon) appendTabBarActionIcon(btn, action.icon);
      else btn.textContent = label;
      btn.disabled = !action.enabled || this._interactionLocked;
      btn.addEventListener("click", () => {
        if (action.enabled && !this._interactionLocked) action.onClick?.();
      });
      this.tabBar.appendChild(btn);
    }
    this._ensureRovingTabindex();
  }

  _onTabKeydown(event) {
    if (this._interactionLocked) return;
    const tabs = Array.from(this.tabBar.querySelectorAll(".file-preview-tab"));
    const current = tabs.indexOf(event.currentTarget);
    if (current < 0) return;
    let target = current;
    if (event.key === "ArrowRight") target = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") target = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[target];
    if (next) {
      next.focus();
      next.click();
      // Keep the focused tab visible when the tab strip overflows.
      next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }

  // Roving tabindex: exactly one tab is in the tab order. If none is active,
  // make the first tab focusable so keyboard users can enter the strip.
  _ensureRovingTabindex() {
    if (!this.tabBar) return;
    const tabs = Array.from(this.tabBar.querySelectorAll(".file-preview-tab"));
    if (tabs.length === 0) return;
    if (tabs.some((tab) => tab.getAttribute("tabindex") === "0")) return;
    tabs[0].setAttribute("tabindex", "0");
  }

  _getFileIcon(fileName) {
    return createFileTypeIcon({ name: fileName });
  }

  async _selectTab(tabId) {
    const currentTab = this.state.getActiveTab();
    if (currentTab?.id === tabId) {
      // The file is already the persisted active tab, but a transient (Side
      // Chat) or diff view may be visually on top. Deactivate that overlay
      // and remount the file renderer so the content area reflects the tab.
      if (this.activeContent?.kind !== "file" || !this.currentRenderer) {
        this._deactivateCurrent();
        const tab = this.state.getTab(tabId);
        if (tab) await this._mountRenderer(tab);
      }
      this.activeContent = { kind: "file", id: tabId };
      return true;
    }
    if (this.activeContent?.kind === "transient") this._deactivateCurrent();
    if (this._isConversionTab(currentTab)) this._abortTabLoad(currentTab?.id);
    this._captureActiveRenderer();
    if (!this.state.selectTab(tabId)) return false;

    const tab = this.state.getTab(tabId);
    if (!tab) return false;
    if (tab.content === null && !tab.loading) {
      await this._loadTabContent(tab);
    } else {
      await this._mountRenderer(tab);
    }
    this.activeContent = { kind: "file", id: tabId };
    return true;
  }

  async _closeTab(tabId) {
    const tab = this.state.getTab(tabId);
    if (!tab) return false;
    if (tab.id === this.state.activeTabId) this._captureActiveRenderer();

    const freshTab = this.state.getTab(tabId);
    if (freshTab?.dirty) {
      const settled = await this._settleDirtyTabs([freshTab], "tab");
      if (!settled) return false;
    }

    this._clearAutoSave(tabId);
    this._abortTabLoad(tabId);
    this.loadTokens.delete(tabId);
    const wasActive = this.state.activeTabId === tabId;
    if (wasActive) this._destroyRenderer();
    const result = this.state.closeTab(tabId);
    if (!result.closed) return false;

    if (result.nextTabId) {
      const nextTab = this.state.getTab(result.nextTabId);
      if (nextTab?.content === null && !nextTab.loading) {
        await this._loadTabContent(nextTab);
      } else if (wasActive && nextTab) {
        await this._mountRenderer(nextTab);
      }
      if (wasActive) {
        Array.from(this.tabBar?.querySelectorAll("[data-tab-id]") || [])
          .find((tab) => tab.dataset.tabId === result.nextTabId)
          ?.focus();
      }
    } else if (this.transientTabs.size > 0) {
      // The last file tab closed but a Side Chat (transient) tab remains:
      // keep the panel open and switch to the most recent transient tab.
      // Mirrors unregisterTransientTab's dual-empty check — only collapse
      // when neither file nor transient tabs remain.
      const lastTransient = Array.from(this.transientTabs.keys()).pop();
      if (lastTransient) {
        this.activateContent({ kind: "transient", id: lastTransient });
        Array.from(this.tabBar?.querySelectorAll("[data-transient-id]") || [])
          .find((tab) => tab.dataset.transientId === lastTransient)
          ?.focus();
      } else {
        this._closePanel();
        if (wasActive) document.getElementById("file-sidebar-toggle")?.focus();
      }
    } else if (this.diffTabs.size > 0) {
      // The last file tab closed but the Git diff tab remains: keep the panel
      // open and reactivate the diff view instead of collapsing.
      const lastDiff = Array.from(this.diffTabs.keys()).pop();
      if (lastDiff) {
        this.activateContent({ kind: "diff", id: lastDiff });
      } else {
        this._closePanel();
        if (wasActive) document.getElementById("file-sidebar-toggle")?.focus();
      }
    } else {
      this._closePanel();
      if (wasActive) document.getElementById("file-sidebar-toggle")?.focus();
    }
    return true;
  }

  async _loadTabContent(tab) {
    this._abortTabLoad(tab.id);
    const token = (this.loadTokens.get(tab.id) || 0) + 1;
    this.loadTokens.set(tab.id, token);
    this.state.updateTab(tab.id, { loading: true, error: null, errorDetail: null });

    const controller = new AbortController();
    this.loadAbortControllers.set(tab.id, controller);

    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(tab.filePath)}`, {
        signal: controller.signal,
      });
      if (this.loadTokens.get(tab.id) !== token || !this.state.getTab(tab.id)) return false;
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        this.state.updateTab(tab.id, {
          loading: false,
          error: t("files.preview.loadError"),
          errorDetail: errorData.error || `HTTP ${res.status}`,
        });
        await this._mountIfActive(tab.id);
        return false;
      }

      const data = await res.json();
      if (this.loadTokens.get(tab.id) !== token || !this.state.getTab(tab.id)) return false;
      const classification = classifyFilePath(tab.filePath);
      if (data.previewStatus === "dependencyUnavailable") {
        const reason = data.dependencyReason;
        const version = typeof data.pythonVersion === "string" ? data.pythonVersion : "";
        const messageKey = `files.preview.markitdown.${reason}`;
        const message = t(messageKey, version ? { version } : undefined);
        const needsInstallCommand =
          reason === "markitdownMissing" || reason === "markitdownIncompatible";
        const displayCommand =
          typeof data.displayCommand === "string" && /^[a-z0-9 ._-]+$/i.test(data.displayCommand)
            ? data.displayCommand
            : /win/i.test(globalThis.navigator?.platform || "")
              ? "py -3"
              : "python3";
        const installKey = /win/i.test(displayCommand)
          ? "files.preview.markitdown.installWindows"
          : "files.preview.markitdown.installPosix";
        const installCommand = t(installKey).replace(/^(python3|py -3)/, displayCommand);
        const guidance = needsInstallCommand ? `${message}\n${installCommand}` : message;
        this.state.updateTab(tab.id, {
          loading: false,
          content: null,
          originalContent: null,
          editable: false,
          mode: "preview",
          error: guidance,
          errorDetail: null,
          isBinary: false,
        });
        await this._mountIfActive(tab.id);
        return false;
      }
      if (data.previewStatus === "conversionFailed") {
        this.state.updateTab(tab.id, {
          loading: false,
          content: null,
          originalContent: null,
          editable: false,
          mode: "preview",
          error: t("files.preview.unsupportedBinary"),
          errorDetail: null,
          isBinary: false,
        });
        await this._mountIfActive(tab.id);
        return false;
      }
      if (
        data.isBinary &&
        (classification.contentType === "text" || classification.contentType === "binary")
      ) {
        this.state.updateTab(tab.id, {
          loading: false,
          error: t("files.preview.unsupportedBinary"),
          errorDetail: null,
          isBinary: true,
          editable: false,
        });
        await this._mountIfActive(tab.id);
        return false;
      }

      const editable =
        data.editable !== false && classification.editable && !data.truncated && !data.isBinary;
      this.state.updateTab(tab.id, {
        loading: false,
        content: data.content ?? "",
        originalContent: data.content ?? "",
        renderAs: data.renderAs,
        mtimeMs: data.mtimeMs,
        mimeType: data.mimeType,
        size: data.size,
        truncated: Boolean(data.truncated),
        isBinary: Boolean(data.isBinary),
        editable,
        dirty: false,
        conflict: false,
        saveError: null,
        error: null,
        errorDetail: null,
        mode: editable ? tab.mode : "preview",
      });
      this.state.persist();
      await this._mountIfActive(tab.id);
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        if (this.loadTokens.get(tab.id) === token && this.state.getTab(tab.id)) {
          this.state.updateTab(tab.id, { loading: false, error: null, errorDetail: null });
        }
        return false;
      }
      if (this.loadTokens.get(tab.id) !== token || !this.state.getTab(tab.id)) return false;
      this.state.updateTab(tab.id, {
        loading: false,
        error: t("files.preview.loadError"),
        errorDetail: error instanceof Error ? error.message : String(error),
      });
      await this._mountIfActive(tab.id);
      return false;
    } finally {
      if (this.loadAbortControllers.get(tab.id) === controller) {
        this.loadAbortControllers.delete(tab.id);
      }
    }
  }

  _isConversionTab(tab) {
    return Boolean(tab && classifyFilePath(tab.filePath).contentType === "convertible");
  }

  _abortTabLoad(tabId) {
    if (!tabId) return;
    this.loadTokens.set(tabId, (this.loadTokens.get(tabId) || 0) + 1);
    const tab = this.state.getTab(tabId);
    if (tab?.content === null && tab.loading) {
      this.state.updateTab(tabId, { loading: false, error: null, errorDetail: null });
    }
    const controller = this.loadAbortControllers.get(tabId);
    if (!controller) return;
    this.loadAbortControllers.delete(tabId);
    controller.abort();
  }

  _abortAllTabLoads() {
    for (const tabId of this.loadAbortControllers.keys()) this._abortTabLoad(tabId);
  }

  async _mountIfActive(tabId) {
    if (this.state.activeTabId !== tabId) return;
    const tab = this.state.getTab(tabId);
    if (tab) await this._mountRenderer(tab);
  }

  async _mountRenderer(tab) {
    if (!tab || tab.id !== this.state.activeTabId || !this.content) return;
    this._destroyRenderer();
    this.content.replaceChildren();

    if (tab.loading) {
      const loadingEl = document.createElement("div");
      loadingEl.className = "file-preview-loading";
      loadingEl.textContent = t("files.preview.loading");
      this.content.appendChild(loadingEl);
      this._renderToolbar();
      return;
    }
    if (tab.error) {
      const errorEl = document.createElement("div");
      errorEl.className = "file-preview-error";
      errorEl.textContent = tab.error;
      this.content.appendChild(errorEl);
      this._renderToolbar();
      return;
    }

    this.currentRenderer = createFileRenderer({
      filePath: tab.filePath,
      fileName: tab.fileName,
      content: tab.content || "",
      mimeType: tab.mimeType,
      renderAs: tab.renderAs,
      mode: tab.mode || "preview",
      readOnly: tab.mode !== "edit" || !this._isEditable(tab),
      wrapLines: this.wrapLines,
      onChange: (newContent) => {
        if (this._interactionLocked) return;
        const freshTab = this.state.getTab(tab.id);
        if (!freshTab) return;
        const dirty = newContent !== (freshTab.originalContent ?? "");
        this.state.updateTab(tab.id, {
          content: newContent,
          dirty,
          saveError: null,
        });
        if (dirty) this._scheduleAutoSave(tab.id);
      },
      onModeChange: (mode) => {
        if (this._interactionLocked) return;
        this.state.updateTab(tab.id, { mode });
        this.state.persist();
      },
      onError: (error) => {
        this.state.updateTab(tab.id, {
          error: t("files.preview.loadError"),
          errorDetail: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.currentRenderer.mount(this.content);
    this._renderToolbar();
  }

  _isEditable(tab) {
    if (
      !tab ||
      tab.content === null ||
      tab.editable === false ||
      tab.truncated ||
      tab.isBinary ||
      (tab.renderAs === "markdown" && classifyFilePath(tab.filePath).contentType === "convertible")
    ) {
      return false;
    }
    return classifyFilePath(tab.filePath).editable;
  }

  _scheduleAutoSave(tabId) {
    const tab = this.state.getTab(tabId);
    if (!this.autoSaveEnabled || !tab?.dirty || tab.conflict || !this._isEditable(tab)) return;
    this._clearAutoSave(tabId);
    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(tabId);
      void this._saveTab(tabId, { autoSave: true });
    }, AUTO_SAVE_DELAY);
    this.autoSaveTimers.set(tabId, timer);
  }

  _clearAutoSave(tabId) {
    const timer = this.autoSaveTimers.get(tabId);
    clearTimeout(timer);
    this.autoSaveTimers.delete(tabId);
  }

  async _saveTab(tabId, options = {}) {
    const inFlight = this.savePromises.get(tabId);
    if (inFlight) {
      await inFlight;
      const tab = this.state.getTab(tabId);
      if (tab?.dirty && !tab.conflict) return this._saveTab(tabId, options);
      return Boolean(tab && !tab.dirty);
    }

    const operation = this._performSave(tabId, options);
    this.savePromises.set(tabId, operation);
    try {
      return await operation;
    } finally {
      if (this.savePromises.get(tabId) === operation) this.savePromises.delete(tabId);
    }
  }

  async _performSave(tabId, { autoSave = false, force = false } = {}) {
    const tab = this.state.getTab(tabId);
    if (!tab?.dirty) return true;
    if (!this._isEditable(tab)) return false;

    if (tab.conflict && !force) {
      if (autoSave) return false;
      return this._resolveSaveConflict(tabId);
    }

    const savedContent = tab.content;
    const expectedMtimeMs = tab.mtimeMs;
    this.state.updateTab(tabId, { saving: true, saveError: null });

    try {
      const res = await fetch("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: tab.filePath,
          content: savedContent,
          expectedMtimeMs,
          force,
        }),
      });

      if (res.status === 409) {
        this.state.updateTab(tabId, { saving: false, conflict: true });
        if (autoSave) return false;
        return this._resolveSaveConflict(tabId);
      }
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        this.state.updateTab(tabId, {
          saving: false,
          saveError: t("files.preview.saveError"),
          errorDetail: errorData.error || `HTTP ${res.status}`,
        });
        return false;
      }

      const data = await res.json();
      const current = this.state.getTab(tabId);
      if (!current) return false;
      this.state.updateTab(tabId, {
        saving: false,
        dirty: current.content !== savedContent,
        conflict: false,
        mtimeMs: data.mtimeMs,
        originalContent: savedContent,
        saveError: null,
        errorDetail: null,
      });
      return true;
    } catch (error) {
      this.state.updateTab(tabId, {
        saving: false,
        saveError: t("files.preview.saveError"),
        errorDetail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async _resolveSaveConflict(tabId) {
    const tab = this.state.getTab(tabId);
    if (!tab) return false;
    const action = await this.resolveConflict(tab);
    if (action === "overwrite") {
      this.state.updateTab(tabId, { conflict: false });
      return this._performSave(tabId, { force: true });
    }
    if (action === "reload") {
      return this._reloadTab(tabId, { skipConfirmation: true });
    }
    return false;
  }

  async _reloadTab(tabId, { skipConfirmation = false } = {}) {
    this._captureActiveRenderer();
    const tab = this.state.getTab(tabId);
    if (!tab) return false;
    if (tab.dirty && !skipConfirmation) {
      const settled = await this._settleDirtyTabs([tab], "reload");
      if (!settled) return false;
    }
    this._clearAutoSave(tabId);
    this.state.updateTab(tabId, {
      conflict: false,
      dirty: false,
      saveError: null,
    });
    return this._loadTabContent(this.state.getTab(tabId));
  }

  async _settleDirtyTabs(tabs, reason) {
    const action = await this.confirmDirty(tabs, reason);
    if (action === "cancel" || !action) return false;
    if (action === "save") {
      for (const tab of tabs) {
        const saved = await this._saveTab(tab.id);
        if (!saved || this.state.getTab(tab.id)?.dirty) return false;
      }
      return true;
    }
    if (action === "discard") {
      for (const tab of tabs) {
        this._clearAutoSave(tab.id);
        this.state.updateTab(tab.id, {
          content: tab.originalContent ?? "",
          dirty: false,
          conflict: false,
          saveError: null,
        });
      }
      return true;
    }
    return false;
  }

  async _setMode(mode) {
    const tab = this.state.getActiveTab();
    if (!tab || !["preview", "edit"].includes(mode)) return false;
    if (mode === "edit" && !this._isEditable(tab)) return false;
    if (tab.mode === mode) return true;
    this._captureActiveRenderer();
    this.state.updateTab(tab.id, { mode });
    this.state.persist();
    await this._mountRenderer(this.state.getTab(tab.id));
    return true;
  }

  _setupControls() {
    this.controls = {
      toolbar: document.getElementById("file-preview-toolbar"),
      toolbarToggle: document.getElementById("file-preview-toolbar-toggle"),
      enlarge: document.getElementById("file-preview-enlarge"),
      collapse: document.getElementById("file-preview-collapse"),
      close: document.getElementById("file-preview-close"),
      path: document.getElementById("file-preview-path"),
      preview: document.getElementById("file-preview-mode-preview"),
      save: document.getElementById("file-preview-save"),
      reload: document.getElementById("file-preview-reload"),
      search: document.getElementById("file-preview-search"),
      goToLine: document.getElementById("file-preview-go-to-line"),
      goToLineInput: document.getElementById("file-preview-go-to-line-input"),
      copy: document.getElementById("file-preview-copy"),
      openDesktop: document.getElementById("file-preview-open"),
      wrap: document.getElementById("file-preview-wrap"),
      autoSave: document.getElementById("file-preview-autosave"),
      status: document.getElementById("file-preview-status"),
    };

    for (const [control, icon] of [
      [this.controls.preview, "pencil"],
      [this.controls.save, "save"],
      [this.controls.reload, "refresh"],
      [this.controls.search, "search"],
      [this.controls.goToLine, "list"],
      [this.controls.copy, "copy"],
      [this.controls.openDesktop, "external-link"],
      [this.controls.toolbarToggle, "sliders"],
      [this.controls.enlarge, "maximize"],
      [this.controls.collapse, "minimize"],
      [this.controls.close, "x"],
    ]) {
      setButtonIcon(control, icon, { size: 14 });
    }

    this._listen(document.getElementById("file-preview-enlarge"), "click", () => this.enlarge());
    this._listen(document.getElementById("file-preview-collapse"), "click", () => this.collapse());
    this._listen(document.getElementById("file-preview-close"), "click", () => {
      void this.closePanel();
    });
    this._listen(this.controls.toolbarToggle, "click", () => {
      this.toolbarOpen = !this.toolbarOpen;
      this._renderToolbar();
    });
    this._listen(this.controls.preview, "click", () => {
      const mode = this.state.getActiveTab()?.mode === "edit" ? "preview" : "edit";
      void this._setMode(mode);
    });
    this._listen(this.controls.save, "click", () => {
      const tab = this.state.getActiveTab();
      if (tab) void this._saveTab(tab.id);
    });
    this._listen(this.controls.reload, "click", () => {
      const tab = this.state.getActiveTab();
      if (tab) void this._reloadTab(tab.id);
    });
    this._listen(this.controls.search, "click", () => this.currentRenderer?.openSearch?.());
    this._listen(this.controls.goToLine, "click", () => this._showGoToLineInput());
    this._listen(this.controls.goToLineInput, "keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this._hideGoToLineInput();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      const raw = event.target.value.trim();
      if (/^[1-9]\d*$/.test(raw)) {
        this.currentRenderer?.goToLine?.(Number(raw));
      }
      this._hideGoToLineInput();
    });
    this._listen(this.controls.goToLineInput, "blur", () => this._hideGoToLineInput());
    this._listen(this.controls.copy, "click", () => void this._copyActiveContent());
    this._listen(this.controls.openDesktop, "click", () => {
      const tab = this.state.getActiveTab();
      if (tab) this.onOpenDesktop(tab.filePath);
    });
    this._listen(this.controls.wrap, "change", (event) => {
      this.wrapLines = Boolean(event.target.checked);
      this.currentRenderer?.setWrapLines?.(this.wrapLines);
      if (this.activeContent?.kind === "diff")
        this.currentRenderer?.update?.({ wrapLines: this.wrapLines });
      this._savePreferences();
      this._renderToolbar();
    });
    this._listen(this.controls.autoSave, "change", (event) => {
      this.autoSaveEnabled = Boolean(event.target.checked);
      if (!this.autoSaveEnabled) {
        for (const tabId of this.autoSaveTimers.keys()) this._clearAutoSave(tabId);
      } else {
        const tab = this.state.getActiveTab();
        if (tab?.dirty) this._scheduleAutoSave(tab.id);
      }
      this._savePreferences();
      this._renderToolbar();
    });
    this._renderToolbar();
  }

  _listen(target, eventName, listener) {
    if (!target) return;
    target.addEventListener(eventName, listener);
    this.cleanupListeners.push(() => target.removeEventListener(eventName, listener));
  }

  _showGoToLineInput() {
    if (!this.controls?.goToLineInput || this.controls.goToLine?.disabled) return;
    this.goToLineInputOpen = true;
    this._renderToolbar();
    this.controls.goToLineInput.value = "";
    this.controls.goToLineInput.focus();
  }

  _hideGoToLineInput() {
    if (!this.goToLineInputOpen) return;
    this.goToLineInputOpen = false;
    this._renderToolbar();
  }

  async _copyActiveContent() {
    this._captureActiveRenderer();
    const tab = this.state.getActiveTab();
    if (!tab || typeof tab.content !== "string") return;
    try {
      await this.onCopyText(tab.content);
      this.transientStatus = t("messages.copied");
    } catch {
      this.transientStatus = t("files.preview.copyFailed");
    }
    this._renderToolbar();
    setTimeout(() => {
      this.transientStatus = "";
      this._renderToolbar();
    }, 1200);
  }

  _openToolbarForEditorTab(tab) {
    const classification = tab && classifyFilePath(tab.filePath);
    // The initial open occurs before the bounded content request has filled
    // `tab.content`/`editable`; classification is the only safe signal here.
    if (["markdown", "text"].includes(classification?.contentType)) this.toolbarOpen = true;
  }

  _renderToolbar() {
    const controls = this.controls;
    if (!controls) return;
    const isDiff = this.activeContent?.kind === "diff";
    controls.toolbarToggle?.classList.toggle("hidden", isDiff);
    controls.toolbarToggle?.setAttribute("aria-expanded", String(!isDiff && this.toolbarOpen));
    if (isDiff) this.currentRenderer?.update?.({ wrapLines: this.wrapLines });

    const tab = this.state.getActiveTab();
    const editable = this._isEditable(tab);
    const relativePath = tab ? relativeLocalPath(tab.filePath, this.workspaceRoot) : null;
    if (controls.path) {
      const displayPath = relativePath ?? normalizeLocalPath(tab?.filePath || "");
      controls.path.textContent = displayPath;
      controls.path.title = displayPath;
      controls.path.classList.toggle("hidden", isDiff || !tab || !displayPath);
    }
    const hasText = typeof tab?.content === "string" && !tab?.isBinary;
    const contentType = tab ? classifyFilePath(tab.filePath).contentType : "";
    const hasEditor =
      hasText &&
      contentType !== "image" &&
      contentType !== "pdf" &&
      contentType !== "convertible" &&
      (contentType !== "markdown" || tab.mode === "edit");
    const editorToolbarVisible = isDiff || (editable && ["markdown", "text"].includes(contentType));
    controls.toolbar?.classList.toggle(
      "hidden",
      !editorToolbarVisible || (!isDiff && !this.toolbarOpen),
    );

    for (const control of [
      controls.preview,
      controls.save,
      controls.reload,
      controls.search,
      controls.goToLine,
      controls.goToLineInput,
      controls.copy,
      controls.openDesktop,
      controls.autoSave,
    ]) {
      control?.classList.toggle("hidden", isDiff);
    }

    if (controls.preview) {
      const editing = tab?.mode === "edit";
      controls.preview.disabled = !editable;
      controls.preview.classList.toggle("active", editing);
      controls.preview.setAttribute("aria-pressed", String(editing));
      setButtonIcon(controls.preview, editing ? "eye" : "pencil", { size: 14 });
      const nextAction = t(editing ? "files.preview.preview" : "files.preview.edit");
      controls.preview.title = nextAction;
      controls.preview.setAttribute("aria-label", nextAction);
    }
    if (controls.save) controls.save.disabled = !tab?.dirty || !editable || tab.saving;
    if (controls.reload) controls.reload.disabled = !tab || tab.loading;
    if (controls.search) controls.search.disabled = !hasEditor;
    if (controls.goToLine) {
      controls.goToLine.disabled = !hasEditor;
      controls.goToLine.classList.toggle("hidden", hasEditor && this.goToLineInputOpen);
    }
    if (controls.goToLineInput) {
      controls.goToLineInput.disabled = !hasEditor;
      controls.goToLineInput.classList.toggle("hidden", !hasEditor || !this.goToLineInputOpen);
    }
    if (controls.copy) controls.copy.disabled = !hasText;
    if (controls.openDesktop) {
      controls.openDesktop.disabled = isDiff || !tab;
      controls.openDesktop.classList.toggle("hidden", isDiff);
    }
    if (controls.wrap) controls.wrap.checked = this.wrapLines;
    if (controls.autoSave) controls.autoSave.checked = this.autoSaveEnabled;
    if (controls.status) {
      controls.status.textContent = this._toolbarStatus(tab, editable);
    }
  }

  _toolbarStatus(tab, editable) {
    if (this.transientStatus) return this.transientStatus;
    if (!tab) return "";
    if (tab.loading) return t("files.preview.loading");
    if (tab.saving) return t("files.preview.saving");
    if (tab.conflict) return t("files.preview.conflict");
    if (tab.saveError) return tab.saveError;
    if (tab.dirty) return t("files.unsaved.title");
    if (!editable) return t("files.preview.readOnly");
    return t("files.preview.saved");
  }

  _setupResizer() {
    if (!this.resizer) return;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseDown = (event) => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = this.panel.offsetWidth;
      this.resizer.classList.add("dragging");
      document.body.classList.add("file-preview-resizing");
      event.preventDefault();
    };
    const onMouseMove = (event) => {
      if (!dragging) return;
      this._applyPanelWidth(startWidth + startX - event.clientX);
    };
    const finishDrag = () => {
      if (!dragging) return;
      dragging = false;
      this.resizer.classList.remove("dragging");
      document.body.classList.remove("file-preview-resizing");
      this._savePreferences();
    };
    const onKeyDown = (event) => {
      const currentWidth = this.panel.offsetWidth || this._availableWidth() * this.panelRatio;
      let nextWidth = currentWidth;
      if (event.key === "ArrowLeft") nextWidth += 16;
      else if (event.key === "ArrowRight") nextWidth -= 16;
      else if (event.key === "Home") nextWidth = MIN_PANEL_WIDTH;
      else if (event.key === "End") nextWidth = this._availableWidth() * 0.7;
      else return;
      event.preventDefault();
      this._applyPanelWidth(nextWidth);
      this._savePreferences();
    };
    const onResize = () => this._updatePanelWidth();

    this._listen(this.resizer, "mousedown", onMouseDown);
    this._listen(document, "mousemove", onMouseMove);
    this._listen(document, "mouseup", finishDrag);
    this._listen(this.resizer, "keydown", onKeyDown);
    this._listen(window, "resize", onResize);
    this.cleanupListeners.push(() => {
      dragging = false;
      this.resizer.classList.remove("dragging");
      document.body.classList.remove("file-preview-resizing");
    });
  }

  _setupListeners() {
    this._unsubscribeState = this.state.subscribe(() => {
      this._renderTabBar();
      this._renderToolbar();
    });
  }

  _showDirtyDialog(tabs) {
    const message =
      tabs.length === 1
        ? t("files.unsaved.description")
        : t("files.unsaved.descriptionMultiple", { count: tabs.length });
    return this._showChoiceDialog({
      title: t("files.unsaved.title"),
      message,
      choices: [
        { action: "save", label: t("files.unsaved.save"), primary: true },
        { action: "discard", label: t("files.unsaved.discard") },
        { action: "cancel", label: t("files.unsaved.cancel") },
      ],
      cancelAction: "cancel",
    });
  }

  _showConflictDialog(tab) {
    return this._showChoiceDialog({
      title: t("files.preview.conflict"),
      message: t("files.preview.conflictMessage", { name: tab.fileName }),
      choices: [
        { action: "reload", label: t("files.preview.conflictReload") },
        {
          action: "overwrite",
          label: t("files.preview.conflictOverwrite"),
          primary: true,
        },
        { action: "cancel", label: t("files.unsaved.cancel") },
      ],
      cancelAction: "cancel",
    });
  }

  _showChoiceDialog({ title, message, choices, cancelAction }) {
    this.activeDialogCancel?.();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "file-preview-dialog-overlay";
      const dialog = document.createElement("div");
      dialog.className = "file-preview-dialog";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");

      const heading = document.createElement("h3");
      heading.textContent = title;
      const body = document.createElement("p");
      body.textContent = message;
      const actions = document.createElement("div");
      actions.className = "file-preview-dialog-actions";
      dialog.append(heading, body, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        this.activeDialogCancel = null;
        resolve(action);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") finish(cancelAction);
      };
      document.addEventListener("keydown", onKeyDown);

      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `file-preview-dialog-button${choice.primary ? " primary" : ""}`;
        button.textContent = choice.label;
        button.addEventListener("click", () => finish(choice.action));
        actions.appendChild(button);
      }

      this.activeDialogCancel = () => finish(cancelAction);
      actions.querySelector(".primary")?.focus();
    });
  }

  _restorePreferences() {
    try {
      const storage = this.storage;
      if (!storage) return;
      const storedRatio = Number.parseFloat(storage.getItem("picot-preview-panel-ratio"));
      this.panelRatio = Number.isFinite(storedRatio)
        ? Math.max(0.2, Math.min(0.7, storedRatio))
        : DEFAULT_PANEL_RATIO;
      const storedWrap = storage.getItem("picot-preview-wrap");
      this.wrapLines = storedWrap === null ? true : storedWrap === "true";
      this.autoSaveEnabled = storage.getItem("picot-preview-autosave") !== "false";
    } catch {
      this.panelRatio = DEFAULT_PANEL_RATIO;
    }
  }

  _savePreferences() {
    try {
      const storage = this.storage;
      if (!storage) return;
      storage.setItem("picot-preview-panel-ratio", String(this.panelRatio));
      storage.setItem("picot-preview-wrap", String(this.wrapLines));
      storage.setItem("picot-preview-autosave", String(this.autoSaveEnabled));
    } catch {
      // Storage is optional in opaque WebView origins and private browsing.
    }
  }
}
