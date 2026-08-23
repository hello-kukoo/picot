// ABOUTME: Orchestrates Picot's main chat, workspace, file, and ephemeral-chat modules.
// ABOUTME: Keeps feature state in focused modules and wires their lifecycle events.

/**
 * Main App - Ties everything together
 */

import { createCompactCoordinator } from "./compact-coordinator.js";
import { repaintContextViz, setupContextViz } from "./ui/context-viz.js";
import { createHeaderStatusBar } from "./ui/header-status-bar.js";
import { initImageLightbox } from "./ui/image-lightbox.js";
import "./cost/dashboard.js";
import { StateManager } from "./app/state.js";
import { initTransport } from "./app/transport.js";
import { createAppUpdater } from "./app/updater.js";
import { setupVoiceInput } from "./app/voice-input.js";
import { resolveWebSocketUrl, WebSocketClient } from "./app/websocket-client.js";
import { setupComposerCommandMenu } from "./composer-command-menu.js";
import { setupComposerImageAttachments } from "./composer-image-attachments.js";
import { setupComposerPasteOffload } from "./composer-paste-offload.js";
import { EphemeralChatView } from "./ephemeral-chat-view.js";
import { setupExtensionUpdateIndicator } from "./extension-update-indicator.js";
import { createFilePreviewFollow, isWriteTool, pathFromToolArgs } from "./file-preview-follow.js";
import { FilePreviewPanel } from "./file-preview-panel.js";
import { GitClient } from "./git-client.js";
import { GitPanel } from "./git-panel.js";
import {
  getLanguagePreference,
  initI18n,
  LANGUAGES,
  onLocaleChange,
  setLocale,
  t,
} from "./i18n.js";
import { createIcon, replaceButtonGlyph, setButtonIcon } from "./icons.js";
import { processImageFile, processImagePayload } from "./image-attachments.js";
import { InfoPanel } from "./info-panel.js";
import { selectModel } from "./models/selection.js";
import { renderPackageInstallFailure } from "./packages/install-status.js";
import { QuickChatDialog } from "./quick-chat-dialog.js";
import { getOnboardingState } from "./session/onboarding.js";
import { resolveNewSessionLiveFile } from "./session/refresh.js";
import {
  applyForegroundMirrorSession,
  confirmDeferredFileBrowserWorkspace,
  deferFileBrowserWorkspace,
  findPortForSession,
  getWorkspacePathForPort,
  isExpectedMirrorSession,
  shouldSuppressFileBrowserLoad,
  shouldSuppressFileBrowserRefresh,
} from "./session/routing.js";
import { anchorHistoryToBottom } from "./session/scroll-anchor.js";
import { setupSessionInfo } from "./session/session-info.js";
import { SessionUiStateStore } from "./session-ui-state.js";
import { LegacyConfigGateway } from "./settings/config-gateway-legacy.js";
import { setupExtensionsTabShell } from "./settings/extensions-tab-shell.js";
import { setupModelsPage } from "./settings/models-page.js";
import { setupPackageBrowse } from "./settings/package-browse.js";
import { setupPackageManager } from "./settings/package-manager.js";
import { setupPackageSkillsTab } from "./settings/package-skills-tab.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings/save-status.js";
import { setupSettingsConfig } from "./settings/settings-config.js";
import { setupSkillsInstallTab } from "./settings/skills-install-tab.js";
import { setupSkillsPage } from "./settings/skills-page.js";
import { setupSkillsTabShell } from "./settings/skills-tab-shell.js";
import {
  bindSuperAgentStartupToggle,
  renderThinkingEffort,
  setupSettingsToggles,
} from "./settings/toggles.js";
import { SideChatManager } from "./side-chat-manager.js";
import { buildSessionItem } from "./sidebar/build-session-item.js";
import {
  clearFocusParam,
  FOCUS_WORKSPACE_PARAM,
  resolveFocusState,
  withFocusParam,
} from "./sidebar/focus-state.js";
import { SessionSidebar } from "./sidebar/index.js";
import { setupSidebarSearchControl } from "./sidebar/search-control.js";
import { WorkspaceFocusSidebar } from "./sidebar/workspace-focus-sidebar.js";
import { createSidebarResizer } from "./sidebar-resizer.js";
import { ensureSuperAgentSession } from "./super-agent/bootstrap.js";
import { dispatchSuperAgentTask as dispatchSuperAgentTaskCore } from "./super-agent/dispatch.js";
import { installSuperAgentSessionNavigationReset } from "./super-agent/navigation.js";
import { getRunningSuperAgentPorts, isSuperAgentSession } from "./super-agent/session.js";
import { isSuperAgentEnabled } from "./super-agent/settings.js";
import { planSuperAgentShutdown } from "./super-agent/stop-plan.js";
import {
  buildSuperAgentNotificationPrompt,
  buildTaskComposerPrompt,
  markTaskFinished,
  normalizeSuperAgentTasks,
} from "./super-agent/task-state.js";
import { TerminalClient } from "./terminal-client.js";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_STACK,
} from "./terminal-font.js";
import { formatTerminalStartError, TerminalPanel } from "./terminal-panel.js";
import { TerminalPreferences } from "./terminal-preferences.js";
import {
  encodeBase64 as encodeTerminalBase64,
  picotThemeToXterm,
  TerminalTab,
} from "./terminal-tab.js";
import { applyTheme, getCurrentTheme, themes } from "./themes.js";
import { renderTurnFileChips } from "./turn-file-chips.js";
import { setupAtFileMention } from "./ui/at-file-mention.js";
import { DialogHandler } from "./ui/dialogs.js";
import { setupMessagesInsets } from "./ui/layout-insets.js";
import { MessageRenderer } from "./ui/message-renderer.js";
import { createProcessDetailsGroup, summarizeProcessGroup } from "./ui/process-group.js";
import { setupResizablePanel } from "./ui/resizable-panel.js";
import {
  isRpivTodoCommandNotify,
  isRpivTodoWidgetRequest,
  RpivTodoMirrorPanel,
} from "./ui/rpiv-todo-mirror.js";
import { setupSessionSearchDialog } from "./ui/session-search-dialog.js";
import { setupSkillSlashCommand } from "./ui/skill-slash-command.js";
import { ToolCardRenderer } from "./ui/tool-card.js";
import { WindowCloseCoordinator } from "./window-close-coordinator.js";
import {
  buildWorkspaceUrl,
  openFolderAsWorkspace,
  startInWindowNewSession,
  startNewProjectChat,
  withBrokerWs,
} from "./workspace/actions.js";
import { FileBrowser } from "./workspace/file-browser.js";
import {
  cacheSidebarProjects,
  consumeNavState,
  readCachedSidebarProjects,
  snapshotNavState,
} from "./workspace/nav-state-cache.js";
import {
  createWorkspaceActionsController,
  populateAppLogo as sharedPopulateAppLogo,
} from "./workspace-actions.js";

// Initialize locale messages before constructing components that call t().
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);
await initI18n();

const fetchInstances = async () => {
  try {
    const res = await fetch("/api/instances");
    if (!res.ok) return [];
    const data = await res.json();
    return data.instances || [];
  } catch {
    return [];
  }
};
const getCurrentPort = () => {
  const fromTransport = transport?.currentPort?.();
  if (typeof fromTransport === "number") return fromTransport;
  const fromLocation = Number(location.port);
  return Number.isFinite(fromLocation) && fromLocation > 0 ? fromLocation : 47821;
};
const mobileClientMode = new URLSearchParams(window.location.search).get("mobile") === "1";
// Workspace Focus mode orchestration state.
// `currentFocusProject` is the project whose task-workspace sidebar is
// currently rendered; null while the normal sidebar is shown. It is the
// single in-memory mirror of the URL `focusWorkspaceId` param: navigation
// uses it to decide whether to carry focus across a same-workspace port hop.
let currentFocusProject = null;
// Snapshot of the normal sidebar (scroll/search/expansion) captured on
// focus entry and restored on exit. Null outside an active focus session.
let normalSidebarSnapshot = null;
let currentFocusSidebar = null;
const navigateInWindow = (url, metadata = {}) => {
  let targetUrl;
  try {
    // Validate origin first so a cross-origin target is rejected before any
    // focus-param mutation runs. withFocusParam then keeps focusWorkspaceId
    // only when the target cwd equals the focused project's canonical path;
    // any stale param is stripped, so cross-workspace/unknown navigation
    // clears focus rather than carrying a dangling id onto the next page.
    const parsed = new URL(url, window.location.href);
    const currentUrl = new URL(window.location.href);
    if (
      parsed.protocol !== currentUrl.protocol ||
      parsed.hostname !== currentUrl.hostname ||
      parsed.username ||
      parsed.password
    ) {
      console.error("[navigation] rejected cross-origin target");
      return;
    }
    const requestedFocusId = currentUrl.searchParams.get(FOCUS_WORKSPACE_PARAM);
    // During a cross-port navigation (e.g. switching to a freshly spawned pi
    // port), currentFocusProject has not been re-resolved yet on the new page
    // load. Fall back to the focusWorkspaceId the current URL still carries so
    // focus survives the port hop; withFocusParam re-encodes it onto the target
    // URL only when targetCwd matches that project's path, and strips it
    // otherwise. Once the new page boots and resolveFocusState runs,
    // currentFocusProject is repopulated from the sidebar and this fallback is
    // no longer exercised.
    const focusProject =
      currentFocusProject ||
      (requestedFocusId?.startsWith("workspace:")
        ? { path: requestedFocusId.slice("workspace:".length) }
        : null);
    targetUrl = withFocusParam(metadata.targetCwd, focusProject, parsed);
    if (mobileClientMode) targetUrl.searchParams.set("mobile", "1");
  } catch {
    console.error("[navigation] rejected invalid target");
    return;
  }
  window.location.assign(targetUrl.toString());
};

async function navigateToWorkspacePort(targetCwd, targetPort) {
  if (typeof targetPort !== "number" || targetPort === getCurrentPort()) return;
  if (typeof transport.prepareWorkspaceTarget === "function") {
    const prepared = await transport.prepareWorkspaceTarget(targetCwd, { targetPort });
    if (typeof prepared?.transitionGeneration !== "number") {
      throw new Error("Workspace navigation was not prepared");
    }
    await transport.commitWorkspaceTransition(prepared.transitionGeneration);
  }
  navigateInWindow(withBrokerWs(buildWorkspaceUrl(targetPort), transport), { targetCwd });
}

// ──────────────────────────────────────────────────────────────────────
// Workspace Focus mode orchestration
// ──────────────────────────────────────────────────────────────────────
// Focus replaces the normal sidebar with a task-workbench view of a single
// workspace (back / new task / read-only session list). Its state lives only
// in the URL `focusWorkspaceId` param: it survives a same-workspace port hop
// (New Task / parallel session) and is dropped on any cross-workspace nav.
// `currentFocusProject` is the in-memory mirror used by navigateInWindow.
function focusSidebarEl() {
  return document.getElementById("sidebar");
}

function enterFocus(project) {
  if (!project) return;
  // Switching focus directly between two workspaces is rare (the focus button
  // is only shown for the active workspace), but guard against it so the prior
  // snapshot is not silently overwritten by the new workspace's focus view.
  if (currentFocusProject && currentFocusProject.path !== project.path) {
    currentFocusProject = null;
    normalSidebarSnapshot = null;
  }
  if (currentFocusProject?.path === project.path) return;
  // Close any open transient UI from the normal sidebar before snapshotting.
  sidebar.closeContextMenu?.();
  sidebar.quickInfo?.close?.();

  const sessionList = document.getElementById("session-list");
  // Make sure the snapshot reflects real DOM, not a loading skeleton, when
  // focus is entered during boot before the first render completed.
  if (!normalSidebarSnapshot) sidebar.render();
  normalSidebarSnapshot = {
    scrollTop: sessionList.scrollTop,
    searchQuery: sidebar.searchQuery,
    expandedWorkspaces: new Set(sidebar.expandedWorkspaces),
  };

  focusSidebarEl()?.classList.add("focus-mode");
  // Show a "Workspace" label after the logo while focus is active; removed on exit.
  const modeToggle = document.querySelector(".mode-toggle");
  if (modeToggle && !modeToggle.parentElement.querySelector(".sidebar-focus-brand")) {
    const brand = document.createElement("span");
    brand.className = "sidebar-focus-brand";
    brand.textContent = t("workspace.focusTitle");
    modeToggle.after(brand);
  }
  currentFocusProject = project;

  const focusCardInfo = {
    path: project.path,
    count: Array.isArray(project.sessions) ? project.sessions.length : 0,
  };
  const focusSidebar = new WorkspaceFocusSidebar(sessionList, {
    project,
    cardInfo: focusCardInfo,
    activeSessionFile: sidebar.activeSessionFile,
    unread: sidebar.unread,
    streaming: sidebar.streamingFiles,
    isArchived: (filePath) => sidebar.isArchived(filePath),
    buildSessionItem,
    onBack: () => exitFocus(),
    onNewTask: (p) => {
      handleNewProjectChat(p);
    },
    onSessionSelect: handleSessionSelect,
    onDelete: (filePath) => deleteFocusSession(filePath),
    onRename: (filePath, session, item) => sidebar.renameSession(filePath, session, item),
  });
  currentFocusSidebar = focusSidebar;
  focusSidebar.render();

  // Persist focus in the URL so a same-workspace port navigation carries it.
  try {
    const next = withFocusParam(project.path, currentFocusProject, window.location.href);
    if (next.toString() !== window.location.href) {
      history.replaceState(history.state, "", next.toString());
    }
  } catch {
    /* URL mutation is best-effort; focus still works in-memory. */
  }

  // Asynchronously enrich the focus info card with the git repository name.
  if (project.workspaceId) {
    fetchWorkspaceRepository(project.workspaceId).then((repository) => {
      if (!repository || !currentFocusSidebar) return;
      if (currentFocusProject?.path !== project.path) return;
      currentFocusSidebar.setProjectState({
        cardInfo: {
          path: project.path,
          count: Array.isArray(project.sessions) ? project.sessions.length : 0,
          repository,
        },
      });
      currentFocusSidebar.render();
    });
  }
}

function exitFocus() {
  const snapshot = normalSidebarSnapshot;
  normalSidebarSnapshot = null;
  currentFocusSidebar = null;
  currentFocusProject = null;

  try {
    const cleaned = clearFocusParam(window.location.href);
    if (cleaned.toString() !== window.location.href) {
      history.replaceState(history.state, "", cleaned.toString());
    }
  } catch {
    /* best-effort */
  }

  document.querySelector(".sidebar-focus-brand")?.remove();
  focusSidebarEl()?.classList.remove("focus-mode");
  if (snapshot) {
    sidebar.expandedWorkspaces = snapshot.expandedWorkspaces;
    // Restore the search filter BEFORE render so the rebuilt list reflects it.
    sidebar.searchQuery = snapshot.searchQuery;
  }
  sidebar.render();
  if (snapshot) {
    const sessionList = document.getElementById("session-list");
    if (sessionList) sessionList.scrollTop = snapshot.scrollTop;
    const searchInput = document.getElementById("session-search-input");
    if (searchInput) searchInput.value = snapshot.searchQuery;
  }
}

// Refreshes the live focus view with the latest sidebar data. Called by
// SessionSidebar.render (via the isFocusActive/onFocusRefresh delegation) and
// by resolveAndApplyFocus when focus is already active on the matched
// workspace, so loadSessions()/setActive() updates reach the focus view
// instead of being dropped by the matched-state early return.
function refreshFocusView() {
  if (!currentFocusSidebar || !currentFocusProject) return;
  const project =
    sidebar.projects.find((p) => p?.path === currentFocusProject.path) || currentFocusProject;
  currentFocusSidebar.setProjectState({
    project,
    cardInfo: {
      path: project.path,
      count: Array.isArray(project.sessions) ? project.sessions.length : 0,
    },
    activeSessionFile: sidebar.activeSessionFile,
    unread: sidebar.unread,
    streaming: sidebar.streamingFiles,
  });
  currentFocusSidebar.render();
}

// Deletes a single session from the focus view. Reuses the archived-delete
// confirmation + delete-batch flow; the server rejects any path still held by
// a running Pi instance. On confirmed success it cleans the recent cookie and
// session pin, then reloads sessions (which refreshes the focus view).
async function deleteFocusSession(filePath) {
  if (!filePath) return;
  const ok = await sidebar.confirmArchivedDeletion(1);
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
      sidebar.onSessionNotice?.(t("sidebar.deleteSessionRunning"));
      return;
    }
    if (errors.has(filePath)) return;
    sidebar.removeFromRecentSessions(filePath);
    sidebar.pinStore.unpinSession(filePath);
  } catch (err) {
    console.error("[Focus] deleteFocusSession failed:", err);
  }
  await sidebar.loadSessions();
}

// Fetches the git repository name for the focus info card. Mirrors the
// WorkspaceQuickInfo metadata path; returns null when the workspace is not a
// git repo or the request fails so the card simply omits the repo row.
async function fetchWorkspaceRepository(workspaceId) {
  if (!workspaceId) return null;
  try {
    const params = new URLSearchParams();
    params.set("workspaceId", workspaceId);
    const res = await fetch(`/api/workspace-info?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.isGit === true && data.repository) return data.repository;
    return null;
  } catch {
    return null;
  }
}

// Idempotent focus resolver called at boot and after every session/project
// data update. pending (active session or its project still unknown) never
// touches the UI; matched re-enters focus only when the resolved workspace
// differs from the one already focused; mismatched exits focus if active,
// otherwise just scrubs a residual URL param.
function resolveAndApplyFocus() {
  const requestedId = new URLSearchParams(window.location.search).get(FOCUS_WORKSPACE_PARAM);
  const { state, project } = resolveFocusState({
    requestedId,
    projects: sidebar.projects,
    activeSessionFile: sidebar.activeSessionFile,
  });
  if (state === "pending") return;
  if (state === "matched") {
    if (currentFocusProject?.path === project.path) {
      refreshFocusView();
      return;
    }
    enterFocus(project);
    return;
  }
  if (currentFocusProject) {
    exitFocus();
    return;
  }
  try {
    const cleaned = clearFocusParam(window.location.href);
    if (cleaned.toString() !== window.location.href) {
      history.replaceState(history.state, "", cleaned.toString());
    }
  } catch {
    /* best-effort */
  }
}

// ──────────────────────────────────────────────────────────────────────
// Instance-swap overlay
// ──────────────────────────────────────────────────────────────────────
// `+ New Session`, `start new chat`, `Open Project`, and `Open Folder`
// all end with `window.location.href = http://<current-host>:<newPort>/`,
// which is a full-page navigation and would otherwise show a 1–2s
// freeze (while pi spawns) and then a white flash (while the WebView
// reloads). To make this look like a single smooth transition we:
//
//   1. Open a fullscreen spinner overlay BEFORE awaiting openWorkspace.
//   2. Persist a sessionStorage flag so the new page boots into the
//      same overlay (see <head> bootstrap script in index.html).
//   3. After the new page's WebSocket first connects, fade out.
//
// Returns a `dismiss` function that rolls back the overlay if the
// swap fails before navigation (e.g. openWorkspace rejects).
function showSwapOverlay(label) {
  // Snapshot ephemeral UI state before the page navigates away. The new
  // page (on a different pi port) boots fresh; consumeNavState() restores
  // scroll positions, sidebar expansion, search query, and the input draft
  // so the workspace switch feels continuous instead of a reset to initial.
  try {
    snapshotNavState({
      messageScroll: messagesContainer ? messagesContainer.scrollTop : null,
      sidebarScroll: sidebarEl ? sidebarEl.scrollTop : null,
      inputDraft: messageInput ? messageInput.value : "",
      expandedWorkspaces: sidebar ? sidebar.expandedWorkspaces : [],
      searchQuery: sidebar ? sidebar.searchQuery : "",
    });
  } catch {
    /* snapshot is best-effort */
  }
  try {
    sessionStorage.setItem("pi-studio:swapping-instance", "1");
  } catch {}
  document.body.classList.add("swapping-instance");
  const overlay = document.getElementById("instance-swap-overlay");
  if (overlay) overlay.setAttribute("data-visible", "true");
  const labelEl = document.getElementById("instance-swap-overlay-label");
  if (labelEl && typeof label === "string" && label) labelEl.textContent = label;
  return hideSwapOverlay;
}

function hideSwapOverlay() {
  try {
    sessionStorage.removeItem("pi-studio:swapping-instance");
  } catch {}
  document.body.classList.remove("swapping-instance");
  const overlay = document.getElementById("instance-swap-overlay");
  if (overlay) overlay.setAttribute("data-visible", "false");
}

// Returned to workspace/actions.js — they call this BEFORE openWorkspace
// (so the overlay covers spawn latency) and the returned dismiss is only
// invoked on error (success path lets the overlay persist across the
// navigation boundary).
const onBeforeInstanceSwap = (label) => showSwapOverlay(label);

// If the page booted into the overlay (because we just navigated from
// a previous instance), fade it out as soon as the WebSocket reaches
// the new pi. The post-connect wait avoids a brief flash of empty
// chat UI before /api/sessions and get_state finish populating things.
function dismissBootSwapOverlayWhenReady() {
  if (!document.body.classList.contains("swapping-instance")) return;
  const fade = () => {
    requestAnimationFrame(() => {
      const overlay = document.getElementById("instance-swap-overlay");
      if (overlay) overlay.setAttribute("data-visible", "false");
      document.body.classList.remove("swapping-instance");
      try {
        sessionStorage.removeItem("pi-studio:swapping-instance");
      } catch {}
    });
  };
  const alreadyOpen = wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN;
  if (alreadyOpen) {
    fade();
  } else {
    const onConnect = () => {
      wsClient.removeEventListener("connected", onConnect);
      fade();
    };
    wsClient.addEventListener("connected", onConnect);
  }
  setTimeout(() => {
    if (document.body.classList.contains("swapping-instance")) hideSwapOverlay();
  }, 5000);
}

// Initialize components
const wsUrl = resolveWebSocketUrl(window);
const wsClient = new WebSocketClient(wsUrl);
// Unified control transport: every process/window lifecycle + native op goes
// through the broker WebSocket (broker_control). No Tauri IPC hooks — the
// desktop WebView, a remote client, and a mobile client all use the same API.
// Native-only ops are gated on
// `transport.capabilities.native` (advertised by the broker handshake).
const transport = initTransport({ wsClient, env: window });
// True once the broker advertises a native (OS/window) control handler — i.e.
// we're attached to the desktop host. Drives native-only UI gating. Starts
// false and flips when the `capabilities` frame arrives (see listener below).
// `?mobile=1` is a browser client even if it reaches the desktop broker, so it
// must not use native workspace/window controls.
const nativeAvailable = () => !mobileClientMode && transport.capabilities.native;
const canUseSessionControl = () => transport.capabilities.native;
const state = new StateManager();
const messagesElement = document.getElementById("messages");
// sessionTreeActions: the main chat is the only persisted-session surface;
// its Fork/Edit buttons dispatch to app.js's transport handlers below.
const messageRenderer = new MessageRenderer(messagesElement, { sessionTreeActions: true });
const toolCardRenderer = new ToolCardRenderer(messagesElement, { enableFileRefs: true });
initImageLightbox(messagesElement);
const dialogHandler = new DialogHandler({
  container: document.getElementById("dialog-container"),
  notificationContainer: document.getElementById("messages"),
  send: (message) => wsClient.send(message),
});
let superAgentPath = "";
let superAgentAddonsActive = false;

function clearConversationRenderers() {
  messageRenderer.clear();
  toolCardRenderer.clear();
}

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById("session-list"),
  handleSessionSelect,
  handleNewProjectChat,
  {
    onOpenProject: (project) => {
      if (!project?.path) return handleOpenFolder();
      return fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: project.path }),
      });
    },
    onWorkspaceFocus: (project) => enterFocus(project),
    isCurrentWorkspace: (project) => project?.path === getCurrentWorkspacePath(),
    getLiveInstances: () => liveInstances,
    onSessionNotice: (message) => {
      if (typeof messageRenderer?.renderSystemMessage === "function") {
        messageRenderer.renderSystemMessage(message);
      } else {
        console.warn("[Sidebar] session notice:", message);
      }
    },
    isFocusActive: () => currentFocusProject !== null,
    onFocusRefresh: () => refreshFocusView(),
  },
);

// Header session-info popover: file path from the active session mirror.
// Getter is lazy so late-arriving state (first session file, reconnect)
// is reflected on every open.
const sessionInfoToggle = document.getElementById("session-info-toggle");
replaceButtonGlyph(sessionInfoToggle, "circle-info", { size: 16 });
const sessionInfo = setupSessionInfo({
  toggle: sessionInfoToggle,
  panel: document.getElementById("session-info-panel"),
  fileValue: document.getElementById("session-info-file"),
  getFilePath: () => mirrorActiveSessionFile || sidebar.activeSessionFile || "",
});

// ── Super Agent wiring ──────────────────────────────────────────────────────
// Compatibility surface for Super Agent add-on Web Components.
window.__saNav = {
  get transport() {
    return transport;
  },
  fetchInstances,
  getCurrentPort,
  buildWorkspaceUrl,
  withBrokerWs,
  navigateInWindow,
  startInWindowNewSession,
};

// <super-agent-runtime> fires 'sa-dispatch' when the user approves a task.
document.addEventListener("sa-dispatch", (e) => dispatchSuperAgentTask(e.detail));
document.addEventListener("sa-ask", (e) => notifySuperAgentClarification(e.detail));
document.addEventListener("sa-prompt-task", (e) => insertTaskPrompt(e.detail));
document.addEventListener("sa-view-session", (e) => viewSuperAgentChildSession(e.detail));
installSuperAgentSessionNavigationReset(document);

// <sa-chat-header> service buttons open Settings. The Agent Inbox tab is
// temporarily disabled, so route to the default Settings page instead.
window.__saOpenSettings = () => {
  void openSettings();
};
// ── end Super Agent wiring ───────────────────────────────────────────────────

async function initSuperAgentPath() {
  try {
    const res = await fetch("/api/home");
    if (!res.ok) return;
    const data = await res.json();
    if (!data?.home) return;
    superAgentPath = `${data.home}/.pi/agent/super-agent`;
    sidebar.superAgentPath = superAgentPath;
  } catch (error) {
    console.warn("[SuperAgent] failed to resolve home directory:", error);
  }
}

function updateSuperAgentActiveState(session = null, project = null) {
  const active = isSuperAgentSession(session, project, superAgentPath);
  document.body.classList.toggle("super-agent-active", active);
  document.getElementById("super-agent-chat-header")?.classList.toggle("hidden", !active);
  if (active && !superAgentAddonsActive && localStorage.getItem("sa-runtime-collapsed") === "0") {
    document.querySelector("super-agent-runtime")?.classList.remove("collapsed");
  }
  superAgentAddonsActive = active;
}

function updateSuperAgentActiveStateFromWorkspace() {
  updateSuperAgentActiveState(null, { path: getCurrentWorkspacePath() });
}

async function loadSessionsWithSuperAgentBootstrap() {
  const projects = await sidebar.loadSessions();
  if (!isSuperAgentEnabled()) return projects;

  const created = await ensureSuperAgentSession({
    superAgentPath,
    projects,
    transport,
  }).catch((error) => {
    console.warn("[SuperAgent] failed to ensure fixed session:", error);
    return false;
  });
  if (created) {
    await pollInstances().catch(() => {});
    return sidebar.loadSessions();
  }
  return projects;
}

async function stopSuperAgentInstances() {
  const instances = await fetchInstances();
  const ports = getRunningSuperAgentPorts({
    projects: sidebar.projects,
    instances,
    superAgentPath,
  });
  const shutdown = planSuperAgentShutdown({
    currentPort: getCurrentPort(),
    superAgentPorts: ports,
    instances,
    superAgentPath,
  });
  await Promise.all(
    shutdown.portsToStopBeforeNavigation.map((port) =>
      transport.stopInstance(port).catch((error) => {
        console.warn(`[SuperAgent] failed to stop instance on port ${port}:`, error);
      }),
    ),
  );
  if (shutdown.navigateToPort) {
    const dismiss = showSwapOverlay("Closing Agent Inbox…");
    try {
      const url = new URL(withBrokerWs(buildWorkspaceUrl(shutdown.navigateToPort), transport));
      if (shutdown.portsToStopAfterNavigation.length > 0) {
        url.searchParams.set("stopSuperAgentPorts", shutdown.portsToStopAfterNavigation.join(","));
      }
      navigateInWindow(url.toString());
      return;
    } catch (error) {
      dismiss();
      console.warn("[SuperAgent] failed to navigate away before shutdown:", error);
    }
  }
  await pollInstances().catch(() => {});
  await sidebar.loadSessions().catch(() => {});
  updateSuperAgentActiveStateFromWorkspace();
  updateUI();
}

async function stopSuperAgentPortsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawPorts = params.get("stopSuperAgentPorts");
  if (!rawPorts) return;
  params.delete("stopSuperAgentPorts");
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", nextUrl);

  const ports = rawPorts
    .split(",")
    .map((port) => Number(port))
    .filter((port) => Number.isFinite(port) && port > 0 && port !== getCurrentPort());
  if (ports.length === 0) return;

  await Promise.all(
    ports.map((port) =>
      transport.stopInstance(port).catch((error) => {
        console.warn(`[SuperAgent] failed to stop pending instance on port ${port}:`, error);
      }),
    ),
  );
  await pollInstances().catch(() => {});
}

// UI elements
const messageInput = document.getElementById("message-input");
const chatForm = document.getElementById("chat-form");
const sessionUiState = new SessionUiStateStore({
  profileClient: {
    load: () => transport.loadSessionUiProfile(wsClient.sessionId),
    save: (profile) => transport.saveSessionUiProfile(wsClient.sessionId, profile),
  },
});
let activeUiSessionFile = null;
// Monotonic counter bumped whenever restoreSessionUiState binds a different
// session. applySessionUiProfile captures it before each await and bails when
// the token changes, so a profile restore that resumes after the user has
// switched sessions cannot clobber the new session's model/thinking display.
let uiSessionGeneration = 0;
const sendBtn = document.getElementById("send-btn");
setButtonIcon(sendBtn, "send", { size: 16 });
const abortBtn = document.getElementById("abort-btn");
setButtonIcon(abortBtn, "square", { size: 16, filled: true });
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const skillSlashMenu = document.getElementById("skill-slash-menu");
const atFileMentionMenu = document.getElementById("at-file-mention-menu");

setupSkillSlashCommand({
  input: messageInput,
  container: skillSlashMenu,
  loadSkills: async () => {
    const response = await rpcCommand({ type: "list_skills" }, null, true);
    if (!response?.success) {
      throw new Error(response?.error || "Failed to load skills");
    }
    return response.data?.skills || [];
  },
});

// @-file mention completion must be wired before the main Enter-to-send
// listener (registered later) so its keydown can intercept Enter/Tab/Escape.
setupAtFileMention({
  input: messageInput,
  container: atFileMentionMenu,
  getWorkspaceRoot: () => getCurrentWorkspacePath(),
  searchFiles: async (workspaceRoot, query, signal) => {
    const response = await fetch(
      `/api/file-mentions?workspaceRoot=${encodeURIComponent(workspaceRoot)}&query=${encodeURIComponent(query)}`,
      { signal },
    );
    if (!response.ok) throw new Error(`File mention search failed: ${response.status}`);
    return response.json();
  },
});

function insertTaskPrompt(task) {
  if (!task) return;
  const draft = messageInput.value.trim();
  messageInput.value = `${buildTaskComposerPrompt(task)}${draft ? `\n${draft}` : ""}`;
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
  messageInput.focus();
}
const openFolderBtn = document.getElementById("open-folder-btn");
setButtonIcon(openFolderBtn, "folder-plus", { size: 16 });
const sidebarEl = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
setButtonIcon(sidebarToggle, "menu", { size: 16 });
const sidebarOverlay = document.getElementById("sidebar-overlay");

const refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
const sessionSearchInput = document.getElementById("session-search-input");
const sessionSearchClearBtn = document.getElementById("session-search-clear");
const sessionSearchOverlay = document.getElementById("session-search-overlay");
const sessionSearchDialog = document.getElementById("session-search-dialog");
const sessionSearchDialogInput = document.getElementById("session-search-dialog-input");
const sessionSearchResults = document.getElementById("session-search-results");
setButtonIcon(sessionSearchClearBtn, "x", { size: 12 });
const typingIndicator = document.getElementById("typing-indicator");

const sessionCostEl = document.getElementById("session-cost");
const sessionUsageEl = document.getElementById("session-usage");
const tokenUsageEl = document.getElementById("token-usage");
setButtonIcon(refreshSessionsBtn, "refresh-cw", { size: 16 });
setButtonIcon(document.getElementById("quick-chat-btn"), "message-circle", { size: 16 });
const _scrollBottomBtn = document.getElementById("scroll-bottom-btn"); // hidden legacy stub, unused
const scrollBottomBadge = document.getElementById("scroll-bottom-badge");
for (const target of [
  scrollBottomBadge?.querySelector(".scroll-bottom-badge-icon"),
  document.querySelector("#scroll-bottom-btn .scroll-bottom-icon"),
]) {
  const icon = createIcon("arrow-down", {
    size: target === scrollBottomBadge?.querySelector(".scroll-bottom-badge-icon") ? 10 : 16,
  });
  if (target && icon) target.replaceChildren(icon);
}
const _scrollPrevBtn = document.getElementById("scroll-prev-btn"); // hidden legacy stub, unused
const convNavEl = document.getElementById("conv-nav");
const convNavTrack = document.getElementById("conv-nav-track");

const convNavTooltip = document.getElementById("conv-nav-tooltip");
const convNavTooltipQ = document.getElementById("conv-nav-tooltip-q");
const convNavTooltipA = document.getElementById("conv-nav-tooltip-a");
const convNavTooltipSep = document.getElementById("conv-nav-tooltip-sep");
const messagesContainer = document.getElementById("messages");

// Reparent the nav tooltip to <body> so it escapes the main panel's stacking
// context — otherwise the side-chat and file-browser panels render above it.
if (convNavTooltip.parentElement && convNavTooltip.parentElement !== document.body) {
  document.body.appendChild(convNavTooltip);
}
const mainContainer = document.querySelector(".main");
const headerEl = document.querySelector(".header");
const inputAreaEl = document.querySelector(".input-area");

headerEl?.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest("button, a, input, select, textarea, [role=button]")) return;
  window.__TAURI__?.window?.getCurrentWindow().startDragging();
});

setupMessagesInsets({
  main: mainContainer,
  messages: messagesContainer,
  header: headerEl,
  inputArea: inputAreaEl,
});

// Mirror the rpiv-todo extension's `todo` tool reducer onto a native panel
// above the composer. The panel is empty (and display:none) when no todo
// snapshot has been seen.
const todoMirrorPanel = new RpivTodoMirrorPanel({ container: inputAreaEl });

// State tracking
let currentStreamingElement = null;
let currentStreamingText = "";
// True while pi's auto-retry is re-hitting the same model after a transient
// error (429/overload/5xx). During this window the session stays bound to the
// failing model, so switching models won't take effect until the stuck run is
// aborted. Tracked from `auto_retry_start` / `auto_retry_end` events.
let isAutoRetrying = false;
// True when the most recent assistant turn ended with stopReason "error"
// (e.g. a rate-limit 429). Cleared once a fresh run starts or succeeds.
let lastTurnErrored = false;
let lastInputTokens = 0;
let contextWindowSize = 0; // fetched from model info
const originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let contextVizController = null;
const compactCoordinator = createCompactCoordinator({
  // An RPC acknowledgement only confirms dispatch. Keep status ownership with
  // the lifecycle coordinator rather than briefly reporting it as completed.
  send: () => rpcCommand({ type: "compact" }, undefined, true),
  onState: () => syncCompactControls(),
});
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Picot instances [{port, sessionFile, cwd}]
let workspaceLaunchInProgress = false;
// When true, the next foreground message lifecycle events should reload the
// sidebar until the newly persisted session file appears in the list.
let pendingNewSessionRefresh = false;
let pendingNewSessionPreviousFile = null;
// When set while streaming, holds the session filePath to switch to once the
// current agent run ends. The history is rendered immediately; pi gets the
// switch_session RPC only after agent_end so the running call is not aborted.
let pendingSessionSwitchPath = null;
// A cross-workspace session switch replaces the embedded server's active
// workspace asynchronously. Keep the requested root until its post-switch
// mirror snapshot confirms that the new session is active; loading it earlier
// asks the old server to read a path outside its workspace and returns 403.
let pendingFileBrowserWorkspace = null;
let sessionsLoaded = false;
// Serializes handleSessionSelect: the function is a long async sequence that
// mutates shared routing state (foregroundPort, mirrorActiveSessionFile,
// viewingActiveSession, pendingSessionSwitchPath). Two overlapping invocations
// (fast double-click on different sessions) would interleave their awaits and
// corrupt that state, so a second call queues behind the first.
let sessionSelectChain = Promise.resolve();
let deferredMirrorSync = null;
// A selection may render its saved JSONL before its pi process has completed a
// switch. Ignore the old process's same-port snapshot until it confirms the
// selected session, otherwise it clobbers the restored history (and its
// multi-turn navigator) with stale entries.
let pendingMirrorSessionFile = null;
// A fork's composer prefill, deferred until the post-fork mirror_sync has
// rebound activeUiSessionFile to the forked session file. Applying it right
// after the fork ack would be wiped by that snapshot's restoreSessionUiState
// (the new file's saved draft is empty), and persisting then would write the
// text into the pre-fork session's draft. previousSessionFile guards against
// consuming the prefill on an unrelated same-session snapshot.
let pendingPostSyncComposer = null;
// Set when a live Info-tree append failed (no cache / unknown parent /
// recalibration due); agent_end then falls back to a full get_session_tree
// sync instead of one per turn unconditionally.
let infoTreeDirty = false;
let lastRenderedWelcomeWorkspacePath = null;
// Maps port -> sessionFile for each pi process we're tracking
const portSessionMap = new Map();
// Maps port -> { taskId, superAgentPort, title } for dispatched Super Agent tasks
const dispatchedTasks = new Map();
// The port that wsClient is currently connected to (the "foreground" session)
let foregroundPort = getCurrentPort();
let foregroundWorkspacePath = "";
const getActivePort = () => foregroundPort;
function logSessionRoute(label, details = {}) {
  console.debug(`[Session route] ${label}`, {
    foregroundPort,
    activeSessionFile: sidebar?.activeSessionFile || null,
    mirrorActiveSessionFile,
    viewingActiveSession,
    isStreaming: state?.isStreaming,
    wsSessionId: wsClient?.sessionId || null,
    wsSourcePort: wsClient?.sourcePort || null,
    ...details,
  });
}
wsClient.setRoutingContext({
  workspaceId: `workspace:${getCurrentWorkspacePath() || "unknown"}`,
  sourcePort: foregroundPort,
});

const workspaceIndicatorEl = document.createElement("div");
workspaceIndicatorEl.id = "workspace-indicator";
workspaceIndicatorEl.className = "pill workspace-indicator hidden";
workspaceIndicatorEl.title = "";
document
  .querySelector(".header-right")
  ?.insertBefore(workspaceIndicatorEl, document.querySelector("#context-viz"));

const gitBranchEl = document.createElement("div");
gitBranchEl.id = "git-branch-indicator";
gitBranchEl.className = "pill git-branch-indicator hidden";
gitBranchEl.title = t("git.currentBranch");
const gitBranchIcon = createIcon("git-info", { size: 14 });
if (gitBranchIcon) gitBranchEl.append(gitBranchIcon);
const gitBranchLabel = document.createElement("span");
gitBranchEl.append(gitBranchLabel);
document
  .querySelector(".header-right")
  ?.insertBefore(gitBranchEl, document.querySelector("#context-viz"));

function updateGitBranchIndicator(branch = "") {
  const name = typeof branch === "string" ? branch.trim() : "";
  if (!name) {
    gitBranchEl.classList.add("hidden");
    gitBranchLabel.textContent = "";
    return;
  }
  gitBranchEl.classList.remove("hidden");
  gitBranchLabel.textContent = name;
  gitBranchEl.title = t("git.branchName", { name });
}

async function refreshGitBranch() {
  try {
    const params = new URLSearchParams();
    if (typeof foregroundPort === "number" && Number.isFinite(foregroundPort)) {
      params.set("foregroundPort", String(foregroundPort));
    }
    const res = await fetch(`/api/git-branch${params.size ? `?${params.toString()}` : ""}`);
    if (!res.ok) {
      updateGitBranchIndicator("");
      return;
    }
    const data = await res.json();
    updateGitBranchIndicator(data?.branch || "");
  } catch {
    updateGitBranchIndicator("");
  }
}

function updateWorkspaceIndicator(path = "") {
  const normalizedPath = typeof path === "string" ? path.trim() : "";
  if (!normalizedPath) {
    workspaceIndicatorEl.classList.add("hidden");
    workspaceIndicatorEl.textContent = "";
    workspaceIndicatorEl.title = "";
    if (typeof refreshHeaderOpenAppButton === "function") refreshHeaderOpenAppButton();
    return;
  }
  workspaceIndicatorEl.classList.remove("hidden");
  workspaceIndicatorEl.textContent = normalizedPath;
  workspaceIndicatorEl.title = normalizedPath;
  if (typeof refreshHeaderOpenAppButton === "function") refreshHeaderOpenAppButton();
}

function syncWorkspaceIndicatorFromInstances() {
  const workspacePath = getWorkspacePathForPort(liveInstances, foregroundPort);
  if (workspacePath) foregroundWorkspacePath = workspacePath;
  updateWorkspaceIndicator(workspacePath || foregroundWorkspacePath);
  updateSuperAgentActiveStateFromWorkspace();
  refreshFileBrowserForWorkspace(workspacePath || foregroundWorkspacePath);
  refreshGitBranch();
}

function getCurrentWorkspacePath() {
  return getWorkspacePathForPort(liveInstances, foregroundPort) || foregroundWorkspacePath;
}

function workspacePathFromId(workspaceId) {
  if (typeof workspaceId !== "string") return "";
  return workspaceId.startsWith("workspace:") ? workspaceId.slice("workspace:".length) : "";
}

function renderWorkspaceWelcome({ force = false } = {}) {
  const workspacePath = getCurrentWorkspacePath();
  const welcomeVisible = Boolean(document.querySelector(".welcome"));
  if (!force && welcomeVisible && lastRenderedWelcomeWorkspacePath === workspacePath) {
    return;
  }
  messageRenderer.renderWelcome({ workspacePath });
  lastRenderedWelcomeWorkspacePath = workspacePath;
}

function hasAnySessionsLoaded() {
  return (
    Array.isArray(sidebar.projects) &&
    sidebar.projects.some(
      (project) => Array.isArray(project.sessions) && project.sessions.length > 0,
    )
  );
}

function setWorkspaceLaunchInProgress(inProgress) {
  workspaceLaunchInProgress = inProgress;
  if (openFolderBtn) {
    openFolderBtn.disabled = inProgress;
    openFolderBtn.setAttribute("aria-busy", inProgress ? "true" : "false");
    openFolderBtn.title = inProgress ? "Opening workspace..." : "Open folder as workspace";
  }
}

// File browser
const fileSidebar = document.getElementById("file-sidebar");
const fileSidebarToggle = document.getElementById("file-sidebar-toggle");
setButtonIcon(fileSidebarToggle, "panel-right", { size: 16 });
const fileSidebarClose = document.getElementById("file-sidebar-close");
const fileSidebarUp = document.getElementById("file-sidebar-up");
const fileSidebarRefresh = document.getElementById("file-sidebar-refresh");
const fileSidebarToggleHidden = document.getElementById("file-sidebar-toggle-hidden");
const infoPanelRefresh = document.getElementById("info-panel-refresh");
const gitPanelRefresh = document.getElementById("git-panel-refresh");
const fileSidebarFinder = document.getElementById("file-sidebar-finder");
for (const [button, iconName, size] of [
  [fileSidebarClose, "x", 16],
  [fileSidebarUp, "arrow-up", 16],
  [fileSidebarRefresh, "refresh-cw", 16],
  [fileSidebarToggleHidden, "eye", 16],
  [infoPanelRefresh, "refresh-cw", 16],
  [gitPanelRefresh, "refresh-cw", 16],
  [fileSidebarFinder, "folder-open", 16],
  [document.getElementById("lan-qr-modal-close"), "x", 14],
  [document.getElementById("config-editor-close"), "x", 14],
]) {
  if (button) setButtonIcon(button, iconName, { size });
}
const fileSidebarInfoTab = document.getElementById("file-sidebar-info-tab");
const fileSidebarFilesTab = document.getElementById("file-sidebar-files-tab");
const fileSidebarGitTab = document.getElementById("file-sidebar-git-tab");
for (const [tab, iconName] of [
  [fileSidebarInfoTab, "circle-info"],
  [fileSidebarFilesTab, "folder"],
  [fileSidebarGitTab, "git-info"],
]) {
  const iconHost = tab?.querySelector(".file-sidebar-tab-icon");
  const icon = createIcon(iconName, { size: 14 });
  if (iconHost && icon) iconHost.replaceChildren(icon);
}
const fileList = document.getElementById("file-list");
const fileSidebarPath = document.getElementById("file-sidebar-path");
const gitPanelElement = document.getElementById("git-panel");
const gitClient = new GitClient({
  send: (message) => {
    if (wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN) {
      wsClient.ws.send(JSON.stringify(message));
    }
  },
});
let latestGitDiffRequest = null;
let latestGitDiffDescriptor = null;
const gitPanel = new GitPanel({
  container: gitPanelElement,
  fileList,
  client: gitClient,
  openDiff: (entry) => filePreviewPanel.openDiff?.(entry),
  onDiffRequest: (requestId, descriptor) => {
    latestGitDiffRequest = requestId;
    latestGitDiffDescriptor = descriptor || null;
  },
});
const syncFileSidebarHiddenToggle = (showHidden) => {
  fileSidebarToggleHidden?.setAttribute("aria-pressed", String(showHidden));
};
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, {
  onFileSelect: (filePath, metadata) => {
    void filePreviewPanel.openFile(filePath, metadata);
  },
  onShowHiddenChange: syncFileSidebarHiddenToggle,
});
setupResizablePanel(fileSidebar, {
  storageKey: "pi-studio-file-sidebar-width",
  defaultWidth: 360,
  minWidth: 280,
  maxWidth: 560,
});
const sideChatButton = document.getElementById("side-chat-btn");
const syncSideChatButton = ({ panelOpen, activeContent } = {}) => {
  const active = panelOpen === true && activeContent?.kind === "transient";
  sideChatButton?.setAttribute("aria-pressed", String(active));
};
const filePreviewPanel = new FilePreviewPanel({
  panel: document.getElementById("file-preview-panel"),
  resizer: document.getElementById("file-preview-resizer"),
  tabBar: document.getElementById("file-preview-tabs"),
  content: document.getElementById("file-preview-content"),
  mainContainer: document.querySelector(".main"),
  onStateChange: syncSideChatButton,
  onOpenDesktop: (filePath) => {
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
  },
});
// Follow the agent's write-tool calls so the preview panel hot-reloads the
// file on disk (HTML iframes pick up edits without manual reopening).
// A burst of write tools (multi-file apply_patch, several writes in one
// turn) coalesces into one sidebar listing reload; only refresh a listing
// that is already rendered so a never-opened browser is not force-loaded.
let fileBrowserWorkspacePath = null;
let fileBrowserWorkspacePort = null;
let fileBrowserRefreshTimer = null;

function cancelFileBrowserRefresh() {
  if (fileBrowserRefreshTimer) {
    clearTimeout(fileBrowserRefreshTimer);
    fileBrowserRefreshTimer = null;
  }
}

function scheduleFileBrowserRefresh() {
  if (!fileBrowser.currentPath) return;
  if (
    shouldSuppressFileBrowserRefresh({
      pendingWorkspace: pendingFileBrowserWorkspace,
      currentWorkspacePath: getCurrentWorkspacePath(),
      fileBrowserWorkspacePath,
      currentPort: getCurrentPort(),
      fileBrowserWorkspacePort,
    })
  ) {
    return;
  }
  cancelFileBrowserRefresh();
  fileBrowserRefreshTimer = setTimeout(() => {
    fileBrowserRefreshTimer = null;
    if (!fileBrowser.currentPath) return;
    if (
      shouldSuppressFileBrowserRefresh({
        pendingWorkspace: pendingFileBrowserWorkspace,
        currentWorkspacePath: getCurrentWorkspacePath(),
        fileBrowserWorkspacePath,
        currentPort: getCurrentPort(),
        fileBrowserWorkspacePort,
      })
    ) {
      return;
    }
    fileBrowser.refresh().catch(() => {});
  }, 500);
}
const filePreviewFollow = createFilePreviewFollow({
  panel: filePreviewPanel,
  getWorkspacePath: async () => getCurrentWorkspacePath() || "",
  onWriteApplied: (rawPath) => {
    scheduleFileBrowserRefresh();
    state.addTurnWrite(rawPath);
  },
});

// ── Ephemeral chats (Side Chat + Quick Chat) + window close coordination ─────
function confirmEphemeralDiscard(_risks, _reason) {
  // Minimal confirmation; the full localized summary dialog lives in the close
  // coordinator for window close. Per-chat close uses this lightweight gate.
  return Promise.resolve(window.confirm(t("ephemeral.confirmDiscard")) ? "discard" : "cancel");
}

function showCloseSummaryDialog(_risk) {
  return Promise.resolve(window.confirm(t("ephemeral.confirmCloseSummary")) ? "discard" : "cancel");
}

const createEphemeralView = (runtime) =>
  new EphemeralChatView({
    runtime,
    kind: runtime.kind,
    toolsEnabled: runtime.kind === "side-chat",
    // Ephemeral chats share the window's owner workspace (served by the
    // main-session Pi), never the Quick Chat temporary cwd.
    getWorkspaceRoot: () => getCurrentWorkspacePath(),
  });

async function getActiveSessionStartupProfile() {
  if (!activeUiSessionFile) return null;
  const profile = await sessionUiState.loadProfile();
  if (profile) return profile;
  const model = availableModels.find((entry) => entry.id === currentModelId);
  if (!model?.provider || !model?.id) return null;
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: currentThinkingLevel || "off",
  };
}

const sideChatManager = new SideChatManager({
  transport,
  filePreviewPanel,
  confirmDiscard: confirmEphemeralDiscard,
  createView: createEphemeralView,
  getStartupProfile: getActiveSessionStartupProfile,
});
const quickChatDialog = new QuickChatDialog({
  transport,
  dialogRoot: document.getElementById("quick-chat-dialog-root"),
  chipRoot: document.getElementById("quick-chat-chip-root"),
  boundsElement: document.querySelector(".main"),
  confirmDiscard: confirmEphemeralDiscard,
  createView: createEphemeralView,
});
const windowCloseCoordinator = new WindowCloseCoordinator({
  transport,
  showSummaryDialog: showCloseSummaryDialog,
});
windowCloseCoordinator.registerParticipant("file", filePreviewPanel);
windowCloseCoordinator.registerParticipant("side", sideChatManager);
windowCloseCoordinator.registerParticipant("quick", quickChatDialog);

// ── Terminal panel (native owner only) ──────────────────────────────────────
// The host owns every PTY; the WebView owns xterm rendering. The panel is gated
// on native capability, so LAN/mobile clients render no terminal surface.
const terminalPreferences = new TerminalPreferences();
const savedTerminalPreferences = terminalPreferences.load();
const terminalFontSize = Number.isFinite(savedTerminalPreferences.fontSize)
  ? Math.min(32, Math.max(10, savedTerminalPreferences.fontSize))
  : DEFAULT_TERMINAL_FONT_SIZE;
const terminalClient = new TerminalClient({
  send: (envelope) => {
    if (wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN) {
      try {
        wsClient.ws.send(JSON.stringify(envelope));
      } catch (err) {
        console.warn("[terminal] send failed:", err);
      }
    }
  },
  createTab: (terminalId, generation) =>
    new TerminalTab({
      terminalId,
      generation,
      container: terminalPanel.getTabContainer(terminalId),
      terminalFactory: () =>
        new globalThis.PicotXterm.Terminal({
          fontFamily: TERMINAL_FONT_STACK,
          fontSize: terminalFontSize,
          fontWeight: 400,
        }),
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: terminalFontSize,
      loadFont: () =>
        loadTerminalFont({
          family: TERMINAL_FONT_FAMILY,
          fontSize: terminalFontSize,
        }),
      fitAddonFactory: () => new globalThis.PicotXterm.FitAddon(),
      serializeAddonFactory: () => new globalThis.PicotXterm.SerializeAddon(),
      sendInput: (id, gen, b64) =>
        terminalClient.command({
          type: "terminal_input",
          terminalId: id,
          generation: gen,
          dataBase64: b64,
        }),
      sendResize: (id, gen, cols, rows) =>
        terminalClient.command({
          type: "terminal_resize",
          terminalId: id,
          generation: gen,
          cols,
          rows,
        }),
    }),
});
const terminalPanel = new TerminalPanel({
  native: nativeAvailable(),
  subscribeLocale: onLocaleChange,
  getAvailableHeight: () =>
    document.querySelector(".workspace")?.clientHeight ||
    document.querySelector(".workspace-content")?.clientHeight ||
    600,
  client: {
    create: (profileId) => terminalClient.command({ type: "terminal_create", profileId }),
    close: (id, gen) =>
      terminalClient.command({ type: "terminal_close", terminalId: id, generation: gen }),
    restart: (id, gen, profileId) =>
      terminalClient.command({
        type: "terminal_restart",
        terminalId: id,
        generation: gen,
        profileId,
      }),
    focusTab: (id) => terminalClient.tabs.get(id)?.tab?.focus?.(),
    refitTab: (id) => terminalClient.tabs.get(id)?.tab?.refit?.(),
    refitAll: () => {
      for (const entry of terminalClient.tabs.values()) entry.tab?.refit?.();
    },
    setPanelHeight: (height) =>
      terminalClient.command({ type: "terminal_set_panel_height", heightPx: height }),
    checkpointAll: async () => {
      const pending = [];
      for (const [id, entry] of terminalClient.tabs) {
        const serialized = entry.tab.serializeForCheckpoint?.(2000);
        if (!serialized) continue;
        pending.push(
          terminalClient.sendAndAwait(
            {
              type: "terminal_checkpoint",
              terminalId: id,
              generation: entry.generation,
              watermark: entry.lastAppliedSequence,
              snapshotBase64: encodeTerminalBase64(new TextEncoder().encode(serialized)),
            },
            (msg) => msg.type === "terminal_checkpoint_acked" && msg.terminalId === id,
          ),
        );
      }
      const results = await Promise.all(pending);
      if (results.some((result) => result === null)) {
        throw new Error("terminal checkpoint timed out");
      }
    },
    closeAll: async () => {
      const ids = [...terminalClient.tabs.keys()];
      // Await each host-acknowledged close (terminal_closed) instead of polling
      // the local cache; a timeout resolves null so Rust kill_owner still wins.
      const results = await Promise.all(
        ids.map(async (id) => {
          const entry = terminalClient.tabs.get(id);
          if (!entry) return null;
          return terminalClient.sendAndAwait(
            { type: "terminal_close", terminalId: id, generation: entry.generation },
            (msg) => msg.type === "terminal_closed" && msg.terminalId === id,
          );
        }),
      );
      if (results.some((result) => result === null)) {
        throw new Error("terminal close timed out");
      }
      terminalClient.reset();
      terminalPanel.setTabs([]);
    },
  },
});
// The panel is mounted only after the broker confirms native capability:
// `transport.capabilities.native` is false before the WS handshake completes,
// so mounting at module top would skip it on the desktop. The event listeners
// are registered once; only the DOM mount is gated on the capability.
function mountTerminalPanelIfNative() {
  if (!nativeAvailable() || terminalPanel.toggleEl) {
    return;
  }
  const workspaceEl = document.querySelector(".workspace") || document.body;
  const headerEl = document.querySelector(".workspace .header") || workspaceEl;
  const toolbarEl = headerEl.querySelector(".header-right") || headerEl;
  const sideChatToggle = toolbarEl.querySelector("#side-chat-btn");
  const fileSidebarToggle = toolbarEl.querySelector("#file-sidebar-toggle");
  if (sideChatToggle && fileSidebarToggle) {
    toolbarEl.insertBefore(sideChatToggle, fileSidebarToggle);
  }
  terminalPanel.native = true;
  terminalPanel.mount({ toggleContainer: toolbarEl, panelContainer: workspaceEl });
  if (fileSidebarToggle && terminalPanel.toggleEl) {
    toolbarEl.insertBefore(terminalPanel.toggleEl, fileSidebarToggle);
  }
  windowCloseCoordinator.registerParticipant("terminal", terminalPanel);
}
wsClient.addEventListener("terminalEvent", (event) => {
  const msg = event.detail || {};
  // Async PTY events arrive wrapped in a `terminal_event` envelope.
  if (msg.type === "terminal_event") {
    const payload = msg.payload || {};
    if (payload.type === "terminal_output") {
      terminalClient.applyOutput(payload);
      terminalPanel.markActivity(payload.terminalId);
    } else if (payload.type === "terminal_exited" || payload.type === "terminal_failed") {
      terminalClient.removeTab(payload.terminalId, payload.generation);
      terminalClient.command({ type: "terminal_list" });
    }
    return;
  }
  // Synchronous command responses (terminal_created/listed/closed/...).
  terminalClient.resolveResponse(msg);
  if (msg.type === "terminal_listed") {
    terminalClient.applyListed(msg);
    terminalPanel.setTabs(
      (msg.tabs || []).map((tab) => ({
        terminalId: tab.terminalId,
        generation: tab.generation,
        label: tab.label,
        profileId: tab.profileId,
        status: tab.status,
        historyGap: tab.historyGap,
        failReason: tab.failReason,
      })),
    );
    if (Number.isFinite(msg.panelHeightPx)) {
      terminalPanel.setHeight(msg.panelHeightPx);
    }
  } else if (
    msg.type === "terminal_created" ||
    msg.type === "terminal_restarted" ||
    msg.type === "terminal_closed"
  ) {
    terminalClient.command({ type: "terminal_list" });
  }
});
wsClient.addEventListener("terminalCommandFailed", (event) => {
  const message = event.detail?.error;
  const commandType = terminalClient.consumeCommandType(event.detail?.requestId);
  console.warn("[terminal] command failed:", event.detail);
  if (
    (commandType === "terminal_create" || commandType === "terminal_restart") &&
    typeof message === "string" &&
    message
  ) {
    terminalPanel.showStartError?.(formatTerminalStartError(message));
  }
  terminalClient.requestList();
});
mountTerminalPanelIfNative();

async function prepareEphemeralWorkspaceTransition() {
  quickChatDialog.setInteractionLocked(true);
  filePreviewPanel.setInteractionLocked(true);
  try {
    const accepted = await sideChatManager.prepareWorkspaceTransition();
    if (accepted) {
      sideChatManager.setInteractionLocked(true);
      await terminalPanel.beforeWorkspaceTransition?.();
    } else {
      quickChatDialog.setInteractionLocked(false);
      filePreviewPanel.setInteractionLocked(false);
    }
    return accepted;
  } catch (error) {
    sideChatManager.setInteractionLocked(false);
    quickChatDialog.setInteractionLocked(false);
    filePreviewPanel.setInteractionLocked(false);
    throw error;
  }
}

function cancelEphemeralWorkspaceTransition() {
  sideChatManager.setInteractionLocked(false);
  quickChatDialog.setInteractionLocked(false);
  filePreviewPanel.setInteractionLocked(false);
  terminalPanel.cancelWorkspaceTransition?.();
}

wsClient.addEventListener("ownerBootstrap", async (event) => {
  if (!nativeAvailable()) return;
  // The host advertises the current workspace generation; terminal commands
  // carry it as a compare-only attachment token (broker rejects a mismatch).
  if (typeof event.detail?.workspaceGeneration === "number") {
    terminalClient.setWorkspaceGeneration(event.detail.workspaceGeneration);
    gitClient.setWorkspaceGeneration(event.detail.workspaceGeneration);
    // Clear stale diff/AI/commit state so late responses from the previous
    // workspace cannot leak into the new one.
    latestGitDiffRequest = null;
    latestGitDiffDescriptor = null;
    gitPanel.aiSnapshot = null;
    gitPanel.commitMessage = "";
    gitPanel.pendingConfirmationToken = null;
    gitPanel.notGitRepo = false;
    gitPanel.gitUnavailable = false;
    if (!gitPanelElement.classList.contains("hidden")) void gitPanel.refresh();
    if (terminalPanel.toggleEl) terminalClient.requestList();
  }
  try {
    const advertised = event.detail?.instances;
    const instances = Array.isArray(advertised)
      ? advertised
      : (await transport.getEphemeralBootstrap()) || [];
    sideChatManager.rebind(instances.filter((d) => d.kind === "side-chat"));
    const quick = instances.find((d) => d.kind === "quick-chat");
    if (quick) quickChatDialog.rebind(quick);
  } catch (err) {
    console.warn("[ephemeral] bootstrap fetch failed:", err);
  }
});
// Unified generation guard: every async Git response (status, AI, commit, diff,
// confirmation, failure, and write acknowledgement) must match the current
// workspace generation. A late response from a previous workspace is silently
// dropped so it can never overwrite the current UI state.
const gitResponseMatchesGeneration = (detail) =>
  detail?.workspaceGeneration != null && gitClient.generation === detail.workspaceGeneration;
wsClient.addEventListener("gitStatus", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  gitPanel.setSnapshot(event.detail.snapshot);
  // A successful status probe proves this workspace is a Git repository, so
  // the Git entry is usable even if the workspace-info probe was inconclusive.
  syncGitTabVisibility(true);
});
wsClient.addEventListener("gitAiCommitMessage", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  // Out-of-order guard: a user can request AI twice in quick succession. The
  // older request may resolve after the newer one and would otherwise
  // overwrite the current dialog message and bound snapshot with stale data.
  if (event.detail?.requestId !== gitPanel.pendingAiRequestId) return;
  gitPanel.applyAiResult(event.detail?.snapshot, event.detail?.message);
});
wsClient.addEventListener("gitCommitConfirmationRequired", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  // A stale confirmation frame from commit A must not pollute the pending
  // token of the currently-active commit B.
  if (event.detail?.requestId !== gitPanel.pendingCommitRequestId) return;
  gitPanel.applyConfirmationToken(event.detail?.confirmationToken);
});
wsClient.addEventListener("gitCommitStarted", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  // A delayed started frame from a superseded commit must not flip the current
  // dialog back into the in-progress state.
  if (event.detail?.requestId !== gitPanel.pendingCommitRequestId) return;
  gitPanel.setCommitInProgress(true);
});
wsClient.addEventListener("gitDiff", (event) => {
  const requestId = event.detail?.requestId;
  const diff = event.detail?.diff;
  if (!diff || !requestId || requestId !== latestGitDiffRequest) return;
  if (!gitResponseMatchesGeneration(event.detail)) return;
  filePreviewPanel.openDiff({ ...latestGitDiffDescriptor, ...diff });
});
wsClient.addEventListener("gitCommitResult", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  // A result frame from commit A must never close or clear the dialog state
  // of a later commit B. Bind every result to the currently-pending request;
  // applyCommitResult clears pendingCommitRequestId on acceptance.
  if (event.detail?.requestId !== gitPanel.pendingCommitRequestId) return;
  gitPanel.applyCommitResult(event.detail);
  if (event.detail?.status === "succeeded") void gitPanel.refresh();
});
wsClient.addEventListener("gitCommandAck", (event) => {
  if (!gitResponseMatchesGeneration(event.detail)) return;
  if (!gitClient.consumeWriteAck(event.detail)) return;
  void gitPanel.refresh();
});
wsClient.addEventListener("gitCommandFailed", (event) => {
  console.warn("[git] command failed", event.detail);
  if (!gitResponseMatchesGeneration(event.detail)) return;
  gitClient.consumeWriteFailure(event.detail);
  // Only AI generation failure opens the commit dialog with an empty message so
  // the user can still write a commit message by hand.
  if (event.detail?.type === "git_ai_commit_message_failed") {
    // Out-of-order guard: ignore a stale AI failure that belongs to a request
    // the user has already superseded with a newer one.
    if (event.detail?.requestId !== gitPanel.pendingAiRequestId) return;
    gitPanel.applyAiFailure(event.detail?.error || t("git.aiFailed"));
    return;
  }
  // A commit failure (stale snapshot, hook rejection, invalid token) must end
  // the in-progress state so the dialog is retryable, with the error surfaced.
  if (event.detail?.requestId && event.detail.requestId === gitPanel.pendingCommitRequestId) {
    gitPanel.applyCommitFailure(event.detail?.error);
  }
  // A status probe against a non-repository workspace fails with git's
  // "not a git repository" error and never produces a git_status frame, so the
  // panel would otherwise sit on the generic "no status loaded" message.
  // Surface the real reason instead — but only for the current status probe,
  // never for stale or concurrent non-status failures.
  if (gitPanel.isStatusFailure(event.detail?.requestId)) {
    const error = typeof event.detail?.error === "string" ? event.detail.error : "";
    if (error === "git_not_found") {
      gitPanel.setGitUnavailable(true);
      syncGitTabVisibility(false);
    } else if (error.includes("not a git repository")) {
      gitPanel.setNotGitRepo(true);
      // The workspace is not a Git repository — remove the Git entry entirely
      // (and bounce out of the Git tab when it was active) instead of keeping a
      // dead panel that only renders the not-a-repository notice.
      syncGitTabVisibility(false);
    }
  }
});
wsClient.addEventListener("ephemeralEvent", (event) => {
  const { instanceId } = event.detail || {};
  const side = sideChatManager.chats.get(instanceId)?.runtime;
  if (side) {
    side.applySequencedEvent(event.detail);
    return;
  }
  if (quickChatDialog.runtime?.instanceId === instanceId) {
    quickChatDialog.runtime.applySequencedEvent(event.detail);
  }
});
wsClient.addEventListener("ephemeralCommandFailed", (event) => {
  const requestId = event.detail?.requestId;
  for (const chat of sideChatManager.chats.values()) {
    chat.runtime.handleCommandFailure(requestId);
  }
  quickChatDialog.runtime?.handleCommandFailure(requestId);
});
wsClient.addEventListener("windowCloseRequest", (event) => {
  windowCloseCoordinator.handleHostCloseRequest(event.detail?.requestId);
});

sideChatButton?.addEventListener("click", () => {
  if (nativeAvailable()) void sideChatManager.openMostRecent();
});
setButtonIcon(sideChatButton, "message-square", { size: 16 });
syncSideChatButton(filePreviewPanel);
document.getElementById("quick-chat-btn")?.addEventListener("click", () => {
  if (nativeAvailable()) void quickChatDialog.open();
});

async function refreshFileBrowserForWorkspace(
  path = getCurrentWorkspacePath(),
  { force = false } = {},
) {
  // During a cross-workspace session switch the embedded server is still
  // scoped to the previous workspace until the mirror snapshot confirms the
  // new session. Any workspace-scoped load in that window resolves the
  // requested path against the stale root and returns 403. Defer instead —
  // `handleMirrorSync` fires the authoritative load once the new server is
  // active (after clearing `pendingFileBrowserWorkspace`).
  if (shouldSuppressFileBrowserLoad(pendingFileBrowserWorkspace)) return true;
  const normalized = typeof path === "string" ? path.trim() : "";
  if (
    !force &&
    normalized === fileBrowserWorkspacePath &&
    getCurrentPort() === fileBrowserWorkspacePort
  ) {
    return true;
  }
  const switched = await filePreviewPanel.setWorkspaceRoot(normalized);
  if (!switched) return false;

  const workspaceChanged = normalized !== fileBrowserWorkspacePath;
  if (workspaceChanged) fileBrowser.setWorkspaceRoot(normalized);
  const isCollapsed = fileSidebar.classList.contains("collapsed");
  if (isCollapsed && !force) {
    fileBrowserWorkspacePath = normalized;
    fileBrowserWorkspacePort = getCurrentPort();
    return true;
  }
  // Let the active Pi resolve its own workspace root. Passing the previous
  // workspace path here races session transitions and produces 403 outsideWorkspace.
  await fileBrowser.load();
  fileBrowserWorkspacePath = normalized;
  fileBrowserWorkspacePort = getCurrentPort();
  return true;
}

fileSidebarRefresh?.addEventListener("click", () => void fileBrowser.refresh());
fileSidebarToggleHidden?.addEventListener("click", () => {
  void fileBrowser.setShowHidden(!fileBrowser.showHidden);
});
infoPanelRefresh?.addEventListener("click", () => void refreshInfoTree({ force: true }));
gitPanelRefresh?.addEventListener("click", () => void gitPanel.refresh());

fileSidebarToggle.addEventListener("click", () => {
  const isCollapsed = fileSidebar.classList.toggle("collapsed");
  fileSidebarToggle.setAttribute("aria-pressed", String(!isCollapsed));
  if (!isCollapsed) {
    refreshFileBrowserForWorkspace(getCurrentWorkspacePath(), { force: true });
  }
  localStorage.setItem("pi-studio-file-sidebar", isCollapsed ? "closed" : "open");
});

const FILE_SIDEBAR_TAB_STORAGE_KEY = "pi-studio-file-sidebar-tab";

function setFileSidebarTab(tab) {
  const showInfo = tab === "info";
  const showGit = tab === "git";
  fileSidebarInfoTab.classList.toggle("active", showInfo);
  fileSidebarInfoTab.setAttribute("aria-selected", String(showInfo));
  fileSidebarFilesTab.classList.toggle("active", !showInfo && !showGit);
  fileSidebarFilesTab.setAttribute("aria-selected", String(!showInfo && !showGit));
  fileSidebarGitTab.classList.toggle("active", showGit);
  fileSidebarGitTab.setAttribute("aria-selected", String(showGit));
  infoPanelEl.classList.toggle("hidden", !showInfo);
  fileSidebarPath.classList.toggle("hidden", showInfo || showGit);
  fileList.classList.toggle("hidden", showInfo || showGit);
  gitPanelElement.classList.toggle("hidden", !showGit);
  fileSidebarUp.classList.toggle("hidden", showInfo || showGit);
  fileSidebarRefresh.classList.toggle("hidden", showInfo || showGit);
  fileSidebarToggleHidden.classList.toggle("hidden", showInfo || showGit);
  infoPanelRefresh.classList.toggle("hidden", !showInfo);
  gitPanelRefresh.classList.toggle("hidden", !showGit);
  document.getElementById("file-sidebar-finder").classList.toggle("hidden", showInfo || showGit);
  if (showInfo) {
    infoPanel.updateWorkspace(getCurrentWorkspacePath());
    void refreshInfoTree();
    infoPanel.scrollToSelectedEntry();
  }
  localStorage.setItem(FILE_SIDEBAR_TAB_STORAGE_KEY, tab);
  if (showGit) {
    // Clear any stale snapshot from a previous workspace so the panel
    // never shows old data while waiting for a fresh status response.
    gitPanel.snapshot = null;
    gitPanel.notGitRepo = false;
    gitPanel.gitUnavailable = false;
    gitPanel.render();
    void gitPanel.refresh();
  }
}

// ── Git entry visibility ────────────────────────────────────────────
// Hide the file-sidebar Git tab for workspaces that are not Git
// repositories, so a non-Git project never shows a dead Git panel. The tab is
// driven by the authoritative, generation-guarded git status probe
// (gitStatus / git_command_failed on workspace entry and on open). The
// /api/workspace-info probe is only a seq-guarded fast-path hint: it hides the
// tab on an explicit non-Git answer and never forces the tab visible.
function syncGitTabVisibility(show) {
  fileSidebarGitTab?.classList.toggle("hidden", !show);
  // Bounce out of the Git tab when hiding it, so a non-Git workspace never
  // leaves the user staring at the empty panel.
  if (!show && fileSidebarGitTab?.getAttribute("aria-selected") === "true") {
    setFileSidebarTab("files");
  }
}

// Fast-path hint for the Git entry: when the workspace-info probe answers, it
// nudges the tab toward the right state, but it is never the source of truth.
// A non-OK / inconclusive probe leaves the tab as-is so the authoritative git
// status probe (gitPanel.refresh on workspace entry) decides. A stale response
// from a previous workspace (seq guard) must not re-show a just-hidden tab.
let gitEntryProbeSeq = 0;
async function syncGitEntryForWorkspace(workspaceId) {
  if (!workspaceId) return;
  const seq = ++gitEntryProbeSeq;
  try {
    const params = new URLSearchParams();
    params.set("workspaceId", workspaceId);
    const res = await fetch(`/api/workspace-info?${params.toString()}`);
    if (seq !== gitEntryProbeSeq) return; // superseded by a newer workspace
    const data = res.ok ? await res.json() : null;
    if (seq !== gitEntryProbeSeq) return;
    // Only an explicit non-Git answer hides the entry; anything inconclusive
    // (missing flag) defers to the git status probe.
    if (data && data.isGit === false) syncGitTabVisibility(false);
  } catch {
    // Failed fast-path: leave the tab alone; the git status probe drives it.
  }
}

/**
 * Expand the file sidebar and switch to the requested tab. Used by the
 * workspace-path and git-branch header pills so clicking them directly opens
 * the matching panel.
 *
 * The click is always an "open and focus" action — never a toggle. Even when
 * the sidebar was already open on the target tab we re-trigger the refresh
 * and flash the tab so the click is acknowledged rather than feeling inert.
 */
function openFileSidebarTab(tab) {
  fileSidebar.classList.remove("collapsed");
  fileSidebarToggle.setAttribute("aria-pressed", "true");
  localStorage.setItem("pi-studio-file-sidebar", "open");
  setFileSidebarTab(tab);
  if (tab === "files") {
    void refreshFileBrowserForWorkspace(getCurrentWorkspacePath(), { force: true });
  }
  flashSidebarTab(tab);
}

function flashSidebarTab(tab) {
  const el =
    tab === "info" ? fileSidebarInfoTab : tab === "git" ? fileSidebarGitTab : fileSidebarFilesTab;
  if (!el) return;
  el.classList.remove("flash-highlight");
  // Reflow restarts the animation so repeated clicks re-flash.
  void el.offsetWidth;
  el.classList.add("flash-highlight");
  el.addEventListener("animationend", () => el.classList.remove("flash-highlight"), { once: true });
}

workspaceIndicatorEl.addEventListener("click", () => openFileSidebarTab("files"));
gitBranchEl.addEventListener("click", () => openFileSidebarTab("git"));

fileSidebarInfoTab.addEventListener("click", () => setFileSidebarTab("info"));
fileSidebarFilesTab.addEventListener("click", () => setFileSidebarTab("files"));
fileSidebarGitTab.addEventListener("click", () => setFileSidebarTab("git"));

fileSidebarClose.addEventListener("click", () => {
  fileSidebar.classList.add("collapsed");
  fileSidebarToggle.setAttribute("aria-pressed", "false");
  localStorage.setItem("pi-studio-file-sidebar", "closed");
});

fileSidebarUp.addEventListener("click", () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

document.getElementById("file-sidebar-finder").addEventListener("click", () => {
  if (fileBrowser.currentPath) {
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// ═══════════════════════════════════════
// "Open workspace in app" header control (VS Code / Cursor / Terminal / …)
// Mirrors the Codex-style split button in the chat header.
// ═══════════════════════════════════════
// Shared controller for every "open workspace in app" surface: the header
// split-button AND the Info panel's Workspace rows. Per the Info panel design
// invariant, app list loading, icon/monogram fallback, selection persistence,
// and the launch call live in ONE place (workspace-actions.js). Header keeps
// only its own chrome: button refresh + the dropdown menu.
let infoPanel = null; // assigned below; callbacks here may fire first
const workspaceActions = createWorkspaceActionsController({
  transport,
  isNativeAvailable: () => nativeAvailable(),
  getWorkspacePath: getCurrentWorkspacePath,
  storageKey: "pi-studio-open-app",
  onSelectionChange: () => refreshHeaderOpenAppButton(),
  onAppsLoaded: () => {
    refreshHeaderOpenAppButton();
    infoPanel?.refreshApps();
  },
});
const headerOpenApp = {
  el: document.getElementById("header-open-app"),
  btn: document.getElementById("header-open-app-btn"),
  logo: document.getElementById("header-open-app-logo"),
  toggle: document.getElementById("header-open-app-toggle"),
  menu: document.getElementById("header-open-app-menu"),
};
setButtonIcon(headerOpenApp.toggle, "chevron-down", { size: 10 });

function getSelectedOpenApp() {
  return workspaceActions.getSelectedApp();
}

function refreshHeaderOpenAppButton() {
  if (!headerOpenApp.el) return;
  const hasNative = nativeAvailable();
  const path = getCurrentWorkspacePath();
  const selected = getSelectedOpenApp();
  if (!hasNative || !selected || !path || workspaceActions.apps.length === 0) {
    headerOpenApp.el.classList.add("hidden");
    return;
  }
  headerOpenApp.el.classList.remove("hidden");
  sharedPopulateAppLogo(headerOpenApp.logo, selected);
  headerOpenApp.btn.title = t("nav.openWorkspaceInNamedApp", { path, app: selected.label });
  headerOpenApp.btn.setAttribute(
    "aria-label",
    t("nav.openWorkspaceInAppAria", { app: selected.label }),
  );
}

async function openWorkspaceInApp(app) {
  // The shared controller owns selection persistence and the transport call.
  await workspaceActions.openWorkspaceInApp(app);
}

function closeHeaderOpenAppMenu() {
  if (headerOpenApp.menu) headerOpenApp.menu.classList.add("hidden");
}

function toggleHeaderOpenAppMenu() {
  if (!headerOpenApp.menu) return;
  if (!headerOpenApp.menu.classList.contains("hidden")) {
    closeHeaderOpenAppMenu();
    return;
  }
  headerOpenApp.menu.replaceChildren();
  for (const app of workspaceActions.apps) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "header-open-app-menu-item";
    if (app.id === workspaceActions.selectedId) row.classList.add("active");
    row.title = t("nav.openInApp", { app: app.label });
    row.setAttribute("aria-label", t("nav.openInApp", { app: app.label }));
    const logo = document.createElement("span");
    logo.className = "header-open-app-logo";
    logo.setAttribute("aria-hidden", "true");
    sharedPopulateAppLogo(logo, app);
    const label = document.createElement("span");
    label.textContent = app.label;
    row.append(logo, label);
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeHeaderOpenAppMenu();
      void openWorkspaceInApp(app);
    });
    headerOpenApp.menu.appendChild(row);
  }
  headerOpenApp.menu.classList.remove("hidden");
}

async function loadHeaderOpenApps() {
  // The shared controller loads, validates selection, and notifies listeners
  // (header refresh + Info panel row refresh).
  await workspaceActions.loadApps();
}

if (headerOpenApp.btn) {
  headerOpenApp.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void openWorkspaceInApp();
  });
}
if (headerOpenApp.toggle) {
  headerOpenApp.toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHeaderOpenAppMenu();
  });
}
document.addEventListener("click", () => closeHeaderOpenAppMenu());
void loadHeaderOpenApps();

// ═════════════════════════════════════
// Info panel (right column): workspace actions + Pi session tree
// ═════════════════════════════════════

const infoPanelEl = document.getElementById("info-panel");

/** Correlated request/response over the shared WS command channel. */
function wsRequest(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = wsClient.send(command);
    if (!requestId) {
      reject(new Error(t("errors.wsNotConnected")));
      return;
    }
    const timer = setTimeout(() => {
      wsClient.removeEventListener("commandResponse", onResp);
      reject(new Error(t("errors.requestTimeout")));
    }, timeoutMs);
    const onResp = (e) => {
      if (e.detail?.id !== requestId) return;
      clearTimeout(timer);
      wsClient.removeEventListener("commandResponse", onResp);
      if (e.detail.success === false) {
        reject(new Error(e.detail.error || t("errors.requestFailed")));
      } else {
        resolve(e.detail.data);
      }
    };
    wsClient.addEventListener("commandResponse", onResp);
  });
}

/** Authoritative light tree refresh (entries + leafId only, no chat re-render). */
async function refreshInfoTree({ force = false } = {}) {
  if (!infoPanel || !infoPanelEl || infoPanelEl.classList.contains("hidden")) return;
  if (wsClient.ws?.readyState !== 1) return;
  if (!force && !infoTreeDirty && infoPanel.entries) {
    // Cache is clean (hidden-tab mirror_sync skipped the rebuild; live
    // appends kept it current): re-render locally, no round trip. A local
    // re-render is not a sync — the staleness clock keeps running.
    infoPanel.rerenderTree();
    return;
  }
  // Snapshot the cache generation: an entry appended while this request is
  // in flight was persisted after the server read the tree — applying the
  // response would drop that row and chain the next append off a stale
  // leaf. Detect the race, discard the stale response, stay dirty.
  const generation = infoPanel.generation;
  try {
    const data = await wsRequest({ type: "get_session_tree" });
    if (infoPanel.generation !== generation) {
      infoTreeDirty = true;
      return;
    }
    infoPanel.updateTree({ entries: data?.entries, leafId: data?.leafId });
    infoTreeDirty = false;
  } catch (err) {
    // Non-fatal: the tree retries on the next session_tree event / sync.
    console.warn("[InfoPanel] tree refresh failed:", err);
  }
}

/** Resume an inactive branch: explicit Pi-native leaf switch, never a scroll. */
async function handleResumeBranch(entryId) {
  if (state.isStreaming) {
    messageRenderer.renderError(t("infoPanel.actionWhileStreaming"));
    return;
  }
  if (!canUseSessionControl()) {
    messageRenderer.renderError(t("infoPanel.actionDesktopOnly"));
    return;
  }
  try {
    await transport.navigateTree(entryId, { port: getActivePort() });
    // Pi emits session_tree; the event handler re-syncs chat + tree. Per the
    // design, resuming clears the composer (the old branch's draft belongs
    // to the old branch). The clear is programmatic (no input event), so
    // persist it or the pending session_tree snapshot's draft restore would
    // resurrect the stale draft.
    messageInput.value = "";
    messageInput.style.height = "auto";
    persistComposerDraft();
  } catch (err) {
    messageRenderer.renderError(t("errors.treeNavigateFailed", { error: err }));
  }
}

if (infoPanelEl) {
  infoPanel = new InfoPanel({
    panel: infoPanelEl,
    actions: workspaceActions,
    t,
    onNavigateLeaf: (entryId) => void handleResumeBranch(entryId),
    onSelectEntry: (entryId) => selectInfoEntry(entryId),
    isStreaming: () => state.isStreaming,
  });
}

// Restore file sidebar state
const fileSidebarIsOpen = localStorage.getItem("pi-studio-file-sidebar") === "open";
fileSidebarToggle.setAttribute("aria-pressed", String(fileSidebarIsOpen));
if (fileSidebarIsOpen) {
  fileSidebar.classList.remove("collapsed");
  // Restore the previously selected sidebar tab (Files or Git) so a reopen
  // after close returns to the view the user left on. Defaults to Files.
  setFileSidebarTab(
    localStorage.getItem(FILE_SIDEBAR_TAB_STORAGE_KEY) === "git"
      ? "git"
      : localStorage.getItem(FILE_SIDEBAR_TAB_STORAGE_KEY) === "info"
        ? "info"
        : "files",
  );
  if (!gitPanelElement.classList.contains("hidden")) {
    // setFileSidebarTab already requests Git status when the Git tab is
    // restored; for Files, refresh the browser as before.
  } else {
    refreshFileBrowserForWorkspace(getCurrentWorkspacePath(), { force: true });
  }
}

// Resizable sidebars — drag handle on inner edge, persisted to localStorage.
createSidebarResizer({
  sidebarEl,
  side: "left",
  storageKey: "picot-sidebar-width",
  minWidth: 200,
  maxWidth: 500,
});
createSidebarResizer({
  sidebarEl: fileSidebar,
  side: "right",
  storageKey: "picot-file-sidebar-width",
  minWidth: 200,
  maxWidth: 500,
});

// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener("focus", () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});

window.addEventListener("blur", () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log("[App] Returning to app, reconnecting...");
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Conversation navigator rail (Codex-style)
// ═══════════════════════════════════════

// Build the list of conversations: each entry is the user message el + its
// immediately following assistant message el (may be null mid-stream).
function getConversations() {
  const turns = [];
  let node = messagesContainer.firstElementChild;
  while (node) {
    if (node.classList?.contains("message") && node.classList.contains("user")) {
      const next = node.nextElementSibling;
      const reply =
        next?.classList?.contains("message") && next.classList.contains("assistant") ? next : null;
      turns.push({ user: node, assistant: reply });
    }
    node = node.nextElementSibling;
  }
  return turns;
}

// Returns the index of the conversation whose user-message is the topmost
// partially-visible one. The header floats above the scroller, so the true
// visible top is the header's bottom edge.
function getActiveConvIndex(turns) {
  if (_navLockedIdx >= 0 && _navLockedIdx < turns.length) return _navLockedIdx;
  const visibleTop = Math.max(
    messagesContainer.getBoundingClientRect().top,
    headerEl?.getBoundingClientRect().bottom || 0,
  );
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].user.getBoundingClientRect().top <= visibleTop + 4) return i;
  }
  return 0;
}

function flashJumpHighlight(target) {
  target.classList.remove("message-jump-highlight");
  void target.offsetWidth; // force reflow so re-triggering the animation replays
  target.classList.add("message-jump-highlight");
  target.addEventListener("animationend", () => target.classList.remove("message-jump-highlight"), {
    once: true,
  });
}

function selectInfoEntry(entryId, { scroll = false } = {}) {
  infoPanel?.selectEntry(entryId);
  if (scroll) infoPanel?.scrollToSelectedEntry();
}

function jumpToConversation(turn, idx) {
  // Lock active index immediately so dot highlights right away, even before
  // the smooth scroll settles (or if the scroll ends up being a no-op).
  if (idx !== undefined) {
    _navLockedIdx = idx;
    clearTimeout(_navLockTimer);
    _navLockTimer = setTimeout(() => {
      _navLockedIdx = -1;
      rebuildNavDots();
    }, 800);
  }
  // Use an explicit scrollTo instead of turn.user.scrollIntoView(): scrollIntoView's
  // "start" alignment is computed against the raw scroll container, not the space
  // the floating sticky header covers, and its target can land within a few px of
  // the current position (e.g. when only a couple of short conversations exist and
  // the max scroll range is tiny) — some webviews then silently skip the scroll
  // instead of nudging to it. Computing the delta ourselves guarantees a real,
  // header-aware scrollTo happens every time.
  const visibleTop =
    headerEl?.getBoundingClientRect().bottom || messagesContainer.getBoundingClientRect().top;
  const delta = turn.user.getBoundingClientRect().top - visibleTop;
  const maxScrollTop = messagesContainer.scrollHeight - messagesContainer.clientHeight;
  const targetScrollTop = Math.max(0, Math.min(messagesContainer.scrollTop + delta, maxScrollTop));
  messagesContainer.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  const entryId = turn.user?.dataset.entryId;
  if (entryId) selectInfoEntry(entryId, { scroll: true });
  flashJumpHighlight(turn.user);
  rebuildNavDots();
}

function jumpToPreviousUserMessage() {
  const turns = getConversations();
  if (!turns.length) return;
  const idx = getActiveConvIndex(turns);
  if (idx > 0) jumpToConversation(turns[idx - 1], idx - 1);
}

// Jumps to the next conversation's user message. If that next conversation
// is the last one (or there's no next one at all), scroll all the way to the
// bottom instead — so the full final reply is visible without an extra click.
function jumpToNextConversationOrBottom() {
  const turns = getConversations();
  const lastIdx = turns.length - 1;
  const idx = getActiveConvIndex(turns);
  const nextIdx = idx + 1;
  if (nextIdx <= lastIdx - 1) {
    jumpToConversation(turns[nextIdx], nextIdx);
  } else {
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "smooth" });
    scrollBottomBadge.classList.add("hidden");
  }
}

// ── Dot track ──────────────────────────────────────────
let _tooltipHideTimer = null;
let _navLockedIdx = -1;
let _navLockTimer = null;
let _navHoverIdx = -1;

// Minimum height (px) the nav needs to be useful:
const CONV_NAV_MAX_HEIGHT = 560;
const CONV_NAV_BASE_WIDTH = 7;
const CONV_NAV_HOVER_PEAK_WIDTH = 22;
const CONV_NAV_HOVER_SIGMA = 2.4;

function rebuildNavDots() {
  const turns = getConversations();
  const hasConvs = turns.length > 1;
  convNavEl.classList.toggle("hidden", !hasConvs);
  if (!hasConvs) return;

  const activeIdx = getActiveConvIndex(turns);
  // Add missing dots
  while (convNavTrack.children.length < turns.length) {
    const dot = document.createElement("button");
    dot.className = "conv-nav-dot";
    dot.setAttribute("aria-label", `Jump to conversation ${convNavTrack.children.length + 1}`);
    convNavTrack.appendChild(dot);
  }
  // Remove extra dots
  while (convNavTrack.children.length > turns.length) {
    convNavTrack.removeChild(convNavTrack.lastChild);
  }

  if (_navHoverIdx >= turns.length) {
    _navHoverIdx = -1;
  }

  [...convNavTrack.children].forEach((dot, i) => {
    dot.classList.toggle("active", i === activeIdx);
    dot.setAttribute("aria-label", `Jump to conversation ${i + 1}`);
    dot.onclick = () => jumpToConversation(turns[i], i);
    dot.onmouseenter = () => {
      _navHoverIdx = i;
      rebuildNavDots();
      showNavTooltip(dot, turns[i]);
    };
    dot.onmouseleave = () => {
      _navHoverIdx = -1;
      rebuildNavDots();
      hideNavTooltip();
    };
    const dist = _navHoverIdx >= 0 ? Math.abs(i - _navHoverIdx) : null;
    const w =
      dist === null
        ? CONV_NAV_BASE_WIDTH
        : Math.round(
            CONV_NAV_BASE_WIDTH +
              (CONV_NAV_HOVER_PEAK_WIDTH - CONV_NAV_BASE_WIDTH) *
                Math.exp(-(dist * dist) / (2 * CONV_NAV_HOVER_SIGMA * CONV_NAV_HOVER_SIGMA)),
          );
    dot.style.setProperty("--nav-w", `${w}px`);
    dot.style.setProperty("--nav-color", "var(--accent)");
  });

  // Scale the track down if all dots would exceed the max height.
  const naturalHeight = convNavTrack.scrollHeight;
  const scale = naturalHeight > CONV_NAV_MAX_HEIGHT ? CONV_NAV_MAX_HEIGHT / naturalHeight : 1;
  convNavTrack.style.transform = scale < 1 ? `scale(${scale})` : "";
  convNavTrack.style.transformOrigin = scale < 1 ? "top left" : "";
  // Keep the nav's layout height in sync with the scaled visual size.
  convNavEl.style.height = scale < 1 ? `${naturalHeight * scale}px` : "";
}

function showNavTooltip(dotEl, turn) {
  clearTimeout(_tooltipHideTimer);
  const q = turn.user.textContent.trim().slice(0, 120);
  const a = turn.assistant
    ? turn.assistant.textContent.trim().replace(/\s+/g, " ").slice(0, 180)
    : "";
  convNavTooltipQ.textContent = q;
  convNavTooltipA.textContent = a;
  convNavTooltipA.style.display = a ? "" : "none";
  convNavTooltipSep.style.display = a ? "" : "none";

  // Show first so offsetHeight is measurable, then position vertically on the dot
  convNavTooltip.classList.remove("hidden");
  const dotRect = dotEl.getBoundingClientRect();
  const tipHeight = convNavTooltip.offsetHeight || 90;
  const tipWidth = convNavTooltip.offsetWidth || 260;
  const top = Math.max(
    8,
    Math.min(dotRect.top + dotRect.height / 2 - tipHeight / 2, window.innerHeight - tipHeight - 8),
  );
  convNavTooltip.style.top = `${top}px`;
  // Anchor the tooltip to the right of the dot (the rail sits on the chat's
  // left edge), following the dot so panels never displace or cover it.
  convNavTooltip.style.left = `${Math.min(dotRect.right + 8, window.innerWidth - tipWidth - 8)}px`;

  // Trigger slide-in animation on every fresh hover
  convNavTooltip.classList.remove("animating");
  void convNavTooltip.offsetWidth; // reflow so animation re-fires
  convNavTooltip.classList.add("animating");
  convNavTooltip.addEventListener(
    "animationend",
    () => convNavTooltip.classList.remove("animating"),
    {
      once: true,
    },
  );
}

function hideNavTooltip() {
  _tooltipHideTimer = setTimeout(() => convNavTooltip.classList.add("hidden"), 120);
}

convNavTooltip.onmouseenter = () => clearTimeout(_tooltipHideTimer);
convNavTooltip.onmouseleave = () => hideNavTooltip();

// ── Scroll + mutation wiring ────────────────────────────
messagesContainer.addEventListener("scroll", () => {
  const threshold = 150;
  const atBottom =
    messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight <
    threshold;
  isScrolledUp = !atBottom;
  if (atBottom) scrollBottomBadge.classList.add("hidden");
  rebuildNavDots();
});

// Rebuild whenever messages are added or removed (session switch, history load,
// streaming new assistant message, etc.) without threading a callback into every
// call-site in MessageRenderer.
new MutationObserver(rebuildNavDots).observe(messagesContainer, { childList: true });

// Re-evaluate space availability whenever the window is resized.
window.addEventListener("resize", rebuildNavDots);

// ── Session fork via "Fork from here" button on user messages ──────────────
// Tool-card file references dispatch "previewfile" bubbles from the message
// container; open (or refresh) the file preview for that path.
messagesContainer.addEventListener("previewfile", (event) => {
  const path = event.detail?.path;
  if (path) void filePreviewFollow.openPath(path).catch(() => {});
});
// Turn file chips live in the transcript too; clicking one opens the file.
messagesContainer.addEventListener("click", (event) => {
  const chip = event.target.closest(".turn-file-chip");
  if (!chip?.dataset.path) return;
  event.stopPropagation();
  void filePreviewFollow.openPath(chip.dataset.path).catch(() => {});
});
messagesContainer.addEventListener("messagefork", async (e) => {
  const { entryId, text } = e.detail || {};
  if (!entryId) return;
  if (state.isStreaming) {
    messageRenderer.renderError(t("infoPanel.actionWhileStreaming"));
    return;
  }
  if (!canUseSessionControl()) {
    messageRenderer.renderError(t("infoPanel.actionDesktopOnly"));
    return;
  }
  const btn = e.target.closest(".message-fork-btn");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("forking");
  }
  try {
    // pi forks natively in-place (same process/port) and emits
    // `session_start { reason: "fork" }`; the resulting mirror_sync snapshot
    // re-renders the forked history and updates routing. We only nudge the
    // sidebar so the new forked session file appears in the list.
    await transport.fork(entryId, getActivePort());
    refreshSidebarAfterUserPrompt();
    // Design: after a fork the composer is prefilled with the forked user
    // message's text, awaiting edits — never auto-sent. Deferred to the
    // post-fork mirror_sync because the snapshot restores the new file's
    // (empty) draft after this ack, which would wipe an immediate prefill.
    if (typeof text === "string" && text) {
      pendingPostSyncComposer = { text, previousSessionFile: activeUiSessionFile };
      messageInput.focus();
    }
  } catch (err) {
    messageRenderer.renderError(t("errors.forkFailed", { error: err }));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("forking");
    }
  }
});

// Edit-and-branch: pi's native /tree select on a user message — the leaf
// moves to that entry's parent and the original prompt lands in the composer;
// only the user's submit creates the sibling branch.
messagesContainer.addEventListener("messageedit", async (e) => {
  const { entryId, text } = e.detail || {};
  if (!entryId) return;
  if (state.isStreaming) {
    messageRenderer.renderError(t("infoPanel.actionWhileStreaming"));
    return;
  }
  if (!canUseSessionControl()) {
    messageRenderer.renderError(t("infoPanel.actionDesktopOnly"));
    return;
  }
  const btn = e.target.closest(".message-edit-btn");
  if (btn) btn.disabled = true;
  try {
    // Dispatches /picot-navigate-tree → pi ctx.navigateTree(userEntry):
    // leaf = the user entry's parent, editorText = the original prompt. The
    // resulting session_tree event re-syncs chat + tree; the old branch's
    // descendants become the Info tree's inactive branch.
    await transport.navigateTree(entryId, { port: getActivePort() });
    if (typeof text === "string") {
      messageInput.value = text;
      messageInput.style.height = "auto";
      messageInput.focus();
      // Programmatic .value assignment fires no input event, so persist the
      // prefill now: the pending session_tree snapshot's restoreSessionUiState
      // reloads this session's saved draft and would otherwise wipe it.
      persistComposerDraft();
    }
  } catch (err) {
    messageRenderer.renderError(t("errors.treeNavigateFailed", { error: err }));
    if (btn) btn.disabled = false;
  }
});

// scrollBottomBtn is now a hidden legacy stub; navigation handled by convNavDown.

function showNewMessageBadge() {
  if (isScrolledUp) {
    scrollBottomBadge.classList.remove("hidden");
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener("connected", () => {
  updateConnectionStatus("connected");
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
  // Terminal reattachment is triggered after owner_bootstrap supplies the
  // current workspace generation. Sending before that token is known would
  // make a cross-workspace reload use generation zero.
});

wsClient.addEventListener("disconnected", () => {
  updateConnectionStatus("disconnected");
  sidebar.clearStreaming();

  // Deferred session switch requires agent_end to complete, which won't fire
  // after a crash/disconnect. Unblock input immediately so the user isn't stuck.
  if (pendingSessionSwitchPath) {
    pendingSessionSwitchPath = null;
    updateUI();
  }

  // If the streaming state is still true 3 s after disconnect (pi likely
  // crashed — agent_end won't re-fire after reconnect), unlock the UI.
  // Brief intentional reconnects (Case 1 session switch) complete in < 100 ms
  // so they are unaffected by the 3-second gate.
  setTimeout(() => {
    if (wsClient.connectionState !== "open" && state.isStreaming) {
      state.setStreaming(false);
      showTypingIndicator(false);
      updateUI();
    }
  }, 3000);
});

wsClient.addEventListener("reconnectFailed", () => {
  updateConnectionStatus("disconnected");
  messageRenderer.renderError(t("errors.connectionLost"));
});

wsClient.addEventListener("rpcEvent", (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener("serverError", (e) => {
  messageRenderer.renderError(e.detail.message);
});

// The broker could not deliver a command to any live pi process. For a tracked
// prompt this means the user's message was dropped — surface it, clear the
// optimistic streaming/typing state, and restore the text so it isn't lost.
wsClient.addEventListener("commandUndeliverable", (e) => {
  const { requestId, reason, command } = e.detail || {};
  const pending = requestId ? inFlightPrompts.get(requestId) : null;
  if (!pending) {
    console.warn("[WS] command undeliverable:", { command, reason, requestId });
    return;
  }
  clearTimeout(pending.timer);
  inFlightPrompts.delete(requestId);
  state.setStreaming(false);
  showTypingIndicator(false);
  const detail =
    reason === "no_route"
      ? t("errors.commandUndeliverableNoRoute")
      : t("errors.commandUndeliverableUnreachable");
  messageRenderer.renderError(t("errors.messageNotDelivered", { detail }));
  if (pending.message && !messageInput.value.trim()) {
    messageInput.value = pending.message;
    messageInput.style.height = "auto";
  }
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener("mirrorSync", (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  const eventSessionFile = event?.__broker?.sessionId || null;
  const eventSourcePort = event?.__broker?.sourcePort ?? null;

  // Port-based guard: the broker broadcasts every upstream's events to all UI
  // clients, so an event from a *different* pi process (e.g. the previous
  // session that is still streaming after the user started a new parallel
  // session) must never render into the foreground UI. A brand-new session
  // has no session file yet, so the sessionId guard below can't catch this —
  // the source port is the only reliable discriminator at that moment.
  if (
    typeof eventSourcePort === "number" &&
    typeof foregroundPort === "number" &&
    eventSourcePort !== foregroundPort
  ) {
    if (eventSessionFile) handleBackgroundRPCEvent(eventSessionFile, event);
    return;
  }

  if (
    eventSessionFile &&
    sidebar.activeSessionFile &&
    eventSessionFile !== sidebar.activeSessionFile
  ) {
    handleBackgroundRPCEvent(eventSessionFile, event);
    return;
  }

  // While the user is previewing a different session, suppress all live
  // rendering so the history view isn't overwritten by streaming output.
  // agent_end still needs to fire so we can complete the deferred switch.
  if (pendingSessionSwitchPath && event.type !== "agent_end") return;

  switch (event.type) {
    case "agent_start":
      handleAgentStart(event);
      break;
    case "agent_end":
      handleAgentEnd(event);
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
      }
      // Turn boundary: live appends already grew the tree incrementally; only
      // a full get_session_tree sync runs when an append failed (dirty) —
      // skips the ~MB-per-turn payload on long sessions.
      void refreshInfoTree();
      break;
    case "agent_settled":
      handleAgentSettled();
      break;
    case "message_start":
      handleMessageStart(event.message);
      // Refresh the sidebar as soon as the new session is persisted. Pi writes
      // the brand-new session's .jsonl on the first user message round-trip, so
      // refreshing on the user message (not just the assistant turn) makes the
      // session — with its first message as the title — show up immediately.
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
        pollInstances().catch(() => {});
      }
      break;
    case "message_update":
      handleMessageUpdate(event);
      break;
    case "message_end":
      handleMessageEnd(event.message, eventSessionFile, event.entryId);
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
      }
      break;
    case "tool_execution_start":
      handleToolExecutionStart(event);
      break;
    case "tool_execution_update":
      handleToolExecutionUpdate(event);
      break;
    case "tool_execution_end":
      handleToolExecutionEnd(event);
      break;
    case "compaction_start":
      handleCompactionStart();
      break;
    case "compaction_end":
      handleCompactionEnd(event);
      break;
    case "queue_update":
      renderPiQueue(event);
      break;
    case "auto_retry_start":
      handleAutoRetryStart(event);
      break;
    case "auto_retry_end":
      handleAutoRetryEnd(event);
      break;
    case "extension_ui_request":
      handleExtensionUIRequest(event);
      break;
    case "extension_error":
      messageRenderer.renderError(t("errors.extensionError", { error: event.error }));
      break;
    case "session_name":
      handleSessionNameEvent(event);
      break;
    case "session_tree":
      // Pi moved the active leaf natively (Info panel Resume / message Edit).
      // Re-sync from the authoritative snapshot: chat re-renders the new
      // active path and the Info tree flips active/inactive state.
      wsClient.send({ type: "mirror_sync_request" });
      break;
  }
}

function handleSessionNameEvent(event) {
  if (!event.name) return;
  const activeItem = document.querySelector(".session-item.active .session-title");
  if (activeItem) activeItem.textContent = event.name;
}

function handleBackgroundRPCEvent(sessionFile, event) {
  switch (event.type) {
    case "agent_start":
      sidebar.setStreaming(sessionFile, true);
      break;
    case "agent_end": {
      sidebar.setStreaming(sessionFile, false);
      sidebar.markUnread(sessionFile);
      sidebar.loadSessions({ quiet: true }).catch(() => {});
      pollInstances().catch(() => {});
      // Check if this background session was a dispatched Super Agent task
      const srcPort = event?.__broker?.sourcePort;
      if (srcPort && dispatchedTasks.has(srcPort)) {
        const taskMeta = dispatchedTasks.get(srcPort); // ast-grep-ignore no-case-declarations-js — case already has block braces
        dispatchedTasks.delete(srcPort);
        // agent_end carries no exit status — always mark done and let Super Agent handle
        notifySuperAgent(taskMeta.superAgentPort, taskMeta.taskId, taskMeta.title, "done", null);
      }
      break;
    }
    case "message_end":
      sidebar.markUnread(sessionFile);
      break;
  }
}

function handleCompactionStart() {
  compactCoordinator.started();
  const el = document.createElement("div");
  el.className = "system-message compaction-message";
  el.id = "compaction-indicator";
  const spinner = document.createElement("span");
  spinner.className = "compaction-spinner";
  spinner.textContent = "⟳";
  el.replaceChildren(spinner, document.createTextNode(` ${t("status.compacting")}`));
  messagesContainer.appendChild(el);
  scrollToBottom();
}

async function dispatchSuperAgentTask(task) {
  await dispatchSuperAgentTaskCore({
    task,
    transport,
    getCurrentPort,
    updateSuperAgentTask,
    dispatchedTasks,
  });
}

async function notifySuperAgent(port, taskId, title, status, failReason) {
  if (!port) return;
  const summary =
    status === "done"
      ? "Project agent ended. Review the child session for details."
      : failReason || "Project agent reported a failure.";
  let updatedTask = null;
  // Update the task status in tasks.json directly.
  try {
    updatedTask = await updateSuperAgentTask(port, taskId, (task) =>
      markTaskFinished(task, { status, summary, failReason }),
    );
  } catch (e) {
    console.warn("[SuperAgent] task status update failed:", e);
  }
  // Also notify the SA agent via chat so it can reply to the original sender
  const msg = buildSuperAgentNotificationPrompt(updatedTask || { id: taskId, title }, {
    status,
    summary,
    failReason,
  });
  try {
    await fetch(`http://localhost:${port}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: msg }),
    });
  } catch (e) {
    console.warn("[SuperAgent] notify failed:", e);
  }
}

async function notifySuperAgentClarification(task) {
  const port = task?.dispatch?.superAgentPort || task?.superAgentPort || getCurrentPort();
  if (!port || !task) return;
  const msg = buildSuperAgentNotificationPrompt(task, {
    status: "needs_input",
    failReason: task.result?.failReason || task.failReason,
  });
  try {
    await fetch(`http://localhost:${port}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: msg }),
    });
  } catch (e) {
    console.warn("[SuperAgent] clarification notify failed:", e);
  }
}

async function viewSuperAgentChildSession(task) {
  const childPort = Number(task?.dispatch?.childPort || task?.childPort);
  if (!Number.isFinite(childPort) || childPort <= 0) return;

  await pollInstances().catch(() => {});
  const childInstance = liveInstances.find((instance) => instance?.port === childPort);
  if (!childInstance) return;

  const sessionFile = childInstance.sessionFile;
  if (sessionFile) {
    const projects = await sidebar.loadSessions().catch(() => sidebar.projects || []);
    for (const project of projects || []) {
      const session = (project.sessions || []).find((item) => item.filePath === sessionFile);
      if (session) {
        await switchSession(sessionFile, session, project);
        return;
      }
    }
  }

  navigateInWindow(withBrokerWs(buildWorkspaceUrl(childPort), transport));
}

async function updateSuperAgentTask(port, taskId, updateTask) {
  const res = await fetch(`http://localhost:${port}/api/super-agent/tasks`);
  if (!res.ok) return null;
  const data = await res.json();
  const tasks = normalizeSuperAgentTasks(data.tasks || []);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  tasks[index] = updateTask(tasks[index]);
  await fetch(`http://localhost:${port}/api/super-agent/tasks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, tasks }),
  });
  return tasks[index];
}

function handleCompactionEnd(event) {
  const succeeded = event.success !== false && !event.error;
  compactCoordinator.ended({ success: succeeded, error: event.error });
  const indicator = document.getElementById("compaction-indicator");
  if (succeeded) {
    if (indicator) {
      indicator.textContent = event.summary
        ? t("status.compactedWithSummary", { summary: event.summary })
        : t("status.compacted");
      indicator.classList.add("compaction-done");
    }
    // Pi has replaced its context; until it supplies usage again, the old
    // number is provably stale and must not remain visible.
    lastInputTokens = 0;
    lastUsage = null;
    headerStatusBar?.sync({ currentUsage: null });
    updateTokenUsage();
    return;
  }

  const error = event.error || event.summary || t("errors.compactionFailed");
  if (indicator) {
    indicator.textContent = t("errors.compactionFailedDetail", { error });
    indicator.classList.add("compaction-done");
  } else {
    messageRenderer.renderError(t("errors.compactionFailedDetail", { error }));
  }
}

/**
 * Refresh the sidebar after a brand-new session's first message round-trips.
 *
 * Pi only persists a new session's .jsonl on the first message round-trip, and
 * `/api/sessions` can briefly return *successfully* without the new file yet
 * (loadSessions' built-in retry only covers fetch failures, not "fetched but
 * the row isn't there"). So we reload, and if the freshly created session still
 * isn't in the list, retry a few times with a short backoff before giving up.
 */
async function refreshSidebarForNewSession(event = null, attempt = 0) {
  const projects = await sidebar.loadSessions({ quiet: true }).catch(() => null);

  const liveFile = getCurrentLiveSessionFile(event);
  if (liveFile) {
    // Read the result this call actually fetched (not sidebar.projects, which a
    // concurrent load could leave stale) so we detect the new session as soon as
    // any fetch observes it on disk.
    const found = (projects || sidebar.projects).some((p) =>
      p.sessions.some((s) => s.filePath === liveFile),
    );
    if (found) {
      sidebar.setActive(liveFile);
      restoreSessionUiState(liveFile);
      resolveAndApplyFocus();
      // The new session may not have had a stable identity when its first
      // assistant event arrived. Once the persisted file is known, hydrate
      // the authoritative aggregate for the new session.
      void hydrateHeaderSessionStats();
      pendingNewSessionRefresh = false;
      pendingNewSessionPreviousFile = null;
      return;
    }
  }

  if (attempt < 4) {
    await pollInstances().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    return refreshSidebarForNewSession(event, attempt + 1);
  }
}

function getCurrentLiveSessionFile(event = null) {
  return resolveNewSessionLiveFile({
    event,
    liveInstances,
    foregroundPort,
    mirrorActiveSessionFile,
    excludedSessionFile: pendingNewSessionPreviousFile,
  });
}

function handleAgentSettled() {
  // 兜底：agent_end 正常已处理；此处仅在其未到达（如重连后不再重发）时
  // 确保 streaming/typing 状态归位。幂等，无副作用（不重复通知/markUnread）。
  state.setStreaming(false);
  showTypingIndicator(false);
  const live = getCurrentLiveSessionFile();
  if (live) sidebar.setStreaming(live, false);
  // Fold the just-finished turn's thinking + tool noise into a collapsed
  // "Process details" row so chat history stays scannable. Live turn stays
  // expanded while streaming; collapse is purely post-hoc.
  collapseCompletedTurn();
}

/**
 * Walk the just-finished turn's children in the messages container (everything
 * after the last .user message) and pack any thinking blocks and tool cards
 * into a collapsed process-details group. Matches upstream's
 * `collapseCompletedTurn` in public/native/app.js: the user prompt and the
 * final assistant answer stay visible, everything else gets folded away.
 */
function collapseCompletedTurn() {
  const children = Array.from(messagesElement.children);
  let lastUserIdx = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].classList.contains("user")) {
      lastUserIdx = i;
      break;
    }
  }
  const afterUser = children.slice(lastUserIdx + 1);
  if (afterUser.length === 0) return;

  const group = createProcessDetailsGroup();
  let stepCount = 0;
  let toolCallCount = 0;
  let inserted = false;
  const insertGroupBefore = (el) => {
    if (inserted) return;
    el.before(group.wrapper);
    inserted = true;
  };

  for (const el of afterUser) {
    if (el.classList.contains("tool-card")) {
      insertGroupBefore(el);
      group.body.appendChild(el);
      stepCount += 1;
      toolCallCount += 1;
      continue;
    }
    if (el.classList.contains("assistant")) {
      const thinkingEl = el.querySelector(".thinking-block");
      if (!thinkingEl) continue;
      insertGroupBefore(el);
      thinkingEl.remove();
      group.body.appendChild(thinkingEl);
      stepCount += 1;
      const contentEl = el.querySelector(".message-content");
      const hasRemainingContent = Boolean(contentEl?.textContent.trim());
      if (!hasRemainingContent) el.remove();
    }
  }

  if (group.body.children.length === 0) return; // nothing to fold away; wrapper was never inserted
  group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
}

function handleAgentStart(event = null) {
  state.setStreaming(true);
  showTypingIndicator(true);
  // A fresh run is under way — clear any prior error latch so a normal turn
  // isn't treated as "stuck on a failed model" by the model switcher.
  lastTurnErrored = false;
  updateUI();
  const live = getCurrentLiveSessionFile(event);
  if (live) sidebar.setStreaming(live, true);
}

// pi's auto-retry is re-hitting the SAME model after a transient error. The
// session is busy on the failing model during the backoff; surface that so the
// UI doesn't look idle and the model switcher knows to abort before switching.
function handleAutoRetryStart(event = null) {
  isAutoRetrying = true;
  lastTurnErrored = true;
  state.setStreaming(true);
  showTypingIndicator(true);
  const attempt = event?.attempt;
  const maxAttempts = event?.maxAttempts;
  if (attempt && maxAttempts) {
    statusText.textContent = `Retrying (${attempt}/${maxAttempts})...`;
  } else {
    statusText.textContent = "Retrying…";
  }
  updateUI();
}

function handleAutoRetryEnd(event = null) {
  isAutoRetrying = false;
  // Success clears the error latch; a final failure keeps it so the next model
  // switch aborts the dead run.
  if (event?.success) lastTurnErrored = false;
  updateUI();
}

function handleAgentEnd(event = null) {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = "";
  updateUI();

  // Deferred session switch: user clicked a history session while streaming.
  // Now that the agent run is done, tell pi to switch — no abort needed.
  if (pendingSessionSwitchPath) {
    const targetPath = pendingSessionSwitchPath;
    pendingSessionSwitchPath = null;
    const live = getCurrentLiveSessionFile();
    if (live) sidebar.setStreaming(live, false);
    foregroundPort = findPortForSession(liveInstances, targetPath, foregroundPort);
    syncWorkspaceIndicatorFromInstances();
    transport.switchSession(targetPath, foregroundPort).catch((e) => {
      messageRenderer.renderError(t("errors.failedToSwitchSession", { error: e }));
    });
    return;
  }

  const live = getCurrentLiveSessionFile(event);
  if (live) {
    sidebar.setStreaming(live, false);
    // If user is not currently viewing this session in the sidebar,
    // mark it as unread so they see a blue dot when they look back.
    if (live !== sidebar.activeSessionFile) {
      sidebar.markUnread(live);
    }
  }

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;
  }

  // Fold the just-finished turn's thinking + tool noise into a collapsed
  // "Process details" row so chat history stays scannable. The live turn
  // stays expanded while streaming; collapse is purely post-hoc and runs
  // once the agent settles. agent_end is the normal completion path;
  // handleAgentSettled covers the reconnect fallback when agent_end is
  // never re-delivered.
  collapseCompletedTurn();
  appendTurnFileChips();
}

let lastTurnAssistantElement = null;
function appendTurnFileChips() {
  const writes = state.settleTurnWrites();
  if (!writes.length) {
    lastTurnAssistantElement = null;
    return;
  }
  const host = lastTurnAssistantElement?.isConnected ? lastTurnAssistantElement : null;
  lastTurnAssistantElement = null;
  if (!host) return;
  const row = renderTurnFileChips(writes);
  if (row) host.insertAdjacentElement("afterend", row);
}

let currentStreamingThinking = "";

function handleMessageStart(message) {
  if (message.role === "assistant") {
    currentStreamingText = "";
    currentStreamingThinking = "";
    currentStreamingElement = messageRenderer.renderAssistantMessage({ content: "" }, true);
  } else if (message.role === "user") {
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      const images = getMessageImages(message);
      if (content || images.length > 0)
        renderNavigableUserMessage({ content, images, timestamp: Date.now() });
    }
    lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function getMessageImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block) => block?.type === "image")
    .map((block) => ({
      data: block.source?.data || block.data || "",
      mimeType: block.source?.media_type || block.media_type || "image/png",
    }));
}

function renderNavigableUserMessage({ content, images, isHistory = false, timestamp }) {
  const element = messageRenderer.renderUserMessage(
    { content: content || "", images, timestamp },
    isHistory,
  );
  return element;
}

function getAssistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function getAssistantThinking(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking || "")
    .join("\n");
}

function ensureStreamingAssistantElement(message = null) {
  if (currentStreamingElement) return currentStreamingElement;
  currentStreamingText = getAssistantText(message);
  currentStreamingThinking = getAssistantThinking(message);
  currentStreamingElement = messageRenderer.renderAssistantMessage({ content: "" }, true);
  if (currentStreamingThinking) {
    messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
  }
  if (currentStreamingText) {
    messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
  }
  return currentStreamingElement;
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent, message } = event;
  if (message?.role === "assistant") {
    ensureStreamingAssistantElement(message);
  }

  if (assistantMessageEvent.type === "thinking_delta") {
    currentStreamingThinking =
      getAssistantThinking(message) || currentStreamingThinking + assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === "text_delta") {
    currentStreamingText =
      getAssistantText(message) || currentStreamingText + assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
    }
  }
}

function handleMessageEnd(message, eventSessionFile = null, entryId = null) {
  if (message?.role === "user" && entryId) {
    // Pi persisted the user entry (embedded-server enriches message_end with
    // the leaf id). Tag the live-rendered element so Info-tree scroll and
    // Fork/Edit work immediately, before the next full snapshot.
    const untagged = messagesContainer.querySelector(".message.user:not([data-entry-id])");
    if (untagged) untagged.dataset.entryId = entryId;
  }
  // Live-turn incremental Info-tree update: rebuild the entry from the
  // enriched entryId and append into the panel's cached snapshot. toolResult
  // entries append too — they stay invisible but keep the parent chain intact
  // for the next assistant entry. Append failures (no cache, unknown parent,
  // recalibration due) set the dirty flag; agent_end's full refresh covers
  // them.
  if (
    entryId &&
    (message?.role === "user" || message?.role === "assistant" || message?.role === "toolResult")
  ) {
    const appended = infoPanel?.appendLiveEntry({
      type: "message",
      id: entryId,
      parentId: infoPanel?.leafId,
      timestamp: new Date().toISOString(),
      message,
    });
    if (appended === false) infoTreeDirty = true;
  }
  if (message?.role === "assistant" && message?.stopReason === "error") {
    const provider = message?.provider ? String(message.provider) : "unknown";
    const model = message?.model ? String(message.model) : "unknown";
    const errorMessage = message?.errorMessage
      ? String(message.errorMessage)
      : t("errors.modelRequestFailed");
    messageRenderer.renderError(
      t("errors.modelRequestFailedDetail", { provider, model, message: errorMessage }),
    );
    // Latch the error so a subsequent model switch aborts the stuck run
    // (pi may still be auto-retrying this same failing model).
    lastTurnErrored = true;
  } else if (message?.role === "assistant") {
    lastTurnErrored = false;
  }
  if (!currentStreamingElement && message?.role === "assistant") {
    ensureStreamingAssistantElement(message);
  }
  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(
      currentStreamingElement,
      usage,
      currentStreamingThinking,
    );
    // Remember the turn's latest assistant element; agent_end settles the
    // turn's writes and renders the chips row under it (a turn may contain
    // several assistant messages — only the last one gets the row).
    lastTurnAssistantElement = currentStreamingElement;
    if (entryId) lastTurnAssistantElement.dataset.entryId = entryId;
    currentStreamingElement = null;
    currentStreamingThinking = "";

    // Track current-context usage only. Session aggregate cost/tokens have a
    // single owner in headerStatusBar and are never derived from rendering.
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    // Extend the authoritative session aggregate with this live completion
    // only. If the session identity has not hydrated yet, request the
    // authoritative snapshot instead of risking an unscoped increment.
    const sessionFile = eventSessionFile || activeSessionFileForStatusBar();
    const applied = headerStatusBar?.applyLiveUsage(
      {
        input: usage?.input || 0,
        output: usage?.output || 0,
        cacheRead: usage?.cacheRead || 0,
        cacheWrite: usage?.cacheWrite || 0,
        cost: { total: usage?.cost?.total || 0 },
      },
      { sessionFile },
    );
    if (applied === false) void hydrateHeaderSessionStats();
    headerStatusBar?.sync({ currentUsage: lastUsage });
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: "pending",
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
  filePreviewFollow.onToolStart(event);
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: "streaming",
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? "error" : "complete",
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
  // Follow the agent's writes so the live preview (e.g. HTML iframes)
  // reflects disk changes without manual reopening. The callback records
  // successful in-workspace writes for the turn-end file chips row (it
  // already gates on success + workspace containment).
  void filePreviewFollow.onToolEnd(event).catch(() => {});
  // rpiv-todo emits `todo` tool results whose `details` carry the reducer
  // snapshot. Mirror the latest snapshot onto the floating panel.
  if (event.toolName === "todo" && !isError && result?.details) {
    todoMirrorPanel.applyToolResult(result);
  }
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case "select":
      dialogHandler.showSelect(event);
      break;
    case "confirm":
      dialogHandler.showConfirm(event);
      break;
    case "input":
      dialogHandler.showInput(event);
      break;
    case "editor":
      dialogHandler.showEditor(event);
      break;
    case "notify":
      // rpiv-todo's /todos command emits a centered notify transcript
      // listing each status section. The floating panel already mirrors the
      // same state natively, so expand it instead of rendering a duplicate
      // toast — both would otherwise flash the same content for 5 seconds.
      // When nothing is mirrored (the panel stays hidden, e.g. "No todos
      // yet"), fall through and render the message so /todos is never a
      // silent no-op.
      if (isRpivTodoCommandNotify(event.message) && todoMirrorPanel.hasVisibleTasks) {
        todoMirrorPanel.expand();
        break;
      }
      dialogHandler.showNotification(event);
      break;
    // `setStatus` and `setWidget` are informational labels/widgets the
    // embedded server and pi extensions push (e.g. "Embedded: 127.0.0.1:47821",
    // plannotator progress). They have no browser-side surface, so acknowledge
    // them silently instead of logging unknown-method warnings. The rpiv-todo
    // extension is the exception — its `setWidget` with widgetKey="rpiv-todos"
    // asks the host UI to surface the mirror, so expand it instead.
    case "setStatus":
      break;
    case "setWidget":
      if (isRpivTodoWidgetRequest(event)) todoMirrorPanel.expand();
      break;
    default:
      console.warn("[App] Unknown extension UI method:", event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return "";

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === "text") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener("keydown", (e) => {
  // IME composition uses Enter to confirm candidates; never send during composition.
  // Some WebKit/IME combinations report Enter candidate confirmation with
  // `isComposing === false` but `keyCode === 229`, so keep the legacy fallback.
  const isImeComposing = e.isComposing || e.keyCode === 229;
  if (isImeComposing) return;

  // Enter sends, Shift+Enter inserts newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea and keep the draft isolated from the active session.
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
  persistComposerDraft();
});

// ═══════════════════════════════════════
// Image attachment
// ═══════════════════════════════════════

const attachBtn = document.getElementById("attach-btn");
setButtonIcon(attachBtn, "plus", { size: 16 });
const imageInput = document.getElementById("image-input");
const imagePreviews = document.getElementById("image-previews");
const composerCard = document.getElementById("composer-card");

// Image attachments: attach button, native picker, paste/drop, previews.
// Uses the shared helper so the main chat and ephemeral chats stay in lockstep.
// The file-tree drag handler (text/plain path mention) stays inline because it
// is main-chat-only behavior; only the image portion delegates to the helper.
const mainPasteOffload = setupComposerPasteOffload({
  textarea: messageInput,
  container: composerCard,
  offload: async (content) => {
    const response = await fetch("/api/paste-offload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || `Paste offload failed: ${response.status}`);
    return result?.path;
  },
  t,
});
const mainImageAttachments = setupComposerImageAttachments({
  document,
  composerCard,
  textarea: messageInput,
  attachBtn,
  imageInput,
  imagePreviews,
  processImageFile,
  processImagePayload,
  pickImageFiles: (cwd) => transport.pickImageFiles(cwd),
  getWorkspacePath: getCurrentWorkspacePath,
  isNativeAvailable: nativeAvailable,
  onError: (message) => messageRenderer.renderError(message),
  t,
});
composerCard.addEventListener(
  "drop",
  (e) => {
    // File Tree drag: text/plain carries an absolute path. Image drops are
    // handled by mainImageAttachments already; this listener only intercepts
    // text/plain path mentions before the helper runs.
    const rawPath = e.dataTransfer.getData("text/plain");
    if (rawPath?.startsWith("/")) {
      if (fileBrowser.insertFileMention(rawPath)) {
        e.stopPropagation();
      }
    }
  },
  true,
);

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

function clearMessageQueue() {
  messageQueue = [];
  renderQueuedMessages();
}

// Prompts are sent fire-and-forget over the WebSocket. The broker replies with
// `command_undeliverable` (correlated by requestId) when it cannot route the
// command to a live pi process. We track in-flight prompt requestIds here so the
// `commandUndeliverable` handler can tell a real dropped prompt apart from
// background/system commands and recover the user's text. Entries self-expire:
// the broker decides deliverability synchronously, so anything not reported
// undeliverable within a few seconds was forwarded successfully.
const inFlightPrompts = new Map();

function trackPromptDelivery(requestId, message) {
  if (!requestId) return;
  const timer = setTimeout(() => inFlightPrompts.delete(requestId), 8000);
  inFlightPrompts.set(requestId, { message, timer });
}

function refreshSidebarAfterUserPrompt() {
  const refresh = () => {
    sidebar.loadSessions({ quiet: true }).catch(() => {});
    pollInstances().catch(() => {});
  };
  refresh();
  setTimeout(refresh, 500);
  setTimeout(refresh, 1500);
}

function sendMessage() {
  if (mainPasteOffload.isBusy()) return;
  if (!currentOnboardingState().canQuery) return;

  const message = messageInput.value.trim();
  if (!message) return;

  messageInput.value = "";
  messageInput.style.height = "auto";
  if (activeUiSessionFile) sessionUiState.clearDraft(activeUiSessionFile);

  const cmd = {
    type: "prompt",
    message,
  };

  const images = mainImageAttachments.consumePendingImages();
  if (images.length > 0) {
    cmd.images = images;
  }

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  renderNavigableUserMessage({ content: message, images: cmd.images, timestamp: Date.now() });
  if (!hasAnySessionsLoaded()) {
    pendingNewSessionRefresh = true;
  }

  trackPromptDelivery(wsClient.send(cmd), message);
  refreshSidebarAfterUserPrompt();
}

const queuedMessagesEl = document.getElementById("queued-messages");

function renderQueuedMessages() {
  queuedMessagesEl.replaceChildren();
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add("hidden");
    return;
  }
  queuedMessagesEl.classList.remove("hidden");
  messageQueue.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "queued-msg";
    const label = document.createElement("span");
    label.className = "queued-msg-label";
    label.textContent = t("queue.queued");
    const message = document.createElement("span");
    message.className = "queued-msg-text";
    message.textContent = cmd.message;
    const cancel = document.createElement("button");
    cancel.className = "queued-msg-cancel";
    cancel.title = t("queue.cancelTitle");
    cancel.setAttribute("aria-label", t("queue.cancelTitle"));
    const cancelIcon = createIcon("x", { size: 14 });
    if (cancelIcon) cancel.appendChild(cancelIcon);
    cancel.addEventListener("click", () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    item.append(label, message, cancel);
    queuedMessagesEl.appendChild(item);
  });
}

function renderPiQueue(event) {
  // 只读展示 pi 侧 steer/followUp 队列（来自 queue_update 事件）。
  // 与本地连发队列（messageQueue / renderQueuedMessages）相互独立，不改其逻辑。
  const steering = Array.isArray(event?.steering) ? event.steering : [];
  const followUp = Array.isArray(event?.followUp) ? event.followUp : [];
  const el = getOrCreatePiQueueEl();
  el.replaceChildren();
  const items = [
    ...steering.map((msg) => ({ kind: t("queue.steering"), msg })),
    ...followUp.map((msg) => ({ kind: t("queue.followUp"), msg })),
  ];
  if (items.length === 0) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  for (const { kind, msg } of items) {
    const item = document.createElement("div");
    item.className = "queued-msg pi-queued-msg";
    const label = document.createElement("span");
    label.className = "queued-msg-label";
    label.textContent = kind;
    const text = document.createElement("span");
    text.className = "queued-msg-text";
    text.textContent = msg;
    item.append(label, text);
    el.appendChild(item);
  }
}

function getOrCreatePiQueueEl() {
  let el = document.getElementById("pi-queue");
  if (!el) {
    el = document.createElement("div");
    el.id = "pi-queue";
    el.className = "hidden";
    queuedMessagesEl.insertAdjacentElement("afterend", el);
  }
  return el;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    if (!hasAnySessionsLoaded()) {
      pendingNewSessionRefresh = true;
    }

    const cmd = messageQueue.shift();
    renderNavigableUserMessage({ content: cmd.message, images: cmd.images, timestamp: Date.now() });
    renderQueuedMessages();
    trackPromptDelivery(wsClient.send(cmd), cmd.message);
    refreshSidebarAfterUserPrompt();
  }
}

abortBtn.addEventListener("click", () => {
  abortCurrentRun();
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById("command-btn");
setButtonIcon(commandBtn, "bot", { size: 16 });
const commandPalette = document.getElementById("command-palette");
const commandPaletteOverlay = document.getElementById("command-palette-overlay");
const commandList = document.getElementById("command-list");

const commands = [
  {
    icon: "text-collapse",
    label: t("input.compact"),
    desc: t("input.compactDesc"),
    action: () => requestCompact(),
  },
  {
    icon: "clipboard",
    label: t("input.exportHtml"),
    desc: t("input.exportHtmlDesc"),
    action: () => rpcExportHtml(),
  },
  {
    icon: "bar-chart",
    label: t("input.sessionStats"),
    desc: t("input.sessionStatsDesc"),
    action: () => showSessionStats(),
  },
  {
    icon: "chevrons-down",
    label: t("input.expandAllTools"),
    desc: t("input.expandAllToolsDesc"),
    action: () => toolCardRenderer.expandAll(),
  },
  {
    icon: "chevrons-up",
    label: t("input.collapseAllTools"),
    desc: t("input.collapseAllToolsDesc"),
    action: () => toolCardRenderer.collapseAll(),
  },
];
const mainCommandMenu = setupComposerCommandMenu({
  button: commandBtn,
  menu: commandPalette,
  list: commandList,
  getCommands: () => commands,
  document,
  overlay: commandPaletteOverlay,
  createIcon,
});
commandPaletteOverlay.addEventListener("click", mainCommandMenu.close);

async function rpcCommand(cmd, statusMsg, silent = false) {
  try {
    if (statusMsg && !silent) statusText.textContent = statusMsg;
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success && !silent) {
      statusText.textContent = t("status.done");
      setTimeout(() => {
        statusText.textContent = t("status.connected");
      }, 2000);
    } else if (!data.success) {
      console.error("rpcCommand failed:", cmd.type, data.error);
      if (!silent) {
        statusText.textContent = data.error || t("status.failed");
        setTimeout(() => {
          statusText.textContent = t("status.connected");
        }, 3000);
      }
    }
    return data;
  } catch (e) {
    console.error("rpcCommand error:", cmd.type, e);
    if (!silent) {
      statusText.textContent = t("status.error");
      setTimeout(() => {
        statusText.textContent = t("status.connected");
      }, 3000);
    }
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: "export_html" }, t("status.exporting"));
  if (data?.success && data.data?.path) {
    statusText.textContent = t("status.exported", { path: data.data.path });
    setTimeout(() => {
      statusText.textContent = t("status.connected");
    }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: "get_session_stats" }, t("status.loadingStats"));
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      t("status.sessionStatsTitle"),
      t("status.sessionStatsMessages", {
        total: s.totalMessages,
        user: s.userMessages,
        assistant: s.assistantMessages,
      }),
      t("status.sessionStatsToolCalls", { count: s.toolCalls }),
    ];
    if (s.tokens) {
      lines.push(t("status.sessionStatsContext", { tokens: (s.tokens.input / 1000).toFixed(1) }));
    }
    messageRenderer.renderSystemMessage(lines.join("\n"));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById("model-dropdown");
const modelDropdownBtn = document.getElementById("model-dropdown-btn");
const modelDropdownLabel = document.getElementById("model-dropdown-label");
const modelDropdownChevron = modelDropdownBtn?.querySelector(".model-dropdown-chevron");
if (modelDropdownChevron) {
  const icon = createIcon("chevron-down", { size: 10 });
  if (icon) {
    icon.classList.add("model-dropdown-chevron");
    modelDropdownChevron.replaceWith(icon);
  }
}
const modelDropdownMenu = document.getElementById("model-dropdown-menu");
const thinkingBtn = document.getElementById("thinking-btn");
function formatCompactThinkingLevelLabel(level) {
  return t("settings.thinkingCompact", { level: level || t("settings.off") });
}
function updateThinkingBtn() {
  thinkingBtn.textContent = formatCompactThinkingLevelLabel(currentThinkingLevel);
  thinkingBtn.title = t("settings.thinkingTitle");
  thinkingBtn.setAttribute(
    "aria-label",
    t("settings.thinkingAriaLabel", { level: currentThinkingLevel || t("settings.off") }),
  );
  thinkingBtn.classList.toggle("off", currentThinkingLevel === "off");
}
let currentModelId = "";
let availableModels = [];
let hasLoadedAvailableModels = false;
let didAutoOpenEmptyModelsDropdown = false;
let currentThinkingLevel = "off";
let currentDefaultThinkingLevel = "medium";

function currentOnboardingState() {
  return getOnboardingState({
    hasSessions: hasAnySessionsLoaded(),
    workspacePath: getCurrentWorkspacePath(),
    availableModels,
  });
}

function openModelsSettings() {
  return openSettings("models").then(() => {
    selectSettingsTab("models");
  });
}

function updateOnboardingUI() {
  const onboarding = currentOnboardingState();
  const needsSetup = !onboarding.canQuery;
  composerCard.classList.toggle("onboarding-disabled", needsSetup);
  if (needsSetup) {
    messageInput.placeholder = onboarding.message;
  }
  return onboarding;
}

async function fetchModelInfo() {
  try {
    // Populate models from the host-wide cache first so the dropdown renders
    // instantly on cold start. The active Pi's get_state call below still
    // runs in parallel; whichever returns models first wins. The cache is
    // warmed by the host after the first session registers and is shared
    // across all windows, Side Chats, and Quick Chats.
    try {
      const cached = await transport.getCachedModels();
      if (Array.isArray(cached?.models) && cached.models.length > 0) {
        availableModels = cached.models;
        hasLoadedAvailableModels = true;
        didAutoOpenEmptyModelsDropdown = false;
      }
    } catch (_cacheErr) {
      // Cache miss or host not ready — fall through to the live query below.
    }

    const [modelsResp, stateResp] = await Promise.all([
      fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_available_models" }),
      }),
      fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_state" }),
      }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && Array.isArray(modelsData.data?.models)) {
      availableModels = modelsData.data.models;
      hasLoadedAvailableModels = true;
      if (availableModels.length > 0) {
        didAutoOpenEmptyModelsDropdown = false;
      }
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || "";

      const model = availableModels.find((m) => m.id === currentModelId);
      if (!model && availableModels.length > 0) {
        const fallbackModel = availableModels[0];
        const resp = await rpcCommand({
          type: "set_model",
          provider: fallbackModel.provider,
          modelId: fallbackModel.id,
        });
        if (resp?.success) {
          currentModelId = fallbackModel.id;
          if (fallbackModel.contextWindow) {
            contextWindowSize = fallbackModel.contextWindow;
            updateTokenUsage();
          }
        }
      } else {
        updateModelLabel();
        if (model?.contextWindow) {
          contextWindowSize = model.contextWindow;
          updateTokenUsage();
        }
      }
    }
    if (stateData.success && stateData.data) {
      if (stateData.data.thinkingLevel) {
        currentThinkingLevel = stateData.data.thinkingLevel;
        updateThinkingBtn();
      }
      if (stateData.data.defaultThinkingLevel) {
        currentDefaultThinkingLevel = stateData.data.defaultThinkingLevel;
      }
    }
  } catch (_e) {
    // ignore
  } finally {
    updateModelLabel();
    updateUI();
    maybeAutoOpenEmptyModelsDropdown();
  }
}

function maybeAutoOpenEmptyModelsDropdown() {
  if (
    hasLoadedAvailableModels &&
    availableModels.length === 0 &&
    !didAutoOpenEmptyModelsDropdown &&
    modelDropdownMenu.classList.contains("hidden") &&
    settingsPanel.classList.contains("hidden")
  ) {
    didAutoOpenEmptyModelsDropdown = true;
    openModelDropdown();
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  modelDropdownLabel.textContent = shortName || t("misc.model");
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains("hidden");
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.replaceChildren();

  // Search input
  const search = document.createElement("input");
  search.className = "model-dropdown-search";
  search.placeholder = t("models.searchPlaceholder");
  search.type = "text";
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement("div");
  itemsContainer.className = "model-dropdown-items";
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.replaceChildren();
    const query = (filter || "").toLowerCase();
    // Empty-state: no API keys configured anywhere. Surface this loudly
    // instead of leaving the dropdown blank — empty dropdowns look like
    // a hung load, not a setup problem.
    if (availableModels.length === 0) {
      const empty = document.createElement("div");
      empty.className = "model-dropdown-empty";
      const content = document.createElement("div");
      content.style.cssText = "padding:14px;color:var(--text-dim);font-size:12px;line-height:1.5";
      const title = document.createElement("div");
      title.style.cssText = "color:var(--text-primary);margin-bottom:6px";
      title.textContent = t("models.emptyTitle");
      const help = document.createElement("div");
      help.textContent = t("models.emptyHelp");
      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "btn-primary";
      settingsButton.style.marginTop = "10px";
      settingsButton.textContent = t("settings.openSettings");
      settingsButton.addEventListener("click", () => {
        closeModelDropdown();
        openModelsSettings().catch(() => {});
      });
      content.append(title, help, settingsButton);
      empty.appendChild(content);
      itemsContainer.appendChild(empty);
      return;
    }
    availableModels.forEach((m) => {
      const shortName = m.id.replace(/-\d{8}$/, "");
      const providerStr = m.provider || "";
      if (
        query &&
        !shortName.toLowerCase().includes(query) &&
        !providerStr.toLowerCase().includes(query)
      )
        return;

      const el = document.createElement("div");
      el.className = `model-dropdown-item${m.id === currentModelId ? " active" : ""}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : "";
      const name = document.createElement("span");
      name.textContent = shortName;
      if (m.provider && m.provider !== "anthropic") {
        const provider = document.createElement("span");
        provider.className = "model-dropdown-item-provider";
        provider.textContent = m.provider;
        name.appendChild(provider);
      }
      const context = document.createElement("span");
      context.className = "model-dropdown-item-ctx";
      context.textContent = ctxK;
      el.append(name, context);
      el.addEventListener("click", async () => {
        closeModelDropdown();
        // If the session is stuck auto-retrying the current (failing) model, or
        // the last turn errored out, the in-flight run stays bound to the old
        // model and the switch would have no visible effect. Abort the dead run
        // first so the new model applies to the next prompt immediately. A
        // healthy stream is left untouched — we only interrupt retry/error runs.
        if (isAutoRetrying || lastTurnErrored) {
          wsClient.send({ type: "abort" });
          isAutoRetrying = false;
          lastTurnErrored = false;
          showTypingIndicator(false);
          if (state.isStreaming) {
            state.setStreaming(false);
            currentStreamingElement = null;
            currentStreamingText = "";
            currentStreamingThinking = "";
            updateUI();
          }
        }
        const result = await selectModel({
          model: m,
          rpcCommand,
          refreshModelInfo: fetchModelInfo,
          applySelectedModel: (selectedModel) => {
            currentModelId = selectedModel.id;
            if (selectedModel.thinkingLevel) {
              currentThinkingLevel = selectedModel.thinkingLevel;
            }
            saveCurrentSessionProfile();
            updateThinkingBtn();
            updateModelLabel();
            if (selectedModel.contextWindow) {
              contextWindowSize = selectedModel.contextWindow;
              updateTokenUsage();
            }
          },
        });
        if (!result?.success) {
          messageRenderer.renderError(`Model switch failed: ${result?.error || "unknown error"}`);
        }
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems("");

  search.addEventListener("input", () => renderItems(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelDropdown();
      e.stopPropagation();
    }
    if (e.key === "Enter") {
      const first = itemsContainer.querySelector(".model-dropdown-item");
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove("hidden");
  modelDropdown.classList.add("open");
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add("hidden");
  modelDropdown.classList.remove("open");
}

modelDropdownBtn.addEventListener("click", toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener("click", async () => {
  const data = await rpcCommand({ type: "cycle_thinking_level" }, "Cycling thinking…");
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    saveCurrentSessionProfile();
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener("keydown", (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === "Escape") {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains("hidden")) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains("hidden")) {
      closeModelDropdown();
      return;
    }

    if (state.isStreaming) {
      abortCurrentRun();
    } else if (!sidebarEl.classList.contains("collapsed") && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === "/" && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }

  // Cmd+N (macOS) / Ctrl+N (Windows/Linux) — Start a new chat session in
  // the current workspace. Mirrors the header "+ New Session" button.
  // We intentionally do NOT gate on isInInput() so the shortcut works
  // even while the user is typing in the composer. Shift/Alt are excluded
  // so we don't shadow Cmd+Shift+N (reserved for future "new window").
  if ((e.key === "n" || e.key === "N") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    newSession().catch((_err) => {
      messageRenderer.renderError(t("errors.newSessionFailed"));
    });
  }

  // Cmd+Option+I (macOS) / Ctrl+Alt+I (Windows/Linux) — Open webview inspector.
  if ((e.key === "i" || e.key === "I") && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (nativeAvailable()) {
      transport.openDevtools().catch((err) => {
        messageRenderer.renderError(t("errors.failedToOpenInspector", { error: err }));
      });
    }
  }

  // Cmd/Ctrl+Up — Jump to the previous conversation (skip typing in inputs).
  if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey) && !isInInput()) {
    e.preventDefault();
    jumpToPreviousUserMessage();
  }

  // Cmd/Ctrl+Down — Jump to the next conversation, or the bottom if this is
  // already the last one.
  if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey) && !isInInput()) {
    e.preventDefault();
    jumpToNextConversationOrBottom();
  }

  // Cmd+Shift+T (macOS) / Ctrl+Shift+T — Toggle Agent Inbox (Runtime panel).
  if ((e.key === "t" || e.key === "T") && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
    e.preventDefault();
    const runtimePanel = document.querySelector("super-agent-runtime");
    if (runtimePanel) {
      const collapsed = runtimePanel.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    }
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  // Icon is a static inline SVG in index.html; keep it as-is regardless of
  // sidebar open/closed state. (Previously this overwrote the SVG with the
  // "\u2630" text glyph on first toggle, changing the icon's appearance.)
}

function toggleSidebar() {
  sidebarEl.classList.toggle("collapsed");
  sidebarOverlay.classList.toggle(
    "visible",
    !sidebarEl.classList.contains("collapsed") && isMobile(),
  );
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener("click", toggleSidebar);

sidebarOverlay.addEventListener("click", () => {
  sidebarEl.classList.add("collapsed");
  sidebarOverlay.classList.remove("visible");
  updateSidebarToggleIcon();
});

refreshSessionsBtn.addEventListener("click", () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  // Static glyph policy: refresh never spins. A pending refresh disables the
  // button and flips aria-busy so assistive tech announces the busy state.
  refreshSessionsBtn.disabled = true;
  refreshSessionsBtn.setAttribute("aria-busy", "true");
  sidebar
    .loadSessions()
    .then(() => {
      if (isMirrorMode) updateMirrorLiveIndicator();
    })
    .catch((error) => {
      console.error("[Sessions] refresh failed:", error);
    })
    .finally(() => {
      refreshSessionsBtn.disabled = false;
      refreshSessionsBtn.removeAttribute("aria-busy");
    });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      // Only track swipes starting within 20px of left edge
      if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains("collapsed")) {
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        tracking = true;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartX;
      const dy = Math.abs(touch.clientY - touchStartY);
      // If vertical movement dominates, cancel
      if (dy > dx) {
        tracking = false;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      if (dx > 60) {
        sidebarEl.classList.remove("collapsed");
        sidebarOverlay.classList.add("visible");
      }
    },
    { passive: true },
  );
})();

// Session search
setupSidebarSearchControl({
  input: sessionSearchInput,
  clearButton: sessionSearchClearBtn,
  onChange: (value) => sidebar.setSearchQuery(value),
});

// Cmd/Ctrl-K spotlight dialog overlay. Reuses the sidebar search input as
// the trigger so focus, click, and the global shortcut all open the same
// dialog. The sidebar in-line filter keeps running in parallel — the dialog
// only changes the visible affordance.
function flattenSidebarSessionsToSearchRows() {
  const currentPath = getCurrentWorkspacePath();
  const rows = [];
  for (const project of sidebar?.projects ?? []) {
    const projectName = project.folderName || project.dirName || "";
    const projectPath = project.path || project.dirName || "";
    const isCurrentWorkspace = !!currentPath && projectPath === currentPath;
    for (const session of project.sessions ?? []) {
      if (!session?.filePath) continue;
      rows.push({
        id: session.filePath,
        name: session.name || "",
        firstMessage: session.firstMessage || "",
        projectName,
        projectPath,
        isCurrentWorkspace,
      });
    }
  }
  return rows;
}

setupSessionSearchDialog({
  triggerInput: sessionSearchInput,
  triggerClear: sessionSearchClearBtn,
  overlay: sessionSearchOverlay,
  dialog: sessionSearchDialog,
  input: sessionSearchDialogInput,
  list: sessionSearchResults,
  // v3 has no message-level search RPC; the dialog tolerates `data` being
  // absent and falls back to title-only matching.
  data: undefined,
  getWorkspaceId: () => undefined,
  getSessions: flattenSidebarSessionsToSearchRows,
  onSelect: (session) => {
    if (!session?.id) return;
    for (const project of sidebar?.projects ?? []) {
      const target = (project.sessions ?? []).find((item) => item.filePath === session.id);
      if (target) {
        switchSession(target.filePath, target, project);
        return;
      }
    }
  },
});

/**
 * Reset the chat surface to a fresh "new session" view inside the current window.
 * Clears renderers/state, unmarks the active sidebar item and refreshes the list
 * so the newly created session shows up once pi writes its first message to disk.
 */
function setComposerDraft(value) {
  messageInput.value = value || "";
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

function persistComposerDraft() {
  if (activeUiSessionFile) sessionUiState.saveDraft(activeUiSessionFile, messageInput.value);
}

function restoreSessionUiState(sessionFile) {
  const next = sessionFile || null;
  // Bump the guard token only when the bound session actually changes, so
  // repeated restores of the same session don't needlessly invalidate an
  // in-flight profile restore.
  if (next !== activeUiSessionFile) {
    activeUiSessionFile = next;
    uiSessionGeneration += 1;
  }
  setComposerDraft(activeUiSessionFile ? sessionUiState.loadDraft(activeUiSessionFile) : "");
}

function saveCurrentSessionProfile() {
  if (!activeUiSessionFile) return;
  const model = availableModels.find((entry) => entry.id === currentModelId);
  if (!model?.provider || !model.id) return;
  void sessionUiState.saveProfile({
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: currentThinkingLevel || "off",
  });
}

async function applySessionUiProfile(sessionFile) {
  // pi's set_model / set_thinking_level reconfigure the harness bound to the
  // CURRENT active session (writes are deferred to that session's pending
  // writes when mid-turn), not a global defaults file. Because this runs in
  // the foreground mirror_sync path, the active pi session is the one we just
  // restored, so the profile sticks to its session and never leaks into Pi's
  // global config or another session.
  restoreSessionUiState(sessionFile);
  const generation = uiSessionGeneration;
  const reported = {
    modelId: currentModelId,
    thinkingLevel: currentThinkingLevel || "off",
  };
  const profile = await sessionUiState.loadProfile();
  if (generation !== uiSessionGeneration) return;
  if (!profile) {
    // Snapshot-on-first-see: pi restores sessions that never had an explicit
    // model/thinking change from the GLOBAL defaults, and pi's setModel /
    // setThinkingLevel also rewrite those defaults. So changing model/thinking
    // in session A silently drifts the defaults that a never-customized
    // session B restores from. Snapshotting every viewed session's reported
    // state pins it: the next restore replays this profile instead of
    // inheriting whatever default session A last wrote.
    snapshotReportedProfile(reported);
    return;
  }
  const model = availableModels.find(
    (entry) => entry.provider === profile.provider && entry.id === profile.modelId,
  );
  if (!model) {
    // availableModels may not have loaded yet (cold mirror_sync racing the
    // /api/models fetch). Log instead of silently dropping the context window.
    console.warn(
      "[session-ui] profile model not yet in registry:",
      `${profile.provider}/${profile.modelId}`,
    );
  }
  // Short-circuit when the restored state already matches the profile: pi
  // restored this session's own settings (or the snapshot equals them), so
  // replaying set_model/set_thinking_level would only rewrite pi's GLOBAL
  // defaults with this session's values for no user-visible gain.
  const modelAlreadyMatches = reported.modelId === profile.modelId;
  const thinkingAlreadyMatches = reported.thinkingLevel === profile.thinkingLevel;
  if (modelAlreadyMatches && thinkingAlreadyMatches) return;
  const modelResult = modelAlreadyMatches
    ? { success: true, data: null }
    : await rpcCommand(
        { type: "set_model", provider: profile.provider, modelId: profile.modelId },
        null,
        true,
      );
  // The user may have switched sessions while set_model was in flight. If so,
  // abandon this restore so it cannot overwrite the now-active session's UI.
  if (generation !== uiSessionGeneration) return;
  if (modelResult?.success) {
    currentModelId = profile.modelId;
    if (modelResult.data?.thinkingLevel) {
      currentThinkingLevel = modelResult.data.thinkingLevel;
    }
    updateThinkingBtn();
    updateModelLabel();
    const contextWindow = model?.contextWindow;
    if (contextWindow) {
      contextWindowSize = contextWindow;
      updateTokenUsage();
    }
  }
  if (profile.thinkingLevel && !thinkingAlreadyMatches) {
    const thinkingResult = await rpcCommand(
      { type: "set_thinking_level", level: profile.thinkingLevel },
      null,
      true,
    );
    if (generation !== uiSessionGeneration) return;
    if (thinkingResult?.success) {
      currentThinkingLevel = thinkingResult.data?.level || profile.thinkingLevel;
      updateThinkingBtn();
    }
    // Re-pinning after a successful replay keeps the profile's updated_at
    // fresh and captures any clamping the runtime applied, so the next
    // restore replays exactly what this session last showed.
    if (generation === uiSessionGeneration) saveCurrentSessionProfile();
  }
}

function snapshotReportedProfile(reported) {
  // Only pin when the model registry can resolve a provider for the reported
  // id; a cold-start race (mirror_sync before /api/models) simply skips this
  // snapshot and retries on the next sync.
  const model = availableModels.find((entry) => entry.id === reported.modelId);
  if (!model?.provider || !model.id) return;
  void sessionUiState.saveProfile({
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: reported.thinkingLevel,
  });
}

async function resetUiForNewSession() {
  pendingNewSessionPreviousFile =
    mirrorActiveSessionFile ||
    sidebar.activeSessionFile ||
    liveInstances.find((i) => i?.port === foregroundPort)?.sessionFile ||
    null;
  state.reset();
  clearConversationRenderers();
  filePreviewFollow.clear();
  cancelFileBrowserRefresh();
  renderWorkspaceWelcome();
  sidebar.clearActive();
  resolveAndApplyFocus();
  updateSuperAgentActiveState(null, null);
  mirrorActiveSessionFile = null;
  viewingActiveSession = true;
  pendingSessionSwitchPath = null;
  restoreSessionUiState(null);
  updateMirrorInputState();
  updateUI();

  // A brand-new session starts with no prior aggregate or context usage.
  resetHeaderStatusBar();

  // Mark that the next assistant turn should refresh the sidebar, since pi
  // doesn't persist a brand-new session to disk until the first message round-trip.
  pendingNewSessionRefresh = true;

  pollInstances().catch(() => {});
  sidebar.loadSessions().catch(() => {});
}

async function activateNewParallelSession(port, cwd) {
  logSessionRoute("activateNewParallelSession:start", { port, cwd });
  foregroundPort = port;
  portSessionMap.delete(port);
  if (cwd) {
    foregroundWorkspacePath = cwd;
    updateWorkspaceIndicator(cwd);
    // Defer the file browser load: the new pi's server is not yet scoped to
    // `cwd` until its session_start fires. Setting the pending token makes
    // `refreshFileBrowserForWorkspace` (including the 5s poll path) skip the
    // load; `handleMirrorSync` clears it and fires the authoritative load once
    // the new server confirms. sessionFile is null — the file isn't assigned
    // until pi's first message round-trip.
    pendingFileBrowserWorkspace = deferFileBrowserWorkspace(null, cwd, fileBrowserWorkspacePath);
  }
  wsClient.setRoutingContext({
    workspaceId: `workspace:${cwd || getCurrentWorkspacePath() || "unknown"}`,
    sessionId: null,
    sourcePort: foregroundPort,
  });
  await resetUiForNewSession();
  pollInstances().catch(() => {});
  logSessionRoute("activateNewParallelSession:done", { port, cwd });
}

async function newSession() {
  if (isSuperAgentSession(null, { path: getCurrentWorkspacePath() }, superAgentPath)) {
    messageRenderer.renderSystemMessage("Agent Inbox uses one shared session.");
    return;
  }

  if (nativeAvailable()) {
    // Always create the new chat in-place on the current pi process: pi's
    // `new_session` RPC aborts/settles any active stream safely (it persists
    // the aborted turn to the old session before switching), so there is no
    // need to spawn a dedicated process while streaming. Spawning a parallel
    // process would force a cross-port page navigation (full reload + white
    // flash), which we deliberately avoid.
    await startInWindowNewSession({
      transport,
      getCurrentCwd: getCurrentWorkspacePath,
      getCurrentPort: getActivePort,
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      shouldSpawnParallel: () => false,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      onParallelSessionCreated: activateNewParallelSession,
      renderError: (message) => messageRenderer.renderError(message),
    });
    return;
  }

  if (canUseSessionControl()) {
    lastInputTokens = 0;
    resetHeaderStatusBar();
    updateTokenUsage();
    try {
      await transport.newSession(getActivePort());
      await resetUiForNewSession();
    } catch (_err) {
      messageRenderer.renderError(t("errors.newSessionFailed"));
      return;
    }
    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
    return;
  }

  // Browser/dev fallback: classic in-place "new session" against the same
  // pi process (no Tauri windows available in this mode).
  lastInputTokens = 0;
  resetHeaderStatusBar();
  updateTokenUsage();
  const data = await rpcCommand({ type: "new_session" }, t("status.startingNewSession"));
  if (data?.success === false || data?.data?.cancelled) {
    messageRenderer.renderError(data?.error || t("errors.newSessionCancelled"));
    return;
  }
  await resetUiForNewSession();

  if (isMobile()) {
    sidebarEl.classList.add("collapsed");
    sidebarOverlay.classList.remove("visible");
  }
  if (!isMobile()) messageInput.focus();
}

async function handleNewProjectChat(project) {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    if (!canUseSessionControl()) {
      const targetPath = project?.path || "";
      const currentPath = getCurrentWorkspacePath();
      const singleProject =
        Array.isArray(sidebar.projects) && sidebar.projects.length === 1
          ? sidebar.projects[0]
          : null;
      const isCurrentProject =
        !targetPath ||
        targetPath === currentPath ||
        (!currentPath && singleProject?.path === targetPath);
      if (isCurrentProject) {
        await newSession();
      } else {
        messageRenderer.renderError(t("errors.mobileBrokerRequired"));
      }
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    // Prefer reuse: same project => in-place new_session on current process,
    // even while streaming (pi's new_session RPC aborts/settles the active
    // turn safely). Only mobile mode keeps the spawn path (its window model
    // cannot reuse the current process).
    const launched = await startNewProjectChat({
      project,
      transport,
      getCurrentPort: getActivePort,
      getCurrentCwd: getCurrentWorkspacePath,
      shouldSpawnParallel: () => mobileClientMode,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      onParallelSessionCreated: mobileClientMode ? null : activateNewParallelSession,
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      beforeWorkspaceTransition: prepareEphemeralWorkspaceTransition,
      onWorkspaceTransitionCancelled: cancelEphemeralWorkspaceTransition,
      renderError: (message) => messageRenderer.renderError(message),
    });
    if (!launched) return;

    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
}

// Public entry point: serializes selections so overlapping clicks don't
// interleave their awaits and corrupt shared routing state.
function handleSessionSelect(session, project) {
  const run = sessionSelectChain.then(() => handleSessionSelectImpl(session, project));
  // Keep the chain alive even if this selection rejects.
  sessionSelectChain = run.catch(() => {});
  return run;
}

async function handleSessionSelectImpl(session, project) {
  logSessionRoute("select:start", {
    selectedSession: session?.filePath,
    projectPath: project?.path,
    projectDir: project?.dirName,
    liveInstances,
  });
  // Drop the previous session's todo snapshot before any async work. The
  // history load below is the only path that re-hydrates the panel, and if
  // it fails or short-circuits (missing dirName/file, fetch error, no
  // entries) we don't want the prior turn's list still pinned in the
  // composer. clear() also drops the sticky is-hover-expanded class.
  todoMirrorPanel.clear();
  // Pending write-tool paths belong to the previous session's run; don't
  // let a stale toolCallId surface another session's file.
  filePreviewFollow.clear();
  cancelFileBrowserRefresh();
  // An explicit session selection supersedes any pending deferred switch.
  // Leaving it set would (a) suppress all live rendering for the newly
  // selected session via the `pendingSessionSwitchPath` guard in
  // `handleRPCEvent`, and (b) yank the user to the stale deferred target on
  // the next `agent_end`. Clearing it here is what keeps tool-call/streaming
  // updates flowing after an A → B → A switch.
  if (pendingSessionSwitchPath && pendingSessionSwitchPath !== session.filePath) {
    logSessionRoute("select:clear-stale-deferred", {
      pendingSessionSwitchPath,
      selectedSession: session?.filePath,
    });
    pendingSessionSwitchPath = null;
  }
  persistComposerDraft();
  sidebar.setActive(session.filePath);
  restoreSessionUiState(session.filePath);
  resolveAndApplyFocus();
  updateSuperAgentActiveState(session, project);
  const targetLiveInstance = liveInstances.find(
    (instance) => instance.sessionFile === session.filePath,
  );
  foregroundPort = findPortForSession(liveInstances, session.filePath, foregroundPort);
  // Record the deferred target BEFORE touching the workspace indicator. The
  // mirror_sync handler consumes this token to fire the authoritative file-tree
  // load once the new server's session_start confirms the switch.
  const selectedWorkspacePath = session?.cwd || project?.path || "";
  pendingFileBrowserWorkspace = deferFileBrowserWorkspace(
    session.filePath,
    selectedWorkspacePath,
    fileBrowserWorkspacePath,
  );
  // Cross-workspace select: the session's recorded cwd owns the
  // workspace label and file tree, regardless of whether a live pi for it
  // exists yet. `syncWorkspaceIndicatorFromInstances` reads from
  // liveInstances (which is stale here — foregroundPort still points at the
  // previous workspace's process for a history session), so set the
  // foreground workspace from the session cwd explicitly. The pending token
  // defers the file-tree load until mirror_sync confirms the new server.
  if (selectedWorkspacePath && selectedWorkspacePath !== fileBrowserWorkspacePath) {
    foregroundWorkspacePath = selectedWorkspacePath;
    updateWorkspaceIndicator(selectedWorkspacePath);
    updateSuperAgentActiveStateFromWorkspace();
    // When the target workspace has no persisted file tabs, collapse the
    // editor panel immediately instead of waiting ~2-3s for mirror_sync to
    // drive setWorkspaceRoot. hasPersistedTabs peeks storage without
    // switching state, so switching back to a workspace that DOES have tabs
    // is left to setWorkspaceRoot (no collapse-then-reopen flicker).
    if (!filePreviewPanel.hasPersistedTabs?.(selectedWorkspacePath)) {
      filePreviewPanel.hidePanel();
    }
    // A workspace switch changes the HTTP origin that serves the file API.
    // Navigate before any branch can fall through to an in-process switch.
    const targetPort = targetLiveInstance?.port ?? foregroundPort;
    if (typeof targetPort === "number") {
      try {
        if (targetPort !== getCurrentPort()) {
          await navigateToWorkspacePort(selectedWorkspacePath, targetPort);
          return;
        }
        // A same-port workspace switch does not navigate, but it still must
        // commit the owner workspace transition. Otherwise the broker keeps
        // the first workspace's root and generation forever, and every Git
        // status request continues to read that original repository.
        const prepared = await transport.prepareWorkspaceTarget(selectedWorkspacePath, {
          targetPort,
          reuseExisting: true,
        });
        if (typeof prepared?.transitionGeneration !== "number") {
          throw new Error("Workspace transition was not prepared");
        }
        await transport.commitWorkspaceTransition(prepared.transitionGeneration);
      } catch (error) {
        console.error("[Session route] workspace transition failed:", error);
      }
    }
    // Clear stale Git panel state so old workspace files never leak in.
    gitPanel.snapshot = null;
    gitPanel.notGitRepo = false;
    gitPanel.gitUnavailable = false;
    gitPanel.selected = new Set();
    gitPanel.commitMessage = "";
    gitPanel.pendingConfirmationToken = null;
    if (!gitPanelElement.classList.contains("hidden")) void gitPanel.refresh();
  } else {
    syncWorkspaceIndicatorFromInstances();
  }
  // Do not load the target workspace yet. `switch_session` only acknowledges
  // the RPC write; the current server remains scoped to the previous
  // workspace until its replacement extension sends a mirror snapshot.
  if (session.filePath) {
    wsClient.setRoutingContext({
      workspaceId: `workspace:${selectedWorkspacePath || getCurrentWorkspacePath() || "unknown"}`,
      sessionId: session.filePath,
      sourcePort: foregroundPort,
    });
  }
  logSessionRoute("select:routed", {
    selectedSession: session.filePath,
    targetLiveInstance,
  });
  lastInputTokens = 0;
  resetHeaderStatusBar();
  updateTokenUsage();

  // Native host: switch session via control command to the current pi instance
  if (nativeAvailable() && session.filePath) {
    pendingMirrorSessionFile = session.filePath;
    const wasStreaming = state.isStreaming;
    clearMessageQueue();
    state.reset();
    if (sidebar.isStreaming(session.filePath)) {
      state.setStreaming(true);
      showTypingIndicator(true);
    } else {
      showTypingIndicator(false);
    }
    updateUI();
    await renderSelectedSessionHistory(session, project);

    if (targetLiveInstance) {
      logSessionRoute("select:target-live-sync", {
        selectedSession: session.filePath,
        targetPort: targetLiveInstance.port,
      });
      mirrorActiveSessionFile = session.filePath;
      sessionInfo.refresh();
      viewingActiveSession = true;
      updateMirrorInputState();
      wsClient.send({ type: "mirror_sync_request" });
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    const selectedProjectCwd = selectedWorkspacePath;

    // A non-streaming session switch can safely reuse the current Pi process.
    // This preserves the single-page UI and lets the authoritative mirror
    // snapshot update the server workspace before refreshing the file tree.
    if (wasStreaming) {
      if (transport.spawnSessionProcess) {
        let targetPort = null;
        try {
          const cwd = selectedProjectCwd || getCurrentWorkspacePath();
          targetPort = await transport.spawnSessionProcess(session.filePath, cwd);
        } catch (e) {
          console.error(
            "[App] Failed to spawn session process, falling back to deferred/current switch:",
            e,
          );
        }
        if (targetPort != null) {
          logSessionRoute("select:spawned-dedicated", {
            selectedSession: session.filePath,
            targetPort,
          });
          foregroundPort = targetPort;
          portSessionMap.set(targetPort, session.filePath);
          wsClient.setRoutingContext({
            sessionId: session.filePath,
            sourcePort: foregroundPort,
          });
          try {
            await navigateToWorkspacePort(selectedWorkspacePath, targetPort);
            return;
          } catch (error) {
            console.error("[Session route] workspace navigation failed:", error);
          }
          pollInstances().catch(() => {});
          wsClient.send({ type: "mirror_sync_request" });
          if (isMobile()) {
            sidebarEl.classList.add("collapsed");
            sidebarOverlay.classList.remove("visible");
          }
          return;
        }
      }
      if (wasStreaming) {
        messageRenderer.renderError("Failed to open session in its workspace process.");
        if (isMobile()) {
          sidebarEl.classList.add("collapsed");
          sidebarOverlay.classList.remove("visible");
        }
        return;
      }
      // Fallback: defer the switch until the current agent run ends.
      // This preserves the old safe behavior when spawn is unavailable or fails.
      pendingSessionSwitchPath = session.filePath;
      updateUI();
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    try {
      logSessionRoute("select:switch-current-process", {
        selectedSession: session.filePath,
        targetPort: foregroundPort,
      });
      await transport.switchSession(session.filePath, foregroundPort);
      wsClient.send({ type: "mirror_sync_request" });
    } catch (e) {
      if (pendingMirrorSessionFile === session.filePath) pendingMirrorSessionFile = null;
      messageRenderer.renderError(t("errors.failedToSwitchSession", { error: e }));
    }
    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
    return;
  }

  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add("collapsed");
    sidebarOverlay.classList.remove("visible");
  }
}

async function renderSelectedSessionHistory(session, project) {
  clearConversationRenderers();
  if (!session || !project) {
    renderWorkspaceWelcome();
    return;
  }

  messageRenderer.renderSystemMessage(t("status.loadingSession"));
  const dirName = project?.dirName;
  const file = session.file;
  if (!dirName || !file) {
    logSessionRoute("history:skip-missing-path", {
      selectedSession: session?.filePath,
      dirName,
      file,
    });
    return;
  }

  try {
    const url = `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}`;
    logSessionRoute("history:fetch", {
      url,
      selectedSession: session.filePath,
      dirName,
      file,
    });
    const res = await fetch(url);
    logSessionRoute("history:fetch-result", {
      url,
      status: res.status,
      ok: res.ok,
    });
    const data = await res.json();
    clearConversationRenderers();
    logSessionRoute("history:render", {
      selectedSession: session.filePath,
      entries: data.entries?.length || 0,
    });
    renderSessionHistory(data.entries || [], {
      searchQuery: sidebar.searchQuery,
    });
  } catch (e) {
    console.error("[Session route] history:fetch-error", {
      selectedSession: session?.filePath,
      error: e,
    });
    messageRenderer.renderError(t("errors.failedToLoadSession", { error: e }));
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    state.reset();
    clearConversationRenderers();
    // Drop the previous session's todo snapshot — the next renderSessionHistory
    // call below will rehydrate from the new session's history if applicable.
    todoMirrorPanel.clear();
    filePreviewFollow.clear();
    cancelFileBrowserRefresh();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage(t("status.loadingSession"));

      const dirName = project?.dirName;
      const file = session.file;
      console.log("[App] Loading history:", { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(
            `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}`,
          );
          console.log("[App] History fetch status:", res.status);
          const data = await res.json();
          console.log("[App] History entries:", data.entries?.length || 0);

          clearConversationRenderers();
          renderSessionHistory(data.entries || [], { searchQuery: sidebar.searchQuery });
        } catch (e) {
          console.error("[App] History fetch error:", e);
        }
      } else {
        console.log("[App] Skipped history load: dirName or file missing");
      }
    } else {
      renderWorkspaceWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      const liveInstance = liveInstances.find((i) => i.sessionFile === sessionFile);
      if (liveInstance) {
        foregroundPort = liveInstance.port;
        syncWorkspaceIndicatorFromInstances();
        mirrorActiveSessionFile = sessionFile;
        sessionInfo.refresh();
        viewingActiveSession = true;
        wsClient.setRoutingContext({
          workspaceId: `workspace:${liveInstance.cwd || getCurrentWorkspacePath() || "unknown"}`,
          sessionId: sessionFile,
          sourcePort: foregroundPort,
        });
        updateMirrorInputState();
        wsClient.send({ type: "mirror_sync_request" });
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: "mirror_sync_request" });
      }
    } else {
      const res = await fetch("/api/sessions/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(t("errors.failedToSwitchSession", { error: err.error }));
      }
    }
  } catch (error) {
    console.error("[App] Failed to switch session:", error);
    messageRenderer.renderError(t("errors.failedToSwitchSessionShort"));
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  logSessionRoute("mirrorSync:received", {
    sessionFile: data.sessionFile,
    sessionId: data.sessionId,
    workspaceId: data.workspaceId,
    entries: data.entries?.length || 0,
    isStreaming: data.isStreaming,
  });
  if (!sessionsLoaded) {
    deferredMirrorSync = data;
    return;
  }

  // The broker broadcasts every upstream's `mirror_sync` to all UI clients,
  // including snapshots a *background* pi process emits on its own
  // `session_start` (e.g. the previously-running session that keeps streaming
  // after the user switched to an older session). Such a stray snapshot must
  // NOT hijack the foreground UI: applying it would clobber the rendered
  // history AND — critically — reset the routing context to the background
  // process's session/port, causing the user's next message to be sent into
  // that previous session instead of the one they're now viewing.
  const syncPort = typeof data.port === "number" ? data.port : null;
  const appliedForegroundSession = applyForegroundMirrorSession({
    syncPort,
    foregroundPort,
    sessionFile: data.sessionFile,
    expectedSessionFile: pendingMirrorSessionFile,
    setMirrorActiveSessionFile: (filePath) => {
      mirrorActiveSessionFile = filePath;
    },
    setSidebarActive: (filePath) => {
      sidebar.setActive(filePath);
      restoreSessionUiState(filePath);
      resolveAndApplyFocus();
    },
  });
  if (!appliedForegroundSession) {
    logSessionRoute("mirrorSync:ignored-background", {
      syncPort,
      foregroundPort,
      sessionFile: data.sessionFile,
    });
    const bgFile = data.sessionFile || data.sessionId;
    if (bgFile) {
      const bgStreaming = Boolean(data.isStreaming);
      sidebar.setStreaming(bgFile, bgStreaming);
      updateMirrorLiveIndicator();
    }
    return;
  }

  // Consume a fork's deferred composer prefill. setSidebarActive above has
  // already rebound activeUiSessionFile and restored the saved draft, so this
  // is the first point where applying the prefill cannot be wiped — and
  // persistComposerDraft then saves it under the forked session file.
  if (
    pendingPostSyncComposer &&
    activeUiSessionFile !== pendingPostSyncComposer.previousSessionFile
  ) {
    const prefill = pendingPostSyncComposer;
    pendingPostSyncComposer = null;
    setComposerDraft(prefill.text);
    persistComposerDraft();
  }

  if (
    pendingMirrorSessionFile &&
    isExpectedMirrorSession(pendingMirrorSessionFile, data.sessionFile)
  ) {
    pendingMirrorSessionFile = null;
  }

  console.log("[Mirror] Received state snapshot:", data.entries?.length, "entries");
  isMirrorMode = true;
  if (data.sessionFile) portSessionMap.set(foregroundPort, data.sessionFile);

  // Track the foreground session route.
  const pendingWorkspace = confirmDeferredFileBrowserWorkspace(
    pendingFileBrowserWorkspace,
    data.sessionFile,
  );
  // The server's mirror workspace is authoritative. A sidebar project path can
  // differ from the session cwd (for example, when a session was moved or
  // imported), and using it would make /api/files reject the path as outside
  // the process workspace.
  const syncWorkspacePath = workspacePathFromId(data.workspaceId) || pendingWorkspace?.path || "";
  if (syncWorkspacePath) {
    foregroundWorkspacePath = syncWorkspacePath;
    updateWorkspaceIndicator(syncWorkspacePath);
    updateSuperAgentActiveStateFromWorkspace();
    infoPanel?.updateWorkspace(syncWorkspacePath);
  }
  if (pendingWorkspace) {
    pendingFileBrowserWorkspace = null;
  }
  // Refresh the file tree whenever the mirror-synced workspace differs from
  // the one currently shown. The select path defers its load to here (via
  // pendingWorkspace), but a workspace can also change without a deferred
  // token — e.g. a reload landing on a new port, or an in-place switch whose
  // pending token was cleared by an earlier sync. Force-refreshing on any
  // divergence is what keeps the tree in sync once the server's session_start
  // has rebound latestCtx to the right workspace.
  if (syncWorkspacePath && syncWorkspacePath !== fileBrowserWorkspacePath) {
    void refreshFileBrowserForWorkspace(syncWorkspacePath, { force: true }).catch((error) => {
      console.error("[App] Failed to refresh file browser after session switch:", error);
    });
    // Reset the Git panel state and probe the newly-active workspace on every
    // entry (not only when the panel is open). The generation-guarded
    // git_status / git_command_failed result both drives the Git tab's
    // visibility and repaints the panel with the new workspace's files instead
    // of a stale snapshot; the file browser refreshes separately via
    // refreshFileBrowserForWorkspace above.
    gitPanel.snapshot = null;
    gitPanel.notGitRepo = false;
    gitPanel.gitUnavailable = false;
    gitPanel.selected = new Set();
    gitPanel.commitMessage = "";
    gitPanel.pendingConfirmationToken = null;
    // Probe the new workspace's Git status on EVERY entry, not just when the
    // Git panel is already open. The git_command_failed / git_status result is
    // the authoritative, generation-safe signal that drives the Git tab's
    // visibility — a non-Git workspace hides its tab on entry, before it is
    // ever clicked open.
    void gitPanel.refresh();
    // Fast-path hint only: syncGitEntryForWorkspace never forces the tab
    // visible on a non-OK probe; the git status probe above is the source of
    // truth for the newly-active workspace.
    void syncGitEntryForWorkspace(data.workspaceId);
  }
  wsClient.setRoutingContext({
    workspaceId:
      (syncWorkspacePath && `workspace:${syncWorkspacePath}`) ||
      data.workspaceId ||
      `workspace:${getCurrentWorkspacePath() || "unknown"}`,
    sessionId: data.sessionId || data.sessionFile || null,
    sourcePort: data.port || foregroundPort,
  });
  viewingActiveSession = true;
  // The snapshot's `isStreaming` comes from the pi process's instantaneous
  // `!ctx.isIdle()`, which can momentarily read false between messages / tool
  // calls of an agent run that is still actively going. The sidebar's
  // streaming set is driven by real `agent_start` / `agent_end` events and is
  // the more reliable signal for a background session we're switching into, so
  // OR the two: only treat the session as idle when both agree it is idle.
  const liveFile = data.sessionFile || mirrorActiveSessionFile;
  const sidebarStreaming = liveFile ? sidebar.isStreaming(liveFile) : false;
  const isStreaming = Boolean(data.isStreaming) || sidebarStreaming;
  state.setStreaming(isStreaming);
  showTypingIndicator(isStreaming);
  if (liveFile) sidebar.setStreaming(liveFile, isStreaming);
  updateMirrorInputState();
  updateMirrorLiveIndicator();
  updateUI();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || "";
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }
  if (data.defaultThinkingLevel) {
    currentDefaultThinkingLevel = data.defaultThinkingLevel;
    renderThinkingEffort(currentDefaultThinkingLevel, {
      thinkingSteps: thinkingEffortSteps,
      thinkingMarker: thinkingEffortMarker,
      thinkingName: thinkingEffortName,
    });
  }
  void applySessionUiProfile(data.sessionFile || null);

  // Clear and render message history. A lifecycle event from the previous
  // route must not leave the newly selected session's compact controls busy.
  compactCoordinator.reset();
  clearConversationRenderers();
  lastInputTokens = 0;
  // Reset the aggregate before history replay; the authoritative hydration
  // runs after render so replayed totals never double-count.
  resetHeaderStatusBar();

  // Keep Welcome stable when there are already sessions in the sidebar and
  // the user has not explicitly selected one yet.
  if (!sidebar.activeSessionFile && hasAnySessionsLoaded()) {
    renderWorkspaceWelcome();
    updateTokenUsage();
    void hydrateHeaderSessionStats();
    return;
  }

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries, { searchQuery: sidebar.searchQuery, leafId: data.leafId });
  } else {
    renderWorkspaceWelcome();
  }
  // The Info tree consumes the same authoritative snapshot (entries + active
  // leaf) the transcript just rendered from. While the Info tab is hidden,
  // skip the model+DOM rebuild: mark dirty instead, and the tab switch's
  // refreshInfoTree pulls a fresh full snapshot (never a stale cache).
  if (infoPanel && infoPanelEl && !infoPanelEl.classList.contains("hidden")) {
    infoPanel.updateTree({ entries: data.entries || [], leafId: data.leafId ?? null });
    infoTreeDirty = false;
  } else {
    infoTreeDirty = true;
  }

  updateTokenUsage();
  // Hydrate the aggregate from the authoritative server totals now that
  // history replay is done. Repeated mirror syncs replace (never accumulate).
  void hydrateHeaderSessionStats();
}

// Mark sessions in the sidebar with a green dot only when actively streaming
function updateMirrorLiveIndicator() {
  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("mirror-live", sidebar.streamingFiles.has(el.dataset.filePath));
  });
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch("/api/instances");
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      logSessionRoute("instances:poll", {
        count: liveInstances.length,
        instances: liveInstances,
      });
      updateMirrorLiveIndicator();
      syncWorkspaceIndicatorFromInstances();
      if (document.querySelector(".welcome")) {
        renderWorkspaceWelcome();
      }
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  if (!isMirrorMode) return;

  const inputArea = document.querySelector(".input-area");
  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = t("input.messagePlaceholder");
    inputArea?.classList.remove("mirror-readonly");
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = t("input.mirrorReadOnly");
    inputArea?.classList.add("mirror-readonly");
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

/** True when an assistant message has at least one text block worth showing. */
function assistantHasText(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "text" && String(b.text ?? "").trim().length > 0);
}

/**
 * Split the final assistant message of a turn into the steps that should be
 * folded away (everything up to and including the last non-text block —
 * thinking/tool-calls) and the final answer (trailing text blocks). Mirrors
 * upstream's splitFinalAssistantBlocks in public/native/app.js.
 */
function splitFinalAssistantBlocks(content) {
  if (!Array.isArray(content)) return { processBlocks: [], answerBlocks: [] };
  let lastNonTextIdx = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "text") lastNonTextIdx = i;
  }
  return {
    processBlocks: content.slice(0, lastNonTextIdx + 1),
    answerBlocks: content.slice(lastNonTextIdx + 1),
  };
}

/**
 * Render an assistant message's tool-call blocks as history cards. With a
 * targetContainer they land inside the turn's "Process details" group body
 * instead of the main messages flow. Returns the number of cards created.
 */
function historyTurnWrites(messages, start, end, toolResults) {
  // Mirror the live path: successful write-tool paths for the turn, in
  // first-write order, deduplicated. Tool args carry raw paths (often
  // workspace-relative); chips route through openPath which resolves them
  // the same way the live onWriteApplied path does.
  const writes = [];
  const seen = new Set();
  for (let i = start; i < end; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall" || !isWriteTool(block.name)) continue;
      const result = toolResults.get(block.id);
      if (result?.isError) continue;
      const path = pathFromToolArgs(block.arguments ?? {});
      if (!path || seen.has(path)) continue;
      seen.add(path);
      writes.push({ filePath: path });
    }
  }
  return writes;
}

function renderHistoryToolCallBlocks(blocks, toolResults, targetContainer) {
  let count = 0;
  for (const block of blocks) {
    if (block?.type !== "toolCall") continue;
    count += 1;
    const card = toolCardRenderer.createHistoryCard(
      { toolCallId: block.id, toolName: block.name, args: block.arguments ?? {} },
      targetContainer,
    );
    const result = toolResults.get(block.id);
    if (result) toolCardRenderer.addHistoryResult(block.id, result, result.isError);
    void card;
  }
  return count;
}

function renderSessionHistory(entries, { searchQuery = "", leafId = null } = {}) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0,
    assistantCount = 0,
    toolCardCount = 0,
    toolResultCount = 0;

  // Active-branch filter (Info panel design): when Pi reported the active
  // leaf, the main chat renders ONLY the root→leaf ancestor path — sibling
  // branches live in the Info tree, never inline. Without a leafId (session
  // file previews) the previous render-all behavior applies. The ancestor
  // chain walks Pi's own parentId links; nothing is derived client-side.
  if (typeof leafId === "string" && leafId) {
    const byId = new Map();
    for (const entry of entries) {
      if (entry?.id) byId.set(entry.id, entry);
    }
    const activeIds = new Set();
    let cursor = byId.get(leafId);
    while (cursor && !activeIds.has(cursor.id)) {
      activeIds.add(cursor.id);
      cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
    }
    entries = entries.filter((entry) => activeIds.has(entry?.id));
  }

  // Flatten entries to bare messages; pre-index tool results by toolCallId so
  // tool cards can attach their result during rendering regardless of order.
  // Keep each message's Pi entry id alongside for Info-tree scroll anchors.
  const messages = [];
  const messageEntryIds = [];
  const toolResults = new Map();
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    messages.push(msg);
    messageEntryIds.push(typeof entry.id === "string" ? entry.id : null);
    if (msg.role === "toolResult") toolResults.set(msg.toolCallId, msg);
  }

  // Split into turns anchored at each user message so each turn's
  // thinking/tool-call noise can be folded into one collapsed group, leaving
  // only the user prompt and the final answer visible (mirrors pi-web).
  const turns = [];
  let turnStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i !== turnStart) {
      turns.push([turnStart, i]);
      turnStart = i;
    }
  }
  turns.push([turnStart, messages.length]);

  const renderUserFromMsg = (msg, entryId = null) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    const images = Array.isArray(msg.content)
      ? msg.content
          .filter((b) => b.type === "image")
          .map((b) => ({
            data: b.source?.data || b.data || "",
            mimeType: b.source?.media_type || b.media_type || "image/png",
          }))
      : [];
    if (content || images.length > 0) {
      userCount++;
      const el = renderNavigableUserMessage({
        content: content || "",
        images: images.length > 0 ? images : undefined,
        isHistory: true,
        timestamp: msg.timestamp,
      });
      // Pi entry anchor: the Info tree scrolls the chat to these.
      if (el && entryId) el.dataset.entryId = entryId;
    }
  };

  for (const [start, end] of turns) {
    const anchor = messages[start];
    let bodyStart = start;
    if (anchor?.role === "user") {
      renderUserFromMsg(anchor, messageEntryIds[start]);
      bodyStart = start + 1;
    }

    // The last assistant message that still has visible text is the final
    // answer; everything before it in this turn is process noise.
    let finalAssistantIdx = -1;
    for (let i = end - 1; i >= bodyStart; i--) {
      if (messages[i].role === "assistant" && assistantHasText(messages[i].content)) {
        finalAssistantIdx = i;
        break;
      }
    }

    let group = null;
    let stepCount = 0;
    let toolCallCount = 0;
    const ensureGroup = () => {
      if (!group) {
        group = createProcessDetailsGroup();
        // Insert immediately so later appends (the final answer, or the next
        // turn's user message) land after it in DOM order.
        messagesElement.appendChild(group.wrapper);
      }
      return group;
    };

    for (let i = bodyStart; i < end; i++) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;

      if (i === finalAssistantIdx) {
        const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(msg.content);
        if (processBlocks.some((b) => b.type === "text" || b.type === "thinking")) {
          const el = messageRenderer.renderAssistantMessage(
            { content: processBlocks, usage: msg.usage },
            false,
            true,
            ensureGroup().body,
            /* suppressToolbar */ true,
          );
          if (el) stepCount += 1;
        }
        if (processBlocks.some((b) => b.type === "toolCall")) {
          toolCallCount += renderHistoryToolCallBlocks(
            processBlocks,
            toolResults,
            ensureGroup().body,
          );
        }
        if (answerBlocks.length > 0) {
          const finalEl = messageRenderer.renderAssistantMessage(
            { content: answerBlocks, usage: msg.usage, timestamp: msg.timestamp },
            false,
            true,
          );
          assistantCount++;
          if (finalEl) {
            // Pi entry anchor for the turn's final answer (Info tree target).
            const answerEntryId = messageEntryIds[i];
            if (answerEntryId) finalEl.dataset.entryId = answerEntryId;
            // Rebuild the turn's written-file chips from history so returning to
            // a session shows the same affordance the live turn had.
            const writes = historyTurnWrites(messages, bodyStart, end, toolResults);
            const row = renderTurnFileChips(writes);
            if (row) finalEl.insertAdjacentElement("afterend", row);
          }
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      } else {
        const el = messageRenderer.renderAssistantMessage(
          msg,
          false,
          true,
          ensureGroup().body,
          /* suppressToolbar */ true,
        );
        if (el) stepCount += 1;
        toolCallCount += renderHistoryToolCallBlocks(
          msg.content ?? [],
          toolResults,
          group?.body ?? ensureGroup().body,
        );
      }
    }

    if (group) {
      if (group.body.children.length > 0) {
        group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
      } else {
        group.wrapper.remove();
      }
    }
  }

  toolCardCount = toolCardRenderer.toolCards.size;
  toolResultCount = toolResults.size;
  console.log(
    `[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`,
  );
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll(".tool-card").length);
  console.log(
    `[History] DOM thinking-block count:`,
    document.querySelectorAll(".thinking-block").length,
  );

  if (searchQuery) {
    messageRenderer.highlightSearchQuery(searchQuery);
  }

  // Replay the most recent `todo` tool-result snapshot onto the floating
  // rpiv-todo panel so the user sees prior state when navigating back.
  const todoEntries = [];
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "toolResult") {
      todoEntries.push(entry.message);
    }
  }
  todoMirrorPanel.hydrateFromMessages(todoEntries);

  updateTokenUsage();
  fetchContextWindow();

  anchorHistoryToBottom(document.getElementById("messages"), {
    preserveScrollTarget: Boolean(searchQuery),
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle("hidden", !show);
}

function abortCurrentRun() {
  wsClient.send({ type: "abort" });
  messageRenderer.renderError(t("errors.abortedByUser"));
  showTypingIndicator(false);

  // In some abort paths, backend agent_end can be delayed or missing.
  // Optimistically unlock input so users can continue immediately.
  if (state.isStreaming) {
    state.setStreaming(false);
    currentStreamingElement = null;
    currentStreamingText = "";
    currentStreamingThinking = "";
    updateUI();
  }
}

function updateTokenUsage() {
  if (lastInputTokens <= 0) {
    tokenUsageEl.replaceChildren();
    tokenUsageEl.removeAttribute("title");
    tokenUsageEl.classList.remove("visible", "warning", "critical");
    contextVizController?.invalidateUsage();
    return;
  }

  if (contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = `${pct}%`;
    tokenUsageEl.classList.add("visible");
    tokenUsageEl.classList.remove("warning", "critical");
    if (pct >= 80) {
      tokenUsageEl.classList.add("critical");
    } else if (pct >= 60) {
      tokenUsageEl.classList.add("warning");
    }
    tokenUsageEl.title = t("usage.contextTokens", {
      used: (lastInputTokens / 1000).toFixed(1),
      limit: (contextWindowSize / 1000).toFixed(0),
    });
    // Compact lives only in the context popover now; the header threshold
    // just colors the pill. Clicking it opens the popover with the action.
  } else {
    // No context window info yet, just show raw tokens and suppress the
    // threshold-based action because no percentage can be computed.
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add("visible");
    tokenUsageEl.classList.remove("warning", "critical");
  }

  // Keep an open context popover in sync with fresh usage so the breakdown
  // does not freeze on the snapshot taken when the popover was opened.
  const popover = document.getElementById("context-viz");
  if (popover && !popover.classList.contains("hidden")) contextVizController?.sync();
  // Mirror the current-context signal into the aggregate status bar so its
  // threshold classes (warning/critical) track the same usage value.
  headerStatusBar?.sync({ currentUsage: lastUsage });
}

function requestCompact() {
  void compactCoordinator.request().then((accepted) => {
    statusText.textContent = accepted ? t("status.compacting") : t("status.failed");
  });
}

function syncCompactControls() {
  // Compact lives only in the context popover; keep its busy state in sync.
  contextVizController?.sync();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = "";
let lanUrl = "";
let lanUrls = [];

const lanQrBtn = document.getElementById("lan-qr-btn");
setButtonIcon(lanQrBtn, "smartphone", { size: 16 });
const lanQrModal = document.getElementById("lan-qr-modal");
const lanQrModalBackdrop = document.getElementById("lan-qr-modal-backdrop");
const lanQrModalClose = document.getElementById("lan-qr-modal-close");
const lanQrLoading = document.getElementById("lan-qr-loading");
const lanQrImage = document.getElementById("lan-qr-image");
const lanQrOpenLink = document.getElementById("lan-qr-open-link");
replaceButtonGlyph(lanQrOpenLink, "external-link", { size: 14 });
let lanQrUrl = "";

function updateLanQrButton(url = "") {
  if (!lanQrBtn) return;
  if (url) {
    lanQrBtn.classList.remove("hidden");
  } else {
    lanQrBtn.classList.add("hidden");
  }
}

async function openLanQrModal() {
  if (!lanQrModal) return;
  lanQrModal.classList.remove("hidden");
  if (lanQrLoading) lanQrLoading.style.display = "";
  if (lanQrImage) lanQrImage.classList.add("hidden");
  if (lanQrOpenLink) lanQrOpenLink.classList.add("hidden");
  lanQrUrl = "";
  try {
    const res = await fetch("/api/lan-qr");
    if (!res.ok) throw new Error("unavailable");
    const data = await res.json();
    if (lanQrImage) {
      lanQrImage.src = data.dataUrl;
      lanQrImage.classList.remove("hidden");
    }
    if (typeof data.url === "string" && data.url) {
      lanQrUrl = data.url;
      if (lanQrOpenLink) lanQrOpenLink.classList.remove("hidden");
    }
    if (lanQrLoading) lanQrLoading.style.display = "none";
  } catch {
    if (lanQrLoading) lanQrLoading.textContent = t("misc.qrUnavailable");
  }
}

function closeLanQrModal() {
  if (lanQrModal) lanQrModal.classList.add("hidden");
}

if (lanQrBtn) lanQrBtn.addEventListener("click", openLanQrModal);
if (lanQrModalBackdrop) lanQrModalBackdrop.addEventListener("click", closeLanQrModal);
if (lanQrModalClose) lanQrModalClose.addEventListener("click", closeLanQrModal);
if (lanQrOpenLink)
  lanQrOpenLink.addEventListener("click", () => {
    if (lanQrUrl) openExternalLink(lanQrUrl);
  });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lanQrModal && !lanQrModal.classList.contains("hidden")) {
    closeLanQrModal();
  }
});

async function refreshLanUrl() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    tailscaleUrl = typeof data?.tailscaleUrl === "string" ? data.tailscaleUrl : tailscaleUrl;
    lanUrls = Array.isArray(data?.lanUrls)
      ? data.lanUrls.filter((value) => typeof value === "string" && value.trim())
      : [];
    lanUrl = typeof data?.lanUrl === "string" ? data.lanUrl : "";
    if (!lanUrl && lanUrls.length > 0) lanUrl = lanUrls[0];
    if (tailscaleUrl) {
      statusText.textContent = t("status.connectedTS");
      statusText.title = tailscaleUrl;
    } else if (lanUrl) {
      statusText.textContent = t("status.connectedLAN");
      statusText.title = lanUrl;
    }
    updateLanQrButton(lanUrl);
  } catch {
    updateLanQrButton("");
  }
}

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === "connected") {
    if (tailscaleUrl) {
      statusText.textContent = t("status.connectedTS");
      statusText.title = tailscaleUrl;
    } else if (lanUrl) {
      statusText.textContent = t("status.connectedLAN");
      statusText.title = lanUrl;
    } else {
      statusText.textContent = t("status.connected");
      statusText.title = "";
    }
    // Fetch network link metadata on first connect
    if (!tailscaleUrl && !lanUrl) {
      void refreshLanUrl();
    }
  } else if (status === "disconnected") {
    statusText.textContent = t("status.disconnected");
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;
  const onboarding = updateOnboardingUI();

  composerCard.classList.toggle("streaming", isStreaming);

  if (isStreaming) {
    statusIndicator.classList.add("streaming");
    statusIndicator.classList.remove("connected");
    statusText.textContent = t("status.working");
  } else {
    statusIndicator.classList.remove("streaming");
    statusIndicator.classList.add("connected");
    statusText.textContent = t("status.connected");
  }

  messageInput.disabled = !onboarding.canType;
  sendBtn.disabled = !onboarding.canQuery;

  if (isStreaming) {
    abortBtn.classList.remove("hidden");
    sendBtn.classList.add("hidden");
  } else {
    abortBtn.classList.add("hidden");
    sendBtn.classList.remove("hidden");
    flushQueue();
  }

  // Viewing a history session while original is still streaming —
  // block input until agent_end triggers the deferred switch_session.
  if (pendingSessionSwitchPath) {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    abortBtn.classList.add("hidden");
    messageInput.placeholder = t("input.waitingForSession");
  } else if (onboarding.canQuery) {
    messageInput.placeholder = t("input.typeMessage");
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener("sessionSwitch", () => {
  console.log("[App] Session switched");
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════

const settingsBtn = document.getElementById("settings-btn");
replaceButtonGlyph(settingsBtn, "settings", { size: 18 });
const settingsPanel = document.getElementById("settings-panel");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const settingsBackIcon = settingsClose?.querySelector(".settings-nav-back-icon");
if (settingsBackIcon) {
  const icon = createIcon("chevron-left", { size: 14 });
  if (icon) settingsBackIcon.replaceChildren(icon);
}
const settingsNavItems = Array.from(document.querySelectorAll(".settings-nav-item"));
const settingsTabs = Array.from(document.querySelectorAll(".settings-tab"));
const themeGrid = document.getElementById("theme-grid");
const languageSelect = document.getElementById("settings-language-select");

const toggleAutoCompact = document.getElementById("toggle-auto-compact");
const thinkingEffortSteps = document.getElementById("thinking-effort-steps");
const thinkingEffortMarker = document.getElementById("thinking-effort-marker");
const thinkingEffortName = document.getElementById("thinking-effort-name");
const toggleShowThinking = document.getElementById("toggle-show-thinking");
let toggleSuperAgent = document.getElementById("toggle-super-agent");
const piVersionValue = document.getElementById("setting-pi-version-value");
let piVersionCache = null;
let piVersionInflight = null;
let loadInlineConfigEditor = async () => {};
let loadAgentsMdEditor = async () => {};
let loadAppendSystemMdEditor = async () => {};
let modelsPage = { activate: async () => {} };
let extensionsTabs = null;
let packageManager = null;

async function handleSuperAgentEnabledChanged(enabled) {
  if (!enabled) {
    await stopSuperAgentInstances();
    return;
  }
  await loadSessionsWithSuperAgentBootstrap();
  sessionsLoaded = true;
  updateUI();
  resolveAndApplyFocus();
}

function selectSettingsTab(tabKey = "general") {
  const targetTabKey = tabKey === "auth" ? "configuration" : tabKey;
  settingsNavItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.settingsTab === targetTabKey);
  });
  settingsTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.settingsPanel === targetTabKey);
  });
  if (targetTabKey === "configuration") {
    loadInlineConfigEditor();
    loadAgentsMdEditor();
    loadAppendSystemMdEditor();
  }
  if (targetTabKey === "models") {
    void modelsPage.activate();
  }
  if (targetTabKey === "extensions") {
    extensionsTabs?.select(document.querySelector('[data-extensions-tab="installed"]'));
    // Tab activation is one-time; re-entering the Extensions page must still
    // re-check updates so every Update button starts disabled again.
    void packageManager?.refresh();
  }
  if (targetTabKey === "skills") {
    void skillsPage.activate();
  }
  if (targetTabKey === "chat") {
    toggleSuperAgent = document.getElementById("toggle-super-agent");
    bindSuperAgentStartupToggle(toggleSuperAgent, handleSuperAgentEnabledChanged);
  }
}

function formatPiVersionError(err, fallback = "unknown error") {
  const raw = String(err?.message || err?.error || err || fallback).trim();
  if (!raw) return fallback;
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
}

async function loadPiVersion() {
  if (!piVersionValue) return;
  if (piVersionCache) {
    piVersionValue.textContent = piVersionCache;
    return;
  }
  if (piVersionInflight) {
    return;
  }
  piVersionInflight = (async () => {
    try {
      if (nativeAvailable()) {
        const version = await transport.getPiVersion();
        if (version) {
          piVersionCache = version;
          piVersionValue.textContent = piVersionCache;
        } else {
          piVersionValue.textContent = t("status.unavailableVersion");
        }
      } else {
        const data = await rpcCommand({ type: "get_pi_version" });
        if (data?.success && data.data?.version) {
          piVersionCache = data.data.version;
          piVersionValue.textContent = piVersionCache;
        } else {
          const reason = formatPiVersionError(data?.error, "version missing in response");
          console.error("[settings] failed to load pi version:", data);
          piVersionValue.textContent = t("status.unavailableReason", { reason });
        }
      }
    } catch (err) {
      const reason = formatPiVersionError(err);
      console.error("[settings] failed to load pi version:", err);
      piVersionValue.textContent = t("status.unavailableReason", { reason });
    } finally {
      piVersionInflight = null;
    }
  })();
}

function setExtensionActionButton(button, label, loading = false) {
  if (!button) return;
  if (loading) {
    const spinner = document.createElement("span");
    spinner.className = "settings-btn-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    button.replaceChildren(spinner, text);
    return;
  }
  button.textContent = label;
}

// ═══════════════════════════════════════
// Auto-updater (Tauri-only)
// ═══════════════════════════════════════

const sidebarUpdateBtn = document.getElementById("sidebar-update-btn");
const updater = createAppUpdater({
  transport,
  appVersionValue: document.getElementById("setting-app-version-value"),
  updaterSection: document.getElementById("setting-updater-section"),
  checkUpdatesBtn: document.getElementById("btn-check-updates"),
  updateStatusRow: document.getElementById("setting-update-status-row"),
  updateStatusEl: document.getElementById("setting-update-status"),
  updateInstallRow: document.getElementById("setting-update-install-row"),
  updateInstallLabel: document.getElementById("setting-update-install-label"),
  installUpdateBtn: document.getElementById("btn-install-update"),
  sidebarUpdateBtn,
  onOpenSettings: async () => {
    await openSettings();
    selectSettingsTab("general");
  },
});
void updater.initUpdaterUI();

// Native capabilities arrive asynchronously over the broker WS (the handshake
// frame lands right after connect). Re-evaluate native-gated UI once it's known
// so buttons that were hidden on first paint appear when attached to the host.
wsClient.addEventListener("capabilities", () => {
  refreshHeaderOpenAppButton();
  void loadHeaderOpenApps();
  void updater.initUpdaterUI();
  mountTerminalPanelIfNative();
  // Ephemeral chat entry points are native-only.
  const showEphemeral = nativeAvailable();
  document.getElementById("side-chat-btn")?.classList.toggle("hidden", !showEphemeral);
  document.getElementById("quick-chat-btn")?.classList.toggle("hidden", !showEphemeral);
  if (showEphemeral) {
    void packageManager?.refresh();
    void extensionUpdateIndicator?.refresh();
  }
});

function buildThemeGrid() {
  themeGrid.replaceChildren();
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement("button");
    btn.className = `theme-swatch${current === id ? " active" : ""}`;
    const colors = document.createElement("span");
    colors.className = "swatch-colors";
    for (const color of theme.colors || []) {
      const dot = document.createElement("span");
      dot.className = "swatch-dot";
      dot.style.background = color;
      colors.appendChild(dot);
    }
    btn.appendChild(colors);
    btn.addEventListener("click", (event) => {
      applyTheme(id, { origin: { x: event.clientX, y: event.clientY } });
      // Re-apply the Picot theme to every live xterm instance.
      const xtermTheme = picotThemeToXterm();
      for (const entry of terminalClient.tabs.values()) {
        entry.tab?.setTheme?.(xtermTheme);
      }
      themeGrid.querySelectorAll(".theme-swatch").forEach((s) => {
        s.classList.remove("active");
      });
      btn.classList.add("active");
    });
    themeGrid.appendChild(btn);
  }
}

function refreshUsageIframeLocale() {
  const iframe = document.querySelector(".settings-usage-iframe");
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.location.reload();
}

function buildLanguageSelector() {
  if (!languageSelect) return;
  const current = getLanguagePreference();
  languageSelect.replaceChildren();

  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.value;
    option.textContent = lang.nativeLabel ?? t(lang.labelKey);
    option.selected = current === lang.value;
    languageSelect.append(option);
  }
}

async function handleLanguageSelectChange() {
  languageSelect.disabled = true;
  try {
    await setLocale(languageSelect.value);
    buildLanguageSelector();
    refreshUsageIframeLocale();
  } finally {
    languageSelect.disabled = false;
  }
}

languageSelect?.addEventListener("change", handleLanguageSelectChange);

onLocaleChange(buildLanguageSelector);

onLocaleChange(() => {
  updateThinkingBtn();
  renderQueuedMessages();
  updateUI();
  updateTokenUsage();
  refreshGitBranch();
  repaintContextViz();
});

function normalizeSettingsTabKey(tabKey) {
  const rawTabKey = typeof tabKey === "string" ? tabKey : "general";
  const decodedTabKey = decodeURIComponent(rawTabKey || "general");
  const normalizedTabKey = decodedTabKey === "auth" ? "configuration" : decodedTabKey;
  const navItem = settingsNavItems.find((item) => item.dataset.settingsTab === normalizedTabKey);
  // Disabled nav items (e.g. the temporarily disabled Agent Inbox) are not
  // routable: hash links and programmatic opens fall back to General.
  if (navItem && !navItem.disabled) return normalizedTabKey;
  return "general";
}

function settingsHashForTab(tabKey) {
  return `#/settings/${encodeURIComponent(normalizeSettingsTabKey(tabKey))}`;
}

function updateSettingsHash(tabKey) {
  const nextHash = settingsHashForTab(tabKey);
  if (window.location.hash === nextHash) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
}

function clearSettingsHash() {
  if (!window.location.hash.startsWith("#/settings")) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function openSettings(tabKey = "general", options = {}) {
  const targetTabKey = normalizeSettingsTabKey(tabKey);
  if (options.updateHash !== false) updateSettingsHash(targetTabKey);
  settingsPanel.classList.remove("hidden");
  messagesContainer.style.display = "none";
  document.querySelector(".input-area").style.display = "none";
  document.querySelector(".mode-link:first-child")?.classList.remove("active");
  selectSettingsTab(targetTabKey);
  buildThemeGrid();
  buildLanguageSelector();
  if (piVersionValue) {
    piVersionValue.textContent = piVersionCache || t("status.loading");
  }
  setTimeout(() => {
    if (!settingsPanel.classList.contains("hidden")) loadPiVersion();
  }, 300);
  void refreshLanUrl();
  // Fetch current state for toggles
  try {
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? " on" : ""}`;
      // Thinking level. The get_state request was issued when Settings opened;
      // if the user picked a level in the meantime, that snapshot is stale and
      // must not revert their choice (check-and-reset marker from toggles.js).
      if (!settingsToggles?.takeUserChangedLevel()) {
        currentThinkingLevel = s.thinkingLevel || "off";
        currentDefaultThinkingLevel = s.defaultThinkingLevel || "medium";
        updateThinkingBtn();
        renderThinkingEffort(currentDefaultThinkingLevel, {
          thinkingSteps: thinkingEffortSteps,
          thinkingMarker: thinkingEffortMarker,
          thinkingName: thinkingEffortName,
        });
      }
      // Session name
      inputSessionName.value = s.sessionName || "";
    }
  } catch (_e) {
    // Silent
  }
}

function closeSettings(options = {}) {
  if (options.clearHash !== false) clearSettingsHash();
  settingsPanel.classList.add("hidden");
  messagesContainer.style.display = "";
  document.querySelector(".input-area").style.display = "";
  document.querySelector(".mode-link:first-child")?.classList.add("active");
}

function restorePageFromHash() {
  const route = window.location.hash.slice(1);
  if (route === "/settings" || route.startsWith("/settings/")) {
    const tabKey = route.split("/")[2] || "general";
    void openSettings(tabKey, { updateHash: false });
    return;
  }
  if (!settingsPanel.classList.contains("hidden")) {
    closeSettings({ clearHash: false });
  }
}

async function openUpdatesFromSidebar() {
  await updater.openUpdatesFromSidebar();
}

settingsBtn.addEventListener("click", () => {
  void openSettings();
});
sidebarUpdateBtn?.addEventListener("click", () => {
  openUpdatesFromSidebar().catch((err) => {
    console.warn("[updater] unable to open updates from sidebar:", err);
  });
});
settingsClose.addEventListener("click", closeSettings);
settingsOverlay?.addEventListener("click", closeSettings);
settingsNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    const tabKey = item.dataset.settingsTab || "general";
    selectSettingsTab(tabKey);
    updateSettingsHash(tabKey);
  });
});

const settingsToggles = setupSettingsToggles({
  toggleAutoCompact,
  thinkingSteps: thinkingEffortSteps,
  thinkingMarker: thinkingEffortMarker,
  thinkingName: thinkingEffortName,
  toggleShowThinking,
  toggleSuperAgent,
  rpcCommand,
  getDefaultThinkingLevel: () => currentDefaultThinkingLevel,
  setDefaultThinkingLevel: (level) => {
    currentDefaultThinkingLevel = level;
  },
  onRuntimeLevelChanged: (level) => {
    currentThinkingLevel = level;
    updateThinkingBtn();
  },
  onSuperAgentEnabledChanged: handleSuperAgentEnabledChanged,
});

const configGateway = new LegacyConfigGateway();
({ loadInlineConfigEditor, loadAgentsMdEditor, loadAppendSystemMdEditor } = setupSettingsConfig({
  configGateway,
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}));

modelsPage = setupModelsPage({
  configGateway,
  onModelConfigurationChanged: async () => {
    await fetchModelInfo();
    updateUI();
  },
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
});

const skillsSaveMessageEl = document.getElementById("settings-skills-save-message");
const skillsPage = setupSkillsPage({
  container: document.getElementById("settings-skills"),
  rpcCommand,
  showSuccess: (msg) => showSettingsSaveSuccess(skillsSaveMessageEl, msg),
  showError: (msg) => showSettingsSaveError(skillsSaveMessageEl, msg),
});
const packageSkillsPage = setupPackageSkillsTab({
  container: document.getElementById("settings-package-skills"),
  rpcCommand,
});
const skillsInstallPage = setupSkillsInstallTab({
  container: document.getElementById("settings-install-skills"),
  transport,
  isProjectTrusted: () => skillsPage.isProjectTrusted(),
  showSuccess: (msg) => showSettingsSaveSuccess(skillsSaveMessageEl, msg),
  showError: (msg) => showSettingsSaveError(skillsSaveMessageEl, msg),
});

const packageBrowse = setupPackageBrowse({
  root: document,
  transport,
  nativeAvailable,
  t,
  createIcon,
  renderPackageInstallFailure,
  setExtensionActionButton,
});
packageManager = setupPackageManager({
  root: document,
  transport,
  nativeAvailable,
  t,
  getWorkspaceId: () => `workspace:${getCurrentWorkspacePath() || "unknown"}`,
  getSessionId: () => mirrorActiveSessionFile || sidebar.activeSessionFile || wsClient.sessionId,
  onRestarted: () => wsClient.forceReconnect(),
  onUpdatesChecked: (count) => extensionUpdateIndicator.setCount(count),
});
const extensionUpdateIndicator = setupExtensionUpdateIndicator({
  transport,
  nativeAvailable,
  t,
  buttonEl: document.getElementById("sidebar-extension-update-btn"),
  onOpen: () => void openSettings("extensions"),
});
extensionsTabs = setupExtensionsTabShell({
  tabs: document.querySelectorAll("[data-extensions-tab]"),
  panels: {
    installed: document.getElementById("extensions-installed"),
    community: document.getElementById("extensions-community"),
  },
  activate: (name) => {
    if (name === "installed") return packageManager.load();
    if (name === "community") return packageBrowse.load();
  },
});

setupSkillsTabShell({
  tabs: document.querySelectorAll("[data-skills-page-tab]"),
  panels: {
    discovered: document.getElementById("settings-skills"),
    install: document.getElementById("settings-install-skills"),
    packages: document.getElementById("settings-package-skills"),
  },
  activate: (name) => {
    if (name === "discovered") return skillsPage.activate();
    if (name === "install") return skillsInstallPage.activate();
    if (name === "packages") return packageSkillsPage.activate();
  },
});

contextVizController = setupContextViz({
  tokenUsageEl,
  contextViz: document.getElementById("context-viz"),
  contextBar: document.getElementById("context-bar"),
  contextLegend: document.getElementById("context-legend"),
  contextVizUsed: document.getElementById("context-viz-used"),
  contextVizTotal: document.getElementById("context-viz-total"),
  getUsage: () => lastUsage,
  getContextWindowSize: () => contextWindowSize,
  requestCompact,
  getCompactState: () => compactCoordinator.state,
});

// Session-aggregate header row (IN/OUT/CACHE/cost) — separate from the
// current-context lastUsage lifecycle so Compact can invalidate stale
// context without fabricating usage.
const headerStatusBar = createHeaderStatusBar({
  sessionCostEl,
  sessionUsageEl,
  tokenUsageEl,
  getContextWindowSize: () => contextWindowSize,
  t,
});

/** Monotonic generation for invalidating stale stats responses on switches. */
let statsHydrationGeneration = 0;

function resetHeaderStatusBar() {
  statsHydrationGeneration += 1;
  headerStatusBar?.reset();
}

/** Current active session file, for aggregate-vs-session identity checks. */
function activeSessionFileForStatusBar() {
  return mirrorActiveSessionFile || sidebar.activeSessionFile || null;
}

/** Hydrate the authoritative session aggregate from get_session_stats. */
async function hydrateHeaderSessionStats() {
  const generation = ++statsHydrationGeneration;
  try {
    const data = await rpcCommand({ type: "get_session_stats" }, null, true);
    if (!data?.success || !data.data) return;
    // Drop a response whose session changed, or that lost a generation race
    // against a newer session switch / mirror sync.
    if (generation !== statsHydrationGeneration) return;
    if (!data.data.sessionFile) return;
    const activeSessionFile = activeSessionFileForStatusBar();
    if (!activeSessionFile || data.data.sessionFile !== activeSessionFile) return;
    headerStatusBar?.hydrateSessionStats({
      sessionFile: data.data.sessionFile,
      tokens: data.data.tokens,
      cost: data.data.cost,
    });
  } catch (error) {
    // Aggregate hydration is best-effort; the current-context path still works.
    console.warn("[header-status] failed to hydrate session stats:", error);
  }
}

setupVoiceInput({
  micBtn: document.getElementById("mic-btn"),
  messageInput,
});
setButtonIcon(document.getElementById("mic-btn"), "mic", { size: 16 });

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, collapse model bar above input
if (isMobile()) {
  sidebarEl.classList.add("collapsed");

  const mobileBar = document.getElementById("mobile-model-bar");

  // Start collapsed
  mobileBar.classList.add("collapsed");

  // Toggle via chevron
  const contextToggle = document.getElementById("mobile-context-toggle");
  const syncContextToggleIcon = () => {
    const iconName = mobileBar.classList.contains("collapsed") ? "chevron-down" : "chevron-up";
    setButtonIcon(contextToggle, iconName, { size: 12 });
  };
  syncContextToggleIcon();
  contextToggle.addEventListener("click", () => {
    mobileBar.classList.toggle("collapsed");
    contextToggle.classList.toggle("flipped", !mobileBar.classList.contains("collapsed"));
    syncContextToggleIcon();
  });
}

// Make the Picot icon in sidebar switch back to chat
document.querySelector(".mode-link:first-child")?.addEventListener("click", () => {
  closeSettings();
});

// ═══════════════════════════════════════
// Open Folder as workspace
// ═══════════════════════════════════════

async function handleOpenFolder() {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    await openFolderAsWorkspace({
      transport,
      fetchInstances,
      getCurrentPort: getActivePort,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      beforeWorkspaceTransition: prepareEphemeralWorkspaceTransition,
      onWorkspaceTransitionCancelled: cancelEphemeralWorkspaceTransition,
      renderError: (message) => messageRenderer.renderError(message),
    });
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
}

openFolderBtn?.addEventListener("click", handleOpenFolder);

window.addEventListener("hashchange", restorePageFromHash);
restorePageFromHash();

wsClient.connect();
dismissBootSwapOverlayWhenReady();

// --- Cross-port navigation state restore (B) + sidebar cache (C) ---
// If the page booted because of a workspace/session swap, restore the
// snapshot taken right before the navigation so scroll, sidebar expansion,
// and input draft survive. Separately, hydrate the sidebar from a cached
// project tree so it renders instantly before the real loadSessions fetch.
const cachedProjects = readCachedSidebarProjects();
// readCachedSidebarProjects already filters to complete projects (valid
// workspaceId + path + sessions array), so hydration never renders broken
// rows or empty titles while /api/sessions is still loading.
if (cachedProjects) {
  sidebar.projects = cachedProjects;
  sidebar.render();
}

renderWorkspaceWelcome();
initSuperAgentPath()
  .catch(() => {})
  .then(() => stopSuperAgentPortsFromUrl())
  .then(() => loadSessionsWithSuperAgentBootstrap())
  .then((projects) => {
    sessionsLoaded = true;
    // Cache the fresh sidebar data for the next cross-port navigation (C).
    try {
      cacheSidebarProjects(projects || sidebar.projects);
    } catch {
      /* best-effort */
    }
    updateUI();
    // Restore the navigation snapshot now that sidebar + chat are rendered (B).
    try {
      const navState = consumeNavState();
      if (navState) {
        if (navState.sidebarScroll != null && sidebarEl) {
          requestAnimationFrame(() => {
            sidebarEl.scrollTop = navState.sidebarScroll;
          });
        }
        if (navState.expandedWorkspaces.size > 0 && sidebar) {
          for (const id of navState.expandedWorkspaces) {
            sidebar.expandedWorkspaces.add(id);
          }
          sidebar.render();
        }
        if (navState.searchQuery && sidebar) {
          sidebar.searchQuery = navState.searchQuery;
          sidebar.render();
        }
        if (navState.messageScroll != null && messagesContainer) {
          requestAnimationFrame(() => {
            messagesContainer.scrollTop = navState.messageScroll;
          });
        }
        if (navState.inputDraft && messageInput && !messageInput.value) {
          messageInput.value = navState.inputDraft;
        }
      }
    } catch {
      /* restore is best-effort */
    }
    if (!hasAnySessionsLoaded()) {
      renderWorkspaceWelcome();
    }
    if (deferredMirrorSync) {
      const syncData = deferredMirrorSync;
      deferredMirrorSync = null;
      handleMirrorSync(syncData);
    }
    if (isMirrorMode) updateMirrorLiveIndicator();
    resolveAndApplyFocus();
  });

// Dismiss mobile splash screen
const splash = document.getElementById("mobile-splash");
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add("hidden");
    setTimeout(() => splash.remove(), 300);
  });
}

console.log("🚀 Picot initialized");
