// ABOUTME: Verifies the landing bootstrap: seam routing into enterWorkspace,
// ABOUTME: the prepare→commit→navigate contract with no chat-lifecycle objects,
// ABOUTME: locale-following copy, and Quick Chat entry visibility.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const landingSource = readFileSync("public/landing.js", "utf8");
const landingCodeOnly = landingSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/^\s*\/\/.*$/, ""))
  .join("\n");

const harness = vi.hoisted(() => ({
  transport: null,
  sidebarInstance: null,
  wsClient: null,
}));

vi.mock("./app/websocket-client.js", () => ({
  resolveWebSocketUrl: () => "ws://127.0.0.1:0/v2/ws",
  WebSocketClient: class extends EventTarget {
    connect() {}
  },
}));

vi.mock("./app/transport.js", () => ({
  initTransport: ({ wsClient }) => {
    harness.wsClient = wsClient;
    return harness.transport;
  },
}));

vi.mock("./sidebar/index.js", () => ({
  SessionSidebar: class {
    constructor(_container, onSessionSelect, onNewChat, options) {
      // The seams live on the instance itself: landing.js holds `new
      // SessionSidebar(...)` and calls methods on it, so a bare class with
      // only a recorded literal would make every sidebar.* call throw.
      Object.assign(this, {
        onSessionSelect,
        onNewChat,
        onRegisterWorkspace: options.onRegisterWorkspace,
        onWorkspaceFocus: options.onWorkspaceFocus,
        canFocusWorkspace: options.canFocusWorkspace,
        isCurrentWorkspace: options.isCurrentWorkspace,
        expandedWorkspaces: new Set(),
        searchQuery: "",
        projects: [],
        _registryPins: null,
        render: () => {},
        refresh: () => harness.refreshCalls.push(1),
        addProjectViaPicker: () => harness.pickerCalls.push(1),
      });
      harness.sidebarInstance = this;
    }
  },
}));

function makeTransportStub() {
  return {
    capabilities: { native: true },
    mobileAccessInfo: async () => ({ enabled: false, lanUrls: [] }),
    listSkillInventory: async () => ({ skills: [] }),
    setSkillEnabled: async () => ({}),
    getPreference: async () => ({ value: true }),
    runtimeInstances: async () => ({ instances: [] }),
    prepareWorkspaceTarget: async (targetCwd, options) => {
      harness.prepares.push({ targetCwd, options });
      const generation = 100 + harness.prepares.length;
      harness.generations.push(generation);
      return {
        classification: "cross",
        transitionGeneration: generation,
        // Same document origin: landing's navigate guard rejects cross-origin
        // targets, exactly like production where every workspace route shares
        // the host origin.
        targetOrigin: `${harness.origin}/workspaces/wid/sessions/sid-${harness.prepares.length}`,
        targetWorkspaceId: "wid",
        targetSessionId: `sid-${harness.prepares.length}`,
      };
    },
    commitWorkspaceTransition: async (generation) => {
      harness.commits.push(generation);
      return { targetOrigin: "http://127.0.0.1:9", workspaceGeneration: generation };
    },
    cancelWorkspaceTransition: async () => {},
  };
}

const booted = { value: null };
const navigation = { calls: [] };

/** jsdom's location.assign is an own non-configurable value property, but
 * `window.location` itself is configurable: swap the whole object once and
 * record every assign target. */
function trackNavigation() {
  if (!navigation.patched) {
    const real = { ...window.location };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign: (url) => navigation.calls.push(String(url)) },
    });
    navigation.patched = true;
  }
  navigation.calls.length = 0;
  return navigation.calls;
}

function installDom() {
  document.body.innerHTML = `
    <div class="app-layout">
      <div class="sidebar" id="sidebar">
        <button id="add-project-btn"></button>
        <button id="quick-chat-btn" class="hidden"></button>
        <button id="refresh-sessions-btn"></button>
        <div class="session-list" id="session-list"></div>
        <button id="settings-btn"></button>
        <button id="toggle-mobile-access"></button>
        <div id="mobile-access-details"></div>
        <div id="mobile-access-pairing">
          <button id="mobile-pair-btn"></button>
          <canvas id="mobile-qr-canvas"></canvas>
          <span id="mobile-pair-token"></span>
          <span id="mobile-restart-hint"></span>
        </div>
      </div>
      <div class="workspace"><div class="main">
        <div id="quick-chat-dialog-root"></div>
        <div id="quick-chat-chip-root"></div>
      </div></div>
      <div class="landing hidden" id="landing" aria-hidden="true">
        <div class="landing-drag-strip" aria-hidden="true"></div>
        <div class="landing-logo"><img id="landing-logo-img" alt="" /></div>
        <div class="landing-name">Picot</div>
        <p class="landing-hint" data-i18n="landing.hint"></p>
        <button type="button" class="landing-btn" id="landing-add-project-btn">
          <span class="landing-btn-icon" id="landing-add-project-icon"></span>
          <span data-i18n="sidebar.addProject"></span>
        </button>
        <div class="landing-notice hidden" id="landing-notice" role="status"></div>
      </div>
      <div id="settings-skills-save-message"></div>
      <button data-skills-page-tab="discovered">Discovered</button>
      <button data-skills-page-tab="install">Install</button>
      <button data-skills-page-tab="packages">Packages</button>
      <div id="settings-skills"></div>
      <div id="settings-install-skills"></div>
      <div id="settings-package-skills"></div>
      <button data-extensions-tab="installed">Installed</button>
      <button data-extensions-tab="community">Community</button>
      <div id="extensions-installed">
        <div id="pkg-manager-groups"></div>
        <div id="pkg-manager-detail"></div>
        <div id="pkg-manager-footer"></div>
      </div>
      <div id="extensions-community">
        <div id="pkg-browse-list"></div>
        <input id="pkg-browse-search" />
        <div id="pkg-browse-pills"></div>
        <div id="pkg-browse-count"></div>
        <div id="pkg-browse-sort"></div>
      </div>
    </div>`;
}

async function bootLanding() {
  installDom();
  harness.origin = window.location.origin;
  harness.transport = makeTransportStub();
  harness.prepares = [];
  harness.generations = [];
  harness.commits = [];
  harness.refreshCalls = [];
  harness.pickerCalls = [];
  document.cookie = "picot-language=en; Max-Age=600; path=/";
  // vitest does not serve /locales/*.json as JSON; feed i18n the real locale
  // files from disk so t() and applyTranslations behave like production.
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input) => {
    const match = String(input).match(/locales\/([a-z]{2})\.json/);
    if (match) {
      const body = readFileSync(`public/locales/${match[1]}.json`, "utf8");
      return { ok: true, json: async () => JSON.parse(body) };
    }
    return realFetch(input);
  });
  booted.value = await import("./landing.js");
  return booted.value;
}

beforeEach(() => {
  vi.resetModules();
  document.cookie = "picot-language=; Max-Age=0; path=/";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("landing source never references chat-lifecycle objects", () => {
  const forbidden = [
    "MessageRenderer",
    "ToolCardRenderer",
    "ConfigGateway",
    "createOauthGateway",
    "TerminalPanel",
    "terminalPanel",
    "GitPanel",
    "gitPanel",
    "filePreviewPanel",
    "SideChatManager",
    "sideChatManager",
    "resetUiForNewSession",
    "fetchDiskHistory",
    "model-dropdown",
  ];
  for (const symbol of forbidden) {
    expect(landingCodeOnly, `landing.js must not reference ${symbol}`).not.toContain(symbol);
  }
});

test("boot reveals the landing and hides the workspace chrome", async () => {
  await bootLanding();
  expect(document.body.classList.contains("landing-mode")).toBe(true);
  const landing = document.getElementById("landing");
  expect(landing.classList.contains("hidden")).toBe(false);
  expect(landing.getAttribute("aria-hidden")).toBe("false");
});

test("landing settings show only functional tabs; usage works, Pi-bound tabs hidden", async () => {
  installDom();
  document.body.insertAdjacentHTML(
    "beforeend",
    `
<div class="settings-panel hidden" id="settings-panel">
<div class="settings-nav">
<button class="settings-nav-back" id="settings-close" type="button"><span class="settings-nav-back-icon" aria-hidden="true"></span></button>
<div class="settings-nav-item active" data-settings-tab="general">General</div>
<div class="settings-nav-item" data-settings-tab="appearance">Appearance</div>
<div class="settings-nav-item" data-settings-tab="usage">Usage</div>
<div class="settings-nav-item" data-settings-tab="models">Models</div>
<div class="settings-nav-item" data-settings-tab="skills">Skills</div>
<div class="settings-nav-item" data-settings-tab="mcp">MCP</div>
<div class="settings-nav-item" data-settings-tab="extensions">Extensions</div>
<div class="settings-nav-item" data-settings-tab="configuration">Advanced</div>
</div>
<div class="settings-tab active" data-settings-panel="general">
<select id="settings-language-select"></select>
<div class="settings-row" id="setting-pi-version">
<span id="setting-pi-version-value"></span>
</div>
</div>
<div class="settings-tab" data-settings-panel="appearance">
<div class="theme-grid" id="theme-grid"></div>
</div>
<div class="settings-tab" data-settings-panel="usage">
<cost-dashboard id="settings-cost-dashboard" defer-load></cost-dashboard>
</div>
<div class="settings-tab" data-settings-panel="models"></div>
</div>`,
  );
  harness.transport = makeTransportStub();
  harness.prepares = [];
  harness.generations = [];
  harness.commits = [];
  harness.refreshCalls = [];
  harness.pickerCalls = [];
  document.cookie = "picot-language=en; Max-Age=600; path=/";
  // This test asserts localized copy: feed i18n the real locale files.
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input) => {
    const match = String(input).match(/locales\/([a-z]{2})\.json/);
    if (match) {
      const body = readFileSync(`public/locales/${match[1]}.json`, "utf8");
      return { ok: true, json: async () => JSON.parse(body) };
    }
    return realFetch(input);
  });
  await import("./landing.js");

  document.getElementById("settings-btn").click();
  const panel = document.getElementById("settings-panel");
  expect(panel.classList.contains("hidden")).toBe(false);
  const navItems = [...panel.querySelectorAll(".settings-nav-item[data-settings-tab]")];
  const hidden = (tab) =>
    navItems.find((item) => item.dataset.settingsTab === tab).classList.contains("hidden");
  // Everything visible at landing works; Pi-bound tabs are hidden entirely.
  expect(hidden("general")).toBe(false);
  expect(hidden("appearance")).toBe(false);
  expect(hidden("usage")).toBe(false);
  expect(hidden("skills")).toBe(false);
  expect(hidden("extensions")).toBe(false);
  expect(hidden("models")).toBe(true);
  expect(hidden("mcp")).toBe(true);
  expect(hidden("configuration")).toBe(true);
  // Usage activates and lazy-loads the cost dashboard element.
  const ensureLoaded = vi.fn();
  document.getElementById("settings-cost-dashboard").ensureLoaded = ensureLoaded;
  navItems.find((item) => item.dataset.settingsTab === "usage").click();
  expect(
    panel.querySelector('.settings-tab[data-settings-panel="usage"]').classList.contains("active"),
  ).toBe(true);
  expect(ensureLoaded).toHaveBeenCalled();
  // The pi-version row stays visible: its value rides a host control op.
  expect(document.getElementById("setting-pi-version").classList.contains("hidden")).toBe(false);
  expect(document.querySelector("#settings-close .settings-nav-back-icon svg")).not.toBeNull();
  // The back button returns to the landing view.
  document.getElementById("settings-close").click();
  expect(panel.classList.contains("hidden")).toBe(true);
  // The bridge-bound packages sub-tab is hidden entirely at landing (no
  // visible entry) and excluded from the shell (no keyboard selection).
  const discoveredTab = document.querySelector('[data-skills-page-tab="discovered"]');
  const packagesTab = document.querySelector('[data-skills-page-tab="packages"]');
  expect(packagesTab.classList.contains("hidden")).toBe(true);
  discoveredTab.click();
  expect(discoveredTab.classList.contains("active")).toBe(true);
  packagesTab.click();
  expect(packagesTab.classList.contains("active")).toBe(false);
  expect(document.getElementById("settings-package-skills").classList.contains("hidden")).toBe(
    true,
  );
  // Appearance stays fully functional.
  navItems.find((item) => item.dataset.settingsTab === "appearance").click();
  expect(
    panel
      .querySelector('.settings-tab[data-settings-panel="appearance"]')
      .classList.contains("active"),
  ).toBe(true);
  expect(panel.querySelectorAll("#theme-grid .theme-swatch").length).toBeGreaterThan(0);
});

test("session-row seam routes prepare → commit → navigate", async () => {
  await bootLanding();
  const assigns = trackNavigation();
  const ok = await harness.sidebarInstance.onSessionSelect(
    { filePath: "/tmp/s.jsonl", cwd: "/tmp/ws" },
    { path: "/tmp/ws" },
  );
  expect(ok).toBe(true);
  expect(harness.prepares).toHaveLength(1);
  expect(harness.prepares[0]).toEqual({
    targetCwd: "/tmp/ws",
    options: { sessionPath: "/tmp/s.jsonl", forceNewSession: false, reuseExisting: false },
  });
  expect(harness.commits).toEqual(harness.generations);
  expect(assigns).toHaveLength(1);
  const navigated = new URL(assigns[0]);
  expect(navigated.pathname).toBe("/workspaces/wid/sessions/sid-1");
  expect(navigated.searchParams.has("focusWorkspaceId")).toBe(false);
});

test("new-chat and post-add seams force a new session", async () => {
  await bootLanding();
  trackNavigation();
  await harness.sidebarInstance.onNewChat({ path: "/tmp/zero" });
  expect(harness.prepares[0].options).toEqual({
    sessionPath: null,
    forceNewSession: true,
    reuseExisting: false,
  });
  const launched = await harness.sidebarInstance.onRegisterWorkspace("/tmp/added");
  expect(launched).toBe(true);
  expect(harness.prepares[1].options.forceNewSession).toBe(true);
});

test("focus seam is absent at landing: no session selected means no focus entry", async () => {
  await bootLanding();
  // Focus-mode gating is "a workspace session is selected"; landing selects
  // none, so the sidebar receives neither seam and the classic predicate
  // (active session or current workspace) can never pass.
  expect(harness.sidebarInstance.canFocusWorkspace ?? null).toBeNull();
  expect(harness.sidebarInstance.onWorkspaceFocus ?? null).toBeNull();
});

test("hint and button labels follow the active locale", async () => {
  await bootLanding();
  const en = JSON.parse(readFileSync("public/locales/en.json", "utf8"));
  expect(document.querySelector(".landing-hint").textContent).toBe(en.landing.hint);
  const { setLocale } = await import("./i18n.js");
  await setLocale("zh");
  const zh = JSON.parse(readFileSync("public/locales/zh.json", "utf8"));
  expect(document.querySelector(".landing-hint").textContent).toBe(zh.landing.hint);
  expect(
    document.querySelector("#landing-add-project-btn [data-i18n='sidebar.addProject']").textContent,
  ).toBe(zh.sidebar.addProject);
  await setLocale("en");
});

test("quick chat button unhides after host capabilities arrive", async () => {
  await bootLanding();
  const button = document.getElementById("quick-chat-btn");
  expect(button.classList.contains("hidden")).toBe(true);
  expect(harness.refreshCalls).toHaveLength(0);
  harness.wsClient.dispatchEvent(new Event("hostCapabilities"));
  expect(button.classList.contains("hidden")).toBe(false);
  // The same hello-handshake listener runs the initial sidebar registry load
  // (the workspace shell's refreshInitialSidebar contract): without it the
  // cookie-cached rows stay authoritative forever and their lazy session
  // refetches carry no registryId.
  expect(harness.refreshCalls.length).toBeGreaterThanOrEqual(1);
});

test("errors render into the landing notice, never a chat renderer", async () => {
  await bootLanding();
  harness.transport.prepareWorkspaceTarget = async () => {
    throw new Error("spawn failed");
  };
  trackNavigation();
  const ok = await harness.sidebarInstance.onNewChat({ path: "/tmp/broken" });
  expect(ok).toBe(false);
  const notice = document.getElementById("landing-notice");
  expect(notice.classList.contains("hidden")).toBe(false);
  expect(notice.textContent).toContain("spawn failed");
});
