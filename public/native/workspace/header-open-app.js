const STORAGE_KEY = "picot-open-app";

// Shared brand-mark tables: the header split-button and the Info panel both
// resolve app logos/monograms from these tables so the two surfaces can
// never drift (v3 "same action source" invariant).
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

function renderLogo(app) {
  const icon = OPEN_APP_ICONS[app?.id];
  if (icon) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = "";
    image.className = "header-open-app-logo-img";
    return image;
  }
  const label = document.createElement("span");
  label.className = "header-open-app-logo-text";
  label.textContent = OPEN_APP_MONOGRAMS[app?.id] || app?.label?.slice(0, 1).toUpperCase() || "•";
  return label;
}

function reportError(onError, error) {
  onError?.(error instanceof Error ? error : new Error(String(error)));
}

/**
 * Wire the header split button that opens the current workspace in an external
 * editor/app (VS Code, Cursor, Finder, Terminal, ...).
 *
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {import('./control-gateway.js').HostControlGateway} options.control
 * @param {string} options.workspaceId
 * @param {(error: Error) => void} [options.onError]
 * @returns {boolean}
 */
export function setupHeaderOpenApp({ data, control, workspaceId, onError } = {}) {
  const root = document.getElementById("header-open-app");
  const button = document.getElementById("header-open-app-btn");
  const logo = document.getElementById("header-open-app-logo");
  const toggle = document.getElementById("header-open-app-toggle");
  const menu = document.getElementById("header-open-app-menu");
  if (!root || !button || !logo || !toggle || !menu) return false;

  const state = {
    apps: [],
    path: "",
    selectedId: localStorage.getItem(STORAGE_KEY) || null,
  };

  const selectedApp = () =>
    state.apps.find((app) => app.id === state.selectedId) || state.apps[0] || null;

  const refresh = () => {
    const app = selectedApp();
    if (!state.path || !app || state.apps.length === 0) {
      root.classList.add("hidden");
      return;
    }
    root.classList.remove("hidden");
    logo.replaceChildren(renderLogo(app));
    button.title = `Open ${state.path} in ${app.label}`;
    button.setAttribute("aria-label", `Open workspace in ${app.label}`);
  };

  // Portal the menu to <body> so it escapes the header's `overflow-x: auto;
  // overflow-y: hidden` clipping (the header scrolls horizontally when its
  // content overflows, which also clips any child that visually extends
  // below it, per docs/engineering-lessons.md). Re-position it with fixed
  // coordinates on every open so it tracks the toggle button.
  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }

  const positionMenu = () => {
    const rect = toggle.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.left = "auto";
  };

  const closeMenu = () => menu.classList.add("hidden");

  const openWorkspace = async (app = selectedApp()) => {
    if (!app || !state.path) return;
    state.selectedId = app.id;
    localStorage.setItem(STORAGE_KEY, app.id);
    refresh();
    try {
      await control.openInApp(state.path, {
        appName: app.appName ?? null,
        command: app.command ?? null,
      });
    } catch (error) {
      reportError(onError, error);
    }
  };

  const renderMenu = () => {
    menu.innerHTML = "";
    for (const app of state.apps) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "header-open-app-menu-item";
      if (app.id === state.selectedId) item.classList.add("active");
      item.title = `Open in ${app.label}`;
      item.setAttribute("aria-label", `Open in ${app.label}`);
      const glyph = document.createElement("span");
      glyph.className = "header-open-app-logo";
      glyph.setAttribute("aria-hidden", "true");
      glyph.append(renderLogo(app));
      const name = document.createElement("span");
      name.textContent = app.label;
      item.append(glyph, name);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu();
        openWorkspace(app);
      });
      menu.appendChild(item);
    }
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openWorkspace();
  });
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.classList.contains("hidden")) {
      renderMenu();
      positionMenu();
      menu.classList.remove("hidden");
    } else {
      closeMenu();
    }
  });
  document.addEventListener("click", closeMenu);

  Promise.all([data.workspaceInfo(workspaceId).catch(() => null), control.listInstalledApps()])
    .then(([workspace, apps]) => {
      state.path = workspace?.info?.path || "";
      state.apps = Array.isArray(apps) ? apps : [];
      if (!state.apps.some((app) => app.id === state.selectedId)) {
        state.selectedId = state.apps[0]?.id || null;
      }
      refresh();
    })
    .catch((error) => {
      root.classList.add("hidden");
      reportError(onError, error);
    });

  return true;
}
