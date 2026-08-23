// ABOUTME: Shared workspace action source — one controller feeding the header
// ABOUTME: split-button and the Info panel so app-launch behavior can never drift.

/**
 * Workspace actions — the single source for "open workspace in app" rows.
 *
 * The header split-button and the Info panel's Workspace section render the
 * same actions in two places. Per the Info panel design invariant ("同一
 * action source/controller"), both render from ONE controller instance:
 * app list loading, icon/monogram fallback, selection persistence, the
 * transport call, and clipboard handling live here exactly once.
 *
 * The module holds no session state and never touches the DOM tree of either
 * renderer; callers inject `transport`, a native-availability flag, and a
 * workspace-path getter.
 */

// Brand marks for known apps; monogram fallback covers anything else.
export const OPEN_APP_MONOGRAMS = {
  vscode: "VS",
  cursor: "C",
  webstorm: "WS",
  zed: "Z",
  terminal: "T",
  ghostty: "G",
  finder: "F",
};

export const OPEN_APP_ICONS = {
  vscode: "icons/app-vscode.png",
  cursor: "icons/app-cursor.svg",
  webstorm: "icons/app-webstorm.svg",
  zed: "icons/app-zed.png",
  terminal: "icons/app-terminal.svg",
  ghostty: "icons/app-ghostty.png",
  finder: "icons/app-finder.png",
};

export function appIconPath(app) {
  return app?.id ? OPEN_APP_ICONS[app.id] || "" : "";
}

export function appMonogram(app) {
  if (!app?.id) return "•";
  return OPEN_APP_MONOGRAMS[app.id] || app.label?.slice(0, 1).toUpperCase() || "•";
}

/** Fill a container with the app's brand icon or its monogram fallback. */
export function populateAppLogo(container, app) {
  if (!container) return;
  container.replaceChildren();
  const icon = appIconPath(app);
  if (icon) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = "";
    image.className = "open-app-logo-img";
    container.appendChild(image);
    return;
  }
  const monogram = document.createElement("span");
  monogram.className = "open-app-logo-text";
  monogram.textContent = appMonogram(app);
  container.appendChild(monogram);
}

/**
 * Create the shared controller.
 *
 * @param {{
 *   transport: { listInstalledApps: Function, openInApp: Function },
 *   isNativeAvailable: () => boolean,
 *   getWorkspacePath: () => string,
 *   storageKey?: string,
 *   onSelectionChange?: () => void,
 *   onAppsLoaded?: (apps: Array) => void,
 * }} options
 */
export function createWorkspaceActionsController({
  transport,
  isNativeAvailable,
  getWorkspacePath,
  storageKey = "pi-studio-open-app",
  onSelectionChange,
  onAppsLoaded,
} = {}) {
  const state = {
    apps: [],
    selectedId: (typeof localStorage !== "undefined" && localStorage.getItem(storageKey)) || null,
  };

  const getSelectedApp = () =>
    state.apps.find((a) => a.id === state.selectedId) || state.apps[0] || null;

  async function loadApps() {
    if (!isNativeAvailable() || !transport) return;
    try {
      const apps = await transport.listInstalledApps();
      state.apps = Array.isArray(apps) ? apps : [];
      if (!state.apps.some((a) => a.id === state.selectedId)) {
        state.selectedId = state.apps[0]?.id || null;
      }
      onAppsLoaded?.(state.apps);
    } catch (err) {
      console.error("[WorkspaceActions] Failed to load installed apps:", err);
    }
  }

  /** Open the workspace in `app` (default: the persisted selection). */
  async function openWorkspaceInApp(app) {
    const target = app || getSelectedApp();
    const path = getWorkspacePath();
    if (!isNativeAvailable() || !target || !path) return;
    state.selectedId = target.id;
    try {
      localStorage.setItem(storageKey, target.id);
    } catch {
      // Persistence is best-effort; the launch itself still proceeds.
    }
    onSelectionChange?.();
    try {
      await transport.openInApp(path, {
        appName: target.appName ?? null,
        command: target.command ?? null,
      });
    } catch (err) {
      console.error("[WorkspaceActions] Failed to open workspace in app:", err);
    }
  }

  /** Copy the workspace path. Returns the copied text, or "" when unavailable. */
  async function copyWorkspacePath() {
    const path = getWorkspacePath();
    if (!path || !navigator.clipboard?.writeText) return "";
    try {
      await navigator.clipboard.writeText(path);
      return path;
    } catch (err) {
      console.error("[WorkspaceActions] Failed to copy workspace path:", err);
      return "";
    }
  }

  return {
    get apps() {
      return state.apps;
    },
    get selectedId() {
      return state.selectedId;
    },
    getSelectedApp,
    loadApps,
    openWorkspaceInApp,
    copyWorkspacePath,
  };
}
