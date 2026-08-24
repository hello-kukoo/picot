// ABOUTME: Shared workspace action source feeding the Info panel's app rows.
// ABOUTME: Mirrors header-open-app: same gateway calls, one controller per consumer.

/**
 * Workspace app actions — the controller behind the Info panel's
 * "open workspace in app" rows.
 *
 * The v3 design invariant is "one action source, two render locations". The
 * v3.3 header keeps its own split-button (header-open-app.js); this module is
 * the Info panel's controller. Both go through the SAME transport surface
 * (control.listInstalledApps / control.openInApp) and the SAME brand-mark
 * tables (exported by header-open-app.js), so launch behavior and iconography
 * cannot drift.
 */

import { OPEN_APP_ICONS, OPEN_APP_MONOGRAMS } from "./header-open-app.js";

function appIconPath(app) {
  return app?.id ? OPEN_APP_ICONS[app.id] || "" : "";
}

function appMonogram(app) {
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
 * Create the Info panel's workspace-action controller.
 *
 * @param {{
 *   control: { listInstalledApps: Function, openInApp: Function } | null,
 *   getWorkspacePath: () => string,
 *   onAppsLoaded?: (apps: Array) => void,
 * }} options
 */
export function createWorkspaceAppActions({ control, getWorkspacePath, onAppsLoaded } = {}) {
  const state = { apps: [], appsLoaded: false };

  async function loadApps({ force = false } = {}) {
    // listInstalledApps spawns a host probe; once loaded for this workspace,
    // reuse the cached list unless the workspace changed (force).
    if (!force && state.appsLoaded) return;
    if (!control?.listInstalledApps) return;
    try {
      const apps = await control.listInstalledApps();
      state.apps = Array.isArray(apps) ? apps : [];
      state.appsLoaded = true;
      onAppsLoaded?.(state.apps);
    } catch (err) {
      console.error("[WorkspaceAppActions] Failed to load installed apps:", err);
    }
  }

  /** Open the workspace in `app`. */
  async function openWorkspaceInApp(app) {
    const path = getWorkspacePath();
    if (!control?.openInApp || !app || !path) return;
    try {
      await control.openInApp(path, {
        appName: app.appName ?? null,
        command: app.command ?? null,
      });
    } catch (err) {
      console.error("[WorkspaceAppActions] Failed to open workspace in app:", err);
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
      console.error("[WorkspaceAppActions] Failed to copy workspace path:", err);
      return "";
    }
  }

  return {
    get apps() {
      return state.apps;
    },
    loadApps,
    openWorkspaceInApp,
    copyWorkspacePath,
  };
}
