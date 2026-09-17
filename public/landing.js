// ABOUTME: Native landing bootstrap for `/`: the minimal object graph that
// ABOUTME· boots before app.js — transport, sidebar seams, the landing
// ABOUTME: transition controller, a landing notice, and landing Quick Chat.
// Deliberately NOT constructed here (chat-lifecycle objects that would throw
// or misbehave without a workspace session): MessageRenderer, ToolCardRenderer,
// composer, ConfigGateway, Side Chat, file preview/browser, Git panel,
// terminal, model picker, and their owner-bootstrap handlers. No Git refresh
// or model-catalog request may run at landing generation 0.

import { installHostOriginFetch } from "./app/host-origin.js";
import { initTransport } from "./app/transport.js";
import { createAppUpdater } from "./app/updater.js";
import { resolveWebSocketUrl, WebSocketClient } from "./app/websocket-client.js";
import {
  applyAppearanceToDom,
  FONT_SIZE_LEVELS,
  loadAppearanceCookie,
  normalizeFontLevel,
  normalizePreviewThemeMode,
  normalizeScrollbackLimit,
  normalizeSmoothScrollDuration,
  normalizeThemeMode,
  PREVIEW_THEME_MODES,
  saveAppearanceCookie,
  TERMINAL_THEME_MODES,
} from "./appearance-preferences.js";
import { EphemeralChatView } from "./ephemeral-chat-view.js";
import { setupExtensionUpdateIndicator } from "./extension-update-indicator.js";
import {
  getLanguagePreference,
  initI18n,
  LANGUAGES,
  onLocaleChange,
  setLocale,
  t,
} from "./i18n.js";
import { createIcon, replaceButtonGlyph, setButtonIcon } from "./icons.js";
import { renderPackageInstallFailure } from "./packages/install-status.js";
import {
  createPreferencesClient,
  PREFERENCE_KEYS,
  saveUserRenderPreference,
} from "./preferences-client.js";
import { QuickChatDialog } from "./quick-chat-dialog.js";
import { setupExtensionsTabShell } from "./settings/extensions-tab-shell.js";
import { setupMobileAccess } from "./settings/mobile-access.js";
import { setupPackageBrowse } from "./settings/package-browse.js";
import { setupPackageManager } from "./settings/package-manager.js";
import { showSettingsSaveError, showSettingsSaveSuccess } from "./settings/save-status.js";
import { setupSkillsInstallTab } from "./settings/skills-install-tab.js";
import { setupSkillsPage } from "./settings/skills-page.js";
import { setupSkillsTabShell } from "./settings/skills-tab-shell.js";
import { renderThinkingEffort } from "./settings/toggles.js";
import { FOCUS_WORKSPACE_PARAM } from "./sidebar/focus-state.js";
import { SessionSidebar } from "./sidebar/index.js";
import { applyTheme, getCurrentTheme, themes } from "./themes.js";
import { WindowCloseCoordinator } from "./window-close-coordinator.js";
import {
  consumeNavState,
  readCachedSidebarProjects,
  snapshotNavState,
} from "./workspace/nav-state-cache.js";
import { registryPinsFromProjects } from "./workspace-projects.js";

// Theme + locale must exist before any component renders its chrome.
applyTheme(getCurrentTheme());
await initI18n();

installHostOriginFetch(window);
const wsClient = new WebSocketClient(resolveWebSocketUrl(window));
const transport = initTransport({ wsClient, env: window });
const preferencesClient = createPreferencesClient({ transport });

// Landing-local serializations: picking a folder and transitioning into the
// selected workspace are separate async phases and must not share a lock.
let launchInProgress = false;
let transitionInProgress = false;

// Quick Chat overlays the landing view. Its mount roots live inside the
// workspace chrome in index.html; reparent them to <body> so the dialog is
// not hidden with the workspace and its absolute geometry measures against
// the body (this document's bounds element). Workspace pages never reparent.
for (const rootId of ["quick-chat-dialog-root", "quick-chat-chip-root"]) {
  const root = document.getElementById(rootId);
  if (root && root.parentElement !== document.body) document.body.appendChild(root);
}

// Landing Quick Chat: no active-session model catalog dependency (there is no
// ConfigGateway here — the catalog filter treats null as "no filtering"), no
// workspace root, and no Side Chat.
const createLandingEphemeralView = (runtime) =>
  new EphemeralChatView({
    runtime,
    kind: runtime.kind,
    toolsEnabled: runtime.kind === "side-chat",
    getWorkspaceRoot: () => null,
    loadModelCatalog: () => Promise.resolve(null),
  });

function confirmEphemeralDiscard() {
  return Promise.resolve(window.confirm(t("ephemeral.confirmDiscard")) ? "discard" : "cancel");
}

const quickChatDialog = new QuickChatDialog({
  transport,
  dialogRoot: document.getElementById("quick-chat-dialog-root"),
  chipRoot: document.getElementById("quick-chat-chip-root"),
  boundsElement: document.body,
  confirmDiscard: confirmEphemeralDiscard,
  createView: createLandingEphemeralView,
});

// The host waits for window_close_approve before closing; the landing has no
// dirty files, terminals, or Side Chat, so only Quick Chat participates.
const windowCloseCoordinator = new WindowCloseCoordinator({
  transport,
  showSummaryDialog: () =>
    Promise.resolve(window.confirm(t("ephemeral.confirmCloseSummary")) ? "discard" : "cancel"),
});
windowCloseCoordinator.registerParticipant("quick", quickChatDialog);
wsClient.addEventListener("windowCloseRequest", (event) => {
  windowCloseCoordinator.handleHostCloseRequest(event.detail?.requestId);
});

// Landing-local error surface — the chat error renderer does not exist here.
function renderLandingNotice(message) {
  console.warn("[landing]", message);
  const notice = document.getElementById("landing-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.remove("hidden");
}

// Null-safe navigation snapshot: chat fields are absent at landing; only the
// sidebar state (expansion/search/scroll) carries across the transition.
function snapshotUiStateForNavigation() {
  try {
    snapshotNavState({
      messageScroll: null,
      sidebarScroll: document.getElementById("sidebar")?.scrollTop ?? null,
      inputDraft: "",
      expandedWorkspaces: sidebar ? sidebar.expandedWorkspaces : [],
      searchQuery: sidebar ? sidebar.searchQuery : "",
    });
  } catch {
    /* snapshot is best-effort */
  }
}

function navigateInWindow(url) {
  let targetUrl;
  try {
    const parsed = new URL(url, window.location.href);
    const currentUrl = new URL(window.location.href);
    if (
      parsed.protocol !== currentUrl.protocol ||
      parsed.hostname !== currentUrl.hostname ||
      parsed.username ||
      parsed.password
    ) {
      console.error("[landing] rejected cross-origin target");
      return;
    }
    parsed.searchParams.delete(FOCUS_WORKSPACE_PARAM);
    targetUrl = parsed;
  } catch {
    console.error("[landing] rejected invalid target");
    return;
  }
  window.location.assign(targetUrl.toString());
}

// The only way landing enters a workspace: prepare → commit → navigate.
// Never touches messageRenderer, resetUiForNewSession, quickChatDialog state,
// filePreviewPanel, terminalPanel, or the model picker.
async function enterWorkspace(path, { sessionPath, forceNewSession } = {}) {
  if (transitionInProgress || !path) return false;
  transitionInProgress = true;
  let prepared = null;
  try {
    // Live-instance check for session selection: reuse the exact running
    // runtime only when one exists for this session and workspace.
    const live = await transport.runtimeInstances().catch(() => null);
    const reuseExisting = Boolean(
      sessionPath &&
        Array.isArray(live?.instances) &&
        live.instances.some(
          (instance) => instance.sessionFile === sessionPath && instance.cwd === path,
        ),
    );
    prepared = await transport.prepareWorkspaceTarget(path, {
      sessionPath: sessionPath ?? null,
      forceNewSession: Boolean(forceNewSession),
      reuseExisting,
    });
    if (typeof prepared?.transitionGeneration !== "number") {
      throw new Error("Workspace transition was not prepared");
    }
    // Lock Quick Chat across the cross transition; the host's commit sweep
    // cleans landing-scoped ephemeral state at the new generation.
    quickChatDialog.setInteractionLocked(true);
    try {
      await transport.commitWorkspaceTransition(prepared.transitionGeneration);
    } catch (error) {
      quickChatDialog.setInteractionLocked(false);
      throw error;
    }
    snapshotUiStateForNavigation();
    navigateInWindow(prepared.targetOrigin);
    return true;
  } catch (error) {
    if (prepared?.transitionGeneration != null) {
      await transport.cancelWorkspaceTransition(prepared.transitionGeneration).catch(() => {});
    }
    renderLandingNotice(t("errors.failedToSwitchSession", { error }));
    return false;
  } finally {
    transitionInProgress = false;
  }
}

// ── Sidebar seams (all four route into enterWorkspace) ─────────────────────

// 1. Session-row selection.
function handleSessionSelect(session, project) {
  const path = project?.path || session?.cwd || "";
  return enterWorkspace(path, { sessionPath: session?.filePath });
}

// 2. Workspace `+ New Chat` — the zero-session entry path.
function handleWorkspaceNewChat(workspace) {
  return enterWorkspace(workspace?.path || "", { forceNewSession: true });
}

// 3. Post-add-project navigation.
function handleRegisterWorkspace(targetCwd) {
  return enterWorkspace(targetCwd || "", { forceNewSession: true });
}

const sidebar = new SessionSidebar(
  document.getElementById("session-list"),
  handleSessionSelect,
  handleWorkspaceNewChat,
  {
    transport,
    onRegisterWorkspace: handleRegisterWorkspace,
    // The empty-registry "+ 添加项目" button opens the same picker flow as
    // the sidebar + buttons; without this seam the button renders dead.
    onOpenProject: () => addProjectViaPicker(),
    // No focus seam at landing: Focus-mode gating is "a workspace session is
    // selected", and landing selects none — the classic predicate (active
    // session or current workspace) can never pass here, so no `>` button.
    isCurrentWorkspace: () => false,
    onSessionNotice: (message) => renderLandingNotice(message),
  },
);

// ── Chrome wiring ────────────────────────────────────────────────────────────

setButtonIcon(document.getElementById("add-project-btn"), "folder-plus", { size: 16 });
setButtonIcon(document.getElementById("quick-chat-btn"), "message-circle", { size: 16 });
setButtonIcon(document.getElementById("refresh-sessions-btn"), "refresh-cw", { size: 16 });
replaceButtonGlyph(document.getElementById("settings-btn"), "settings", { size: 18 });
const landingIcon = document.getElementById("landing-add-project-icon");
if (landingIcon) landingIcon.replaceChildren(createIcon("plus", { size: 16 }));

function addProjectViaPicker() {
  if (launchInProgress) return;
  launchInProgress = true;
  void sidebar.addProjectViaPicker().finally(() => {
    launchInProgress = false;
  });
}
document.getElementById("add-project-btn")?.addEventListener("click", addProjectViaPicker);
document.getElementById("landing-add-project-btn")?.addEventListener("click", addProjectViaPicker);
document.getElementById("refresh-sessions-btn")?.addEventListener("click", () => {
  void sidebar.refresh();
});
document.getElementById("quick-chat-btn")?.addEventListener("click", () => {
  if (transport.capabilities.native) void quickChatDialog.open();
});

wsClient.addEventListener("hostCapabilities", () => {
  // Ephemeral chat entry is native-only; the registry load needs an
  // authenticated hello first.
  document.getElementById("quick-chat-btn")?.classList.remove("hidden");
  void sidebar.refresh();
});
// App-global registry changed in another window — stay in sync. The
// initiating window is already navigating when it launched the change.
wsClient.addEventListener("registryChanged", () => {
  if (launchInProgress) return;
  void sidebar.refresh();
});

// ── Settings (General + Appearance tabs at landing) ────────────────
// Theme, language, appearance, and updates are owner-less preferences
// served by control ops. Runtime- and workspace-bound tabs stay hidden: there
// is no live Pi and no workspace scope on this page.

// Tabs that work without a workspace binding or a live Pi: General,
// Appearance, and Usage (the cost dashboard scans the global session tree
// over an owner-scoped data op). The remaining tabs (models, skills,
// extensions, mcp, configuration) need a live Pi runtime or a workspace
// scope: their nav entries are hidden entirely at landing — everything
// visible here works.
const LANDING_FUNCTIONAL_SETTINGS_TABS = new Set([
  "general",
  "appearance",
  "usage",
  "skills",
  "extensions",
]);
const LANDING_HIDDEN_SETTINGS_TABS = new Set(["models", "mcp", "configuration"]);

function buildLandingThemeGrid() {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  grid.replaceChildren();
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
      // Render + cookie now, DB mirror for durability (SPEC §6.2 step 3).
      void saveUserRenderPreference({
        client: preferencesClient,
        key: PREFERENCE_KEYS.theme,
        value: id,
        apply: () => applyTheme(id, { origin: { x: event.clientX, y: event.clientY } }),
      });
      grid.querySelectorAll(".theme-swatch").forEach((s) => {
        s.classList.remove("active");
      });
      btn.classList.add("active");
    });
    grid.appendChild(btn);
  }
}

function buildLandingLanguageSelector() {
  const select = document.getElementById("settings-language-select");
  if (!select) return;
  const current = getLanguagePreference();
  select.replaceChildren();
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.value;
    option.textContent = lang.nativeLabel ?? t(lang.labelKey);
    option.selected = current === lang.value;
    select.append(option);
  }
}

function openLandingSettings(tabKey = "general") {
  document.getElementById("settings-panel")?.classList.remove("hidden");
  selectLandingSettingsTab(tabKey);
  buildLandingThemeGrid();
  buildLandingLanguageSelector();
  buildLandingAppearanceSelectors();
  void loadLandingPiVersion();
  void mobileAccessCard.refresh();
}

// Pi version rides a host control op (no runtime needed); the value is the
// embedded binary's locked version.
async function loadLandingPiVersion() {
  const value = document.getElementById("setting-pi-version-value");
  if (!value || !transport.capabilities.native) return;
  if (value.dataset.loaded === "1") return;
  try {
    value.textContent = String(await transport.getPiVersion());
    value.dataset.loaded = "1";
  } catch (error) {
    value.textContent = String(error?.message || error).slice(0, 56);
  }
}

// Mobile pairing is entirely host-side control ops (pairing tokens,
// access info, the LAN-access preference).
const mobileAccessCard = setupMobileAccess({
  transport,
  toggle: document.getElementById("toggle-mobile-access"),
  details: document.getElementById("mobile-access-details"),
  pairBtn: document.getElementById("mobile-pair-btn"),
  pairing: document.getElementById("mobile-access-pairing"),
  qrCanvas: document.getElementById("mobile-qr-canvas"),
  tokenEl: document.getElementById("mobile-pair-token"),
  restartHint: document.getElementById("mobile-restart-hint"),
});

function selectLandingSettingsTab(tabKey) {
  const target = LANDING_FUNCTIONAL_SETTINGS_TABS.has(tabKey) ? tabKey : "general";
  document.querySelectorAll(".settings-nav-item[data-settings-tab]").forEach((item) => {
    const tab = item.dataset.settingsTab;
    item.classList.toggle("hidden", LANDING_HIDDEN_SETTINGS_TABS.has(tab));
    item.classList.toggle("active", tab === target);
  });
  document.querySelectorAll(".settings-tab[data-settings-panel]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.settingsPanel === target);
  });
  if (target === "usage") {
    // Same lazy-load contract as the workspace shell: the dashboard fetches
    // only when its tab is first opened.
    void document.getElementById("settings-cost-dashboard")?.ensureLoaded?.();
  }
  if (target === "skills") {
    void skillsPage.activate();
  }
  if (target === "extensions") {
    void packageManager.load();
  }
}

function closeLandingSettings() {
  document.getElementById("settings-panel")?.classList.add("hidden");
}

document.querySelectorAll(".settings-nav-item[data-settings-tab]").forEach((item) => {
  item.addEventListener("click", () => selectLandingSettingsTab(item.dataset.settingsTab));
});

document.getElementById("settings-language-select")?.addEventListener("change", async (event) => {
  const select = event.currentTarget;
  select.disabled = true;
  try {
    await saveUserRenderPreference({
      client: preferencesClient,
      key: PREFERENCE_KEYS.locale,
      value: select.value,
      apply: (preference) => setLocale(preference),
    });
    buildLandingLanguageSelector();
  } finally {
    select.disabled = false;
  }
});

document.getElementById("settings-btn")?.addEventListener("click", () => {
  openLandingSettings("general");
});
document.querySelector(".mode-link")?.addEventListener("click", closeLandingSettings);
// Same back-chevron the workspace shell renders into the settings panel's
// back button — without this the landing copy shows no `<`.
const settingsBackIcon = document
  .getElementById("settings-close")
  ?.querySelector(".settings-nav-back-icon");
if (settingsBackIcon) {
  const backIcon = createIcon("chevron-left", { size: 14 });
  if (backIcon) settingsBackIcon.replaceChildren(backIcon);
}
document.getElementById("settings-close")?.addEventListener("click", closeLandingSettings);
document.getElementById("settings-overlay")?.addEventListener("click", closeLandingSettings);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const panel = document.getElementById("settings-panel");
  if (!panel?.classList.contains("hidden")) closeLandingSettings();
});

// ── Appearance (mirrors the workspace shell's cookie + DB dual-track) ──
const appearance = loadAppearanceCookie();

function currentPicotThemeIsDark() {
  const themeId = document.documentElement.getAttribute("data-theme") || getCurrentTheme();
  return themes[themeId]?.dark ?? true;
}

function applyLandingAppearance() {
  applyAppearanceToDom({
    chatFontSize: appearance.chatFontSize,
    previewFontSize: appearance.previewFontSize,
    previewTheme: appearance.previewTheme,
    picotThemeIsDark: currentPicotThemeIsDark(),
  });
}

const FONT_LEVEL_LABEL_KEYS = {
  small: "settings.fontLevel.small",
  normal: "settings.fontLevel.normal",
  medium: "settings.fontLevel.medium",
  large: "settings.fontLevel.large",
  xlarge: "settings.fontLevel.xlarge",
};

const landingFontControls = [
  {
    prefix: "settings-chat-font-size",
    pref: PREFERENCE_KEYS.chatFontSize,
    read: () => appearance.chatFontSize,
    write: (level) => {
      appearance.chatFontSize = normalizeFontLevel(level);
      saveAppearanceCookie({ chatFontSize: appearance.chatFontSize });
    },
  },
  {
    prefix: "settings-preview-font-size",
    pref: PREFERENCE_KEYS.previewFontSize,
    read: () => appearance.previewFontSize,
    write: (level) => {
      appearance.previewFontSize = normalizeFontLevel(level);
      saveAppearanceCookie({ previewFontSize: appearance.previewFontSize });
    },
  },
  {
    prefix: "settings-terminal-font-size",
    pref: PREFERENCE_KEYS.terminalFontSize,
    read: () => appearance.terminalFontSize,
    write: (level) => {
      appearance.terminalFontSize = normalizeFontLevel(level);
      saveAppearanceCookie({ terminalFontSize: appearance.terminalFontSize });
    },
  },
].map((control) => ({
  ...control,
  steps: document.getElementById(`${control.prefix}-steps`),
  marker: document.getElementById(`${control.prefix}-marker`),
  name: document.getElementById(`${control.prefix}-name`),
}));

function renderLandingFontControl(control) {
  renderThinkingEffort(control.read(), {
    thinkingSteps: control.steps,
    thinkingMarker: control.marker,
    thinkingName: control.name,
    levels: FONT_SIZE_LEVELS,
    nameFor: (level) => t(FONT_LEVEL_LABEL_KEYS[level]),
  });
}

function syncLandingTerminalDisplaySettings() {
  const scrollback = document.getElementById("settings-terminal-scrollback-input");
  if (scrollback) scrollback.value = String(appearance.terminalScrollbackLimit);
  const smooth = document.getElementById("settings-terminal-smooth-scroll-input");
  if (smooth) smooth.value = String(appearance.terminalSmoothScrollDuration);
  document
    .getElementById("toggle-terminal-webgl")
    ?.classList.toggle("on", Boolean(appearance.terminalWebglRenderer));
}

function buildLandingAppearanceSelectors() {
  for (const control of landingFontControls) renderLandingFontControl(control);
  const previewSelect = document.getElementById("settings-preview-theme-select");
  if (previewSelect) {
    previewSelect.replaceChildren();
    const labels = {
      system: t("settings.preview.themeSystem"),
      light: t("settings.preview.themeLight"),
      dark: t("settings.preview.themeDark"),
    };
    for (const mode of PREVIEW_THEME_MODES) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = labels[mode] || mode;
      option.selected = mode === appearance.previewTheme;
      previewSelect.append(option);
    }
  }
  const terminalSelect = document.getElementById("settings-terminal-theme-select");
  if (terminalSelect) {
    terminalSelect.replaceChildren();
    const labels = {
      system: t("settings.terminal.themeSystem"),
      light: t("settings.terminal.themeLight"),
      dark: t("settings.terminal.themeDark"),
    };
    for (const mode of TERMINAL_THEME_MODES) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = labels[mode] || mode;
      option.selected = mode === appearance.terminalThemeMode;
      terminalSelect.append(option);
    }
  }
  syncLandingTerminalDisplaySettings();
}

// Font-size sliders: click a dot to pick that level; the setter persists and
// applies, then the control re-renders thumb + label.
for (const control of landingFontControls) {
  control.steps?.addEventListener("click", (event) => {
    const dot = event.target.closest(".thinking-effort-dot");
    if (!dot) return;
    control.write(dot.dataset.level);
    void saveUserRenderPreference({
      client: preferencesClient,
      key: control.pref,
      value: control.read(),
      apply: () => applyLandingAppearance(),
    });
    renderLandingFontControl(control);
  });
}

document.getElementById("settings-preview-theme-select")?.addEventListener("change", (event) => {
  appearance.previewTheme = normalizePreviewThemeMode(event.currentTarget.value);
  saveAppearanceCookie({ previewTheme: appearance.previewTheme });
  void saveUserRenderPreference({
    client: preferencesClient,
    key: PREFERENCE_KEYS.previewTheme,
    value: appearance.previewTheme,
    apply: () => applyLandingAppearance(),
  });
});

document.getElementById("settings-terminal-theme-select")?.addEventListener("change", (event) => {
  appearance.terminalThemeMode = normalizeThemeMode(event.currentTarget.value);
  saveAppearanceCookie({ terminalThemeMode: appearance.terminalThemeMode });
  void saveUserRenderPreference({
    client: preferencesClient,
    key: PREFERENCE_KEYS.terminalThemeMode,
    value: appearance.terminalThemeMode,
    apply: () => {},
  });
});

document
  .getElementById("settings-terminal-scrollback-input")
  ?.addEventListener("change", (event) => {
    appearance.terminalScrollbackLimit = normalizeScrollbackLimit(event.currentTarget.value);
    event.currentTarget.value = String(appearance.terminalScrollbackLimit);
    saveAppearanceCookie({ terminalScrollbackLimit: appearance.terminalScrollbackLimit });
    void saveUserRenderPreference({
      client: preferencesClient,
      key: PREFERENCE_KEYS.terminalScrollbackLimit,
      value: appearance.terminalScrollbackLimit,
      apply: () => {},
    });
  });

document
  .getElementById("settings-terminal-smooth-scroll-input")
  ?.addEventListener("change", (event) => {
    appearance.terminalSmoothScrollDuration = normalizeSmoothScrollDuration(
      event.currentTarget.value,
    );
    event.currentTarget.value = String(appearance.terminalSmoothScrollDuration);
    saveAppearanceCookie({ terminalSmoothScrollDuration: appearance.terminalSmoothScrollDuration });
    void saveUserRenderPreference({
      client: preferencesClient,
      key: PREFERENCE_KEYS.terminalSmoothScrollDuration,
      value: appearance.terminalSmoothScrollDuration,
      apply: () => {},
    });
  });

document.getElementById("toggle-terminal-webgl")?.addEventListener("click", (event) => {
  appearance.terminalWebglRenderer = !appearance.terminalWebglRenderer;
  saveAppearanceCookie({ terminalWebglRenderer: appearance.terminalWebglRenderer });
  event.currentTarget.classList.toggle("on", appearance.terminalWebglRenderer);
  void saveUserRenderPreference({
    client: preferencesClient,
    key: PREFERENCE_KEYS.terminalWebglRenderer,
    value: appearance.terminalWebglRenderer,
    apply: () => {},
  });
});

onLocaleChange(() => {
  buildLandingLanguageSelector();
  buildLandingAppearanceSelectors();
});

// ── Window dragging ──────────────────────────────────────────────
// `-webkit-app-region` is inert on WKWebView; the functional mechanism is the
// Tauri startDragging call, wired here for the landing strip, the settings
// panel's drag strip, and the sidebar header (guarded against its controls).
function startWindowDrag(event) {
  if (event.button !== 0) return;
  if (event.target.closest("button, a, input, select, textarea, [role=button], .mode-link")) {
    return;
  }
  window.__TAURI__?.window?.getCurrentWindow().startDragging();
}

for (const region of [
  document.querySelector(".landing-drag-strip"),
  document.getElementById("settings-drag-region"),
  document.querySelector(".sidebar-header"),
]) {
  region?.addEventListener("mousedown", startWindowDrag);
}

// Updates are a legitimate landing-time check: check/install ride control ops
// and need no runtime or workspace binding.
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
  sidebarUpdateBtn: document.getElementById("sidebar-update-btn"),
  onOpenSettings: openLandingSettings,
});
void updater.initUpdaterUI();

// The Usage tab's cost dashboard element lazy-loads on first activation and
// shares this page's transport (same contract as the workspace shell).
{
  const { setCostDashboardTransport } = await import("./cost/dashboard.js");
  setCostDashboardTransport(transport);
}

// ── Skills page (discovered + install; packages sub-tab is bridge-bound) ──
// Discovered-skills inventory rides host control ops, so the tab works at
// landing. The "packages" sub-tab (扩展中的技能) stays bridge-bound — its
// inventory/mutation carries project-delta semantics only the bridge
// implements — and is excluded from the landing tab shell entirely (no
// click, no keyboard nav).

function landingSkillRpc(cmd) {
  const handlers = {
    list_skill_inventory: () => transport.listSkillInventory(cmd.scope),
    set_skill_enabled: () => transport.setSkillEnabled(cmd.scope, cmd.target, cmd.enabled),
  };
  const handler = handlers[cmd?.type];
  if (!handler) {
    return Promise.resolve({ success: false, error: `${cmd?.type} is unavailable at landing` });
  }
  return handler().then(
    (data) => ({ success: true, data: data ?? {} }),
    (error) => ({ success: false, error: error?.message || String(error) }),
  );
}

const skillsSaveMessageEl = document.getElementById("settings-skills-save-message");
const skillsSaveFeedback = {
  showSuccess: (message) => showSettingsSaveSuccess(skillsSaveMessageEl, message),
  showError: (message) => showSettingsSaveError(skillsSaveMessageEl, message),
};

const skillsPage = setupSkillsPage({
  container: document.getElementById("settings-skills"),
  rpcCommand: landingSkillRpc,
  // Project-scoped skills need a registered workspace: hide the tab at
  // landing instead of rendering an entry that errors on click.
  scopes: ["global"],
  ...skillsSaveFeedback,
});

const skillsInstallPage = setupSkillsInstallTab({
  container: document.getElementById("settings-install-skills"),
  transport,
  isProjectTrusted: () => skillsPage.isProjectTrusted(),
  ...skillsSaveFeedback,
});

// The packages sub-tab needs a live Pi runtime (bridge-bound); at landing it
// is hidden entirely — same contract as the Pi-bound settings tabs above.
document.querySelector('[data-skills-page-tab="packages"]')?.classList.add("hidden");

setupSkillsTabShell({
  // The same exclusion keeps keyboard navigation from selecting the hidden
  // packages tab (arrow keys cycle the shell's own tab list).
  tabs: document.querySelectorAll('[data-skills-page-tab]:not([data-skills-page-tab="packages"])'),
  panels: {
    discovered: document.getElementById("settings-skills"),
    install: document.getElementById("settings-install-skills"),
    packages: document.getElementById("settings-package-skills"),
  },
  activate: (name) => {
    if (name === "discovered") return skillsPage.activate();
    if (name === "install") return skillsInstallPage.activate();
    // The packages sub-tab is hidden at landing; nothing to activate.
    return Promise.resolve();
  },
});

// ── Extensions page (host control ops; global-only at landing) ──
// Package list/updates/installs run the bundled pi CLI from the host. At
// landing the location set has no project root, so project-scoped actions
// error with a clear message; global package management works fully.

function landingSetExtensionActionButton(button, label, loading = false) {
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

const packageManager = setupPackageManager({
  root: document,
  transport,
  nativeAvailable: () => transport.capabilities.native,
  t,
  getWorkspaceId: () => "",
  getSessionId: () => "",
  onRestarted: () => {},
  onUpdatesChecked: () => {},
});

const packageBrowse = setupPackageBrowse({
  root: document,
  transport,
  nativeAvailable: () => transport.capabilities.native,
  t,
  createIcon,
  renderPackageInstallFailure,
  setExtensionActionButton: landingSetExtensionActionButton,
});

setupExtensionsTabShell({
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

setupExtensionUpdateIndicator({
  transport,
  nativeAvailable: () => transport.capabilities.native,
  t,
  buttonEl: document.getElementById("sidebar-extension-update-btn"),
  onOpen: () => openLandingSettings("extensions"),
});

// ── Reveal + boot ────────────────────────────────────────────────────────────

// Sidebar state restore before the first registry load (same contract as the
// workspace shell): expansion/search seed the first render.
const pendingNavState = consumeNavState();
if (pendingNavState) {
  sidebar.expandedWorkspaces = pendingNavState.expandedWorkspaces;
  sidebar.searchQuery = pendingNavState.searchQuery;
}
const cachedProjects = readCachedSidebarProjects();
if (cachedProjects) {
  sidebar.projects = cachedProjects;
  sidebar._registryPins = registryPinsFromProjects(cachedProjects);
  sidebar.render();
}

document.body.classList.add("landing-mode");
const landing = document.getElementById("landing");
landing?.classList.remove("hidden");
landing?.setAttribute("aria-hidden", "false");

wsClient.connect();
