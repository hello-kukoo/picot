// @vitest-environment jsdom

// ABOUTME: Verifies the MCP settings page: two native layer tabs, per-entry toggle payloads,
// ABOUTME: array-command round-trip, adapter/shared migration banners, gateway error surfacing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsTransport } from "../app/transport.js";
import { setMessages } from "../i18n.js";
import { createMcpHostOps, setupMcpPage } from "./mcp-page.js";

setMessages({
  settings: {
    mcp: {
      title: "MCP",
      groups: { piGlobal: "User (global)", project: "Project" },
      readOnlyBadge: "read-only",
      disabledBadge: "disabled",
      effectHint: "hint",
      addMcp: "+ Add MCP",
      noProject: "no project servers",
      sourceLabel: "Source",
      sectionsAriaLabel: "MCP layers",
      save: "Save",
      delete: "Delete",
      enable: "Enable",
      disable: "Disable",
      saved: "Saved.",
      migrateNotice: "Old config {file} has {count} server(s) native Pi does not read.",
      migrate: "Migrate",
      migrationFailed: "Migration failed.",
      signIn: "Sign in",
      signOut: "Sign out",
      signedIn: "Signed in.",
      projectUntrusted: "Project not trusted",
      status: {
        connected: "Connected · {count} tools",
        connectedNoTools: "Connected",
        needsAuth: "Sign in required",
        disabled: "Disabled",
        error: "Error",
        unknown: "Unknown state",
        unavailable: "Live MCP status unavailable.",
      },
      login: {
        title: "Sign in to {name}",
        preparing: "Starting sign-in…",
        waiting: "Complete authorization in your browser.",
        openBrowser: "Open browser",
        cancel: "Cancel",
        retry: "Try again",
        failed: "Sign-in failed.",
        cancelled: "Sign-in cancelled.",
      },
      form: {
        name: "Name",
        type: "Type",
        stdio: "stdio",
        remote: "remote",
        command: "Command",
        url: "URL",
        args: "Args",
        env: "Env",
        headers: "Headers",
        urlRequired: "url required",
        commandRequired: "command required",
        exposure: "Tool exposure",
        exposure_codemode: "Default (codemode, via script search)",
        exposure_direct: "Direct",
        exposure_deferred: "Deferred (tool search)",
        exposure_hidden: "Hidden",
      },
    },
  },
});

function makeGateway(result) {
  return { call: vi.fn().mockResolvedValue(result) };
}

const LIST = {
  ok: true,
  data: {
    groups: {
      piGlobal: [
        {
          name: "context7",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP ${VAR} placeholder data
          entry: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { K: "${V}" } },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
        {
          name: "chrome-devtools",
          entry: { command: ["npx", "-y", "chrome-devtools-mcp"], futureField: { a: 1 } },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
        {
          name: "paused",
          entry: { url: "https://paused.example", enabled: false },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: false,
        },
      ],
      project: [
        {
          name: "repoTool",
          entry: { command: "run repo" },
          sourceFile: "/ws/repo/.pi/mcp.json",
          editable: true,
          enabled: true,
        },
      ],
    },
    groupErrors: {},
    migrations: [],
  },
};

function mount(gateway, extra = {}) {
  const masterEl = document.createElement("div");
  const detailEl = document.createElement("div");
  const tabs = document.createElement("div");
  for (const key of ["piGlobal", "project"]) {
    const btn = document.createElement("button");
    btn.dataset.mcpTab = key;
    tabs.appendChild(btn);
  }
  const navItem = document.createElement("button");
  navItem.className = "hidden";
  const captionEl = document.createElement("p");
  const migrationsEl = document.createElement("div");
  const page = setupMcpPage({
    masterEl,
    detailEl,
    tabs: tabs.querySelectorAll("[data-mcp-tab]"),
    navItem,
    configGateway: gateway,
    captionEl,
    migrationsEl,
    ...extra,
  });
  return { page, masterEl, detailEl, tabs, navItem, captionEl, migrationsEl };
}

function clickRow(masterEl, name) {
  const row = Array.from(masterEl.querySelectorAll(".pkg-manager-sidebar-row")).find((r) =>
    r.textContent.includes(name),
  );
  row.click();
}

function rowFor(masterEl, name) {
  return Array.from(masterEl.querySelectorAll(".pkg-manager-sidebar-row")).find((r) =>
    r.textContent.includes(name),
  );
}

function clickTab(tabs, key) {
  tabs.querySelector(`[data-mcp-tab="${key}"]`).click();
}

// Live-status fixture: every state the badge renderer must handle. `scope`
// matches pi's ServerReport; `remoteProj` is deliberately absent (pi omits
// servers from untrusted projects).
const STATUS_SERVERS = [
  { name: "context7", scope: "user", transport: "stdio", state: "connected", tools: [{}, {}, {}] },
  { name: "sentry", scope: "user", transport: "http", state: "needs-auth", tools: [] },
  {
    name: "remote-ok",
    scope: "user",
    transport: "http",
    state: "connected",
    tools: [{}],
  },
  {
    name: "flaky",
    scope: "user",
    transport: "http",
    state: "error",
    error: "connect ECONNREFUSED 127.0.0.1:9999",
    tools: [],
  },
  { name: "paused", scope: "user", transport: "http", state: "disabled", tools: [] },
  { name: "chrome-devtools", scope: "user", transport: "stdio", state: "connected", tools: [] },
];

const LIST_OAUTH = {
  ok: true,
  data: {
    groups: {
      piGlobal: [
        ...LIST.data.groups.piGlobal,
        {
          name: "sentry",
          entry: { url: "https://mcp.sentry.dev/mcp" },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
        {
          name: "remote-ok",
          entry: { url: "https://mcp.ok/mcp" },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
        {
          name: "flaky",
          entry: { url: "https://mcp.flaky/mcp" },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
        {
          name: "ghost",
          entry: { url: "https://mcp.ghost/mcp" },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          enabled: true,
        },
      ],
      project: [
        ...LIST.data.groups.project,
        {
          name: "remoteProj",
          entry: { url: "https://mcp.proj/mcp" },
          sourceFile: "/ws/repo/.pi/mcp.json",
          editable: true,
          enabled: true,
        },
      ],
    },
    groupErrors: {},
    migrations: [],
  },
};

/** Host-plane harness: the MCP login ops ride the WS host channel, not the
 * runtime config gateway — the page must be able to tell them apart. */
function makeMcpLogin(servers = STATUS_SERVERS) {
  let listener = null;
  return {
    start: vi.fn(async () => ({ ok: true, operationId: "op-1" })),
    cancel: vi.fn(async () => ({ ok: true, cancelled: true })),
    status: vi.fn(async () => ({ ok: true, status: "pending" })),
    logout: vi.fn(async () => ({ ok: true })),
    serverStatus: vi.fn(async () => ({ ok: true, servers })),
    subscribe: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    emit: (payload) => listener?.(payload),
  };
}

describe("mcp-page", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("auto-selects the first master row on load and on tab switch", async () => {
    const { page, detailEl, masterEl, tabs } = mount(makeGateway(LIST));
    await page.activate();
    // Default tab (user) auto-selects its first entry without any click.
    expect(detailEl.textContent).toContain("context7");
    expect(
      masterEl.querySelector(".pkg-manager-sidebar-row").classList.contains("is-selected"),
    ).toBe(true);

    clickTab(tabs, "project");
    expect(detailEl.textContent).toContain("repoTool");
  });

  it("renders two tabs, both with an add button; availability is always true", async () => {
    const { page, masterEl, tabs, navItem } = mount(makeGateway(LIST));
    await page.activate();
    expect(await page.refreshAvailability()).toBe(true);
    const tabButtons = Array.from(tabs.querySelectorAll("[data-mcp-tab]"));
    expect(tabButtons.map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(masterEl.querySelector(".models-provider-add")).not.toBeNull(); // user tab
    clickTab(tabs, "project");
    expect(masterEl.querySelector(".models-provider-add")).not.toBeNull(); // project tab
    expect(navItem.className).toBe("hidden"); // page never touches the nav anymore
  });

  it("disabled entry shows the badge; enabled entries do not", async () => {
    const { page, masterEl } = mount(makeGateway(LIST));
    await page.activate();
    clickRow(masterEl, "paused");
    expect(masterEl.textContent).toContain("disabled");
    clickRow(masterEl, "context7");
    expect(masterEl.querySelectorAll(".mcp-badge, [data-disabled-badge]").length).toBe(0);
  });

  it("user tab: editable form saves a normalized entry with the piGlobal scope", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    clickRow(masterEl, "context7");
    const form = detailEl.querySelector(".mcp-form");
    expect(form).not.toBeNull();
    expect(form.querySelector('input[placeholder="npx"]').value).toBe("npx");
    // ${VAR} placeholders are shown literally, never interpolated.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP ${VAR} placeholder data
    expect(form.querySelector('textarea[placeholder^="API_KEY="]').value).toContain("K=${V}");
    form.dispatchEvent(new Event("submit"));
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_save_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_save_server")[1];
    expect(payload.scope).toBe("piGlobal");
    expect(payload.name).toBe("context7");
    expect(payload.entry.command).toBe("npx");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP ${VAR} placeholder data
    expect(payload.entry.env).toEqual({ K: "${V}" });
  });

  it("array command: joined display, unmodified save passes the original array through", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    clickRow(masterEl, "chrome-devtools");
    const form = detailEl.querySelector(".mcp-form");
    const command = form.querySelector('input[placeholder="npx"]');
    expect(command.value).toBe("npx -y chrome-devtools-mcp"); // joined display
    form.dispatchEvent(new Event("submit")); // command untouched
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_save_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_save_server")[1];
    expect(payload.entry.command).toEqual(["npx", "-y", "chrome-devtools-mcp"]); // verbatim array
    expect(payload.entry.futureField).toEqual({ a: 1 }); // unknown keys preserved
  });

  it("exposure select defaults to codemode and round-trips the choice", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    clickRow(masterEl, "context7"); // no exposure in config
    const form = detailEl.querySelector(".mcp-form");
    const exposure = Array.from(form.querySelectorAll("select")).at(-1);
    expect(exposure.value).toBe("codemode");
    form.dispatchEvent(new Event("submit"));
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_save_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_save_server")[1];
    expect("exposure" in payload.entry).toBe(false); // default stays omitted

    exposure.value = "direct";
    form.dispatchEvent(new Event("submit"));
    await vi.waitFor(() => {
      const saves = gateway.call.mock.calls.filter((c) => c[0] === "mcp_save_server");
      expect(saves.at(-1)[1].entry.exposure).toBe("direct");
    });

    exposure.value = "codemode";
    form.dispatchEvent(new Event("submit"));
    await vi.waitFor(() => {
      const saves = gateway.call.mock.calls.filter((c) => c[0] === "mcp_save_server");
      expect("exposure" in saves.at(-1)[1].entry).toBe(false); // back to default removes the key
    });
  });

  it("detail: exactly one switch at the top; clicking sends scope+name+disable", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    clickRow(masterEl, "context7");
    expect(detailEl.querySelectorAll('[role="switch"]').length).toBe(1); // no duplicate
    const toggle = detailEl.querySelector('.mcp-entry [role="switch"]');
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // enabled
    toggle.click();
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_toggle_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_toggle_server")[1];
    expect(payload).toEqual({ scope: "piGlobal", name: "context7", disable: true });
  });

  it("project tab entry carries the project scope in its toggle payload", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl, tabs } = mount(gateway);
    await page.activate();
    clickTab(tabs, "project");
    clickRow(masterEl, "repoTool");
    detailEl.querySelector('.mcp-entry [role="switch"]').click();
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_toggle_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_toggle_server")[1];
    expect(payload.scope).toBe("project");
  });

  it("migration banners: one per available target, click migrates then reloads", async () => {
    const withMigrations = {
      ok: true,
      data: {
        ...LIST.data,
        migrations: [
          {
            id: "adapterGlobal",
            sourceFile: "/home/u/.pi/agent/mcp-adapter.json",
            missing: ["zread"],
          },
          {
            id: "sharedGlobal",
            sourceFile: "/home/u/.agents/mcp.json",
            missing: ["grep", "first"],
          },
        ],
      },
    };
    const afterMigrate = { ok: true, data: { ...LIST.data, migrations: [] } };
    const call = vi
      .fn()
      .mockResolvedValueOnce(withMigrations) // activate() load
      .mockResolvedValueOnce({ ok: true, data: { migrated: ["zread"], skipped: [], lossy: [] } })
      .mockResolvedValueOnce(afterMigrate); // reload after migrate
    const { page, masterEl, migrationsEl } = mount({ call });

    await page.activate();
    const banners = migrationsEl.querySelectorAll(".mcp-legacy-notice");
    expect(banners.length).toBe(2);
    // Notices live OUTSIDE the master list entirely (below the layout).
    expect(masterEl.querySelector(".mcp-legacy-notice")).toBeNull();
    expect(banners[0].textContent).toContain("mcp-adapter.json");
    expect(banners[0].textContent).toContain("1"); // missing count
    expect(banners[1].textContent).toContain(".agents/mcp.json");
    expect(banners[1].textContent).toContain("2");

    banners[0].querySelector(".mcp-legacy-migrate").click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      "mcp_list_servers",
      "mcp_migrate_adapter_config",
      "mcp_list_servers",
    ]);
    expect(call.mock.calls[1][1]).toEqual({ target: "adapterGlobal" });
    expect(migrationsEl.querySelectorAll(".mcp-legacy-notice").length).toBe(0);
  });

  it("save and delete share one action row in the edit form; add has no delete", async () => {
    const { page, masterEl, detailEl } = mount(makeGateway(LIST));
    await page.activate();
    clickRow(masterEl, "context7");
    const actions = detailEl.querySelector(".mcp-form-actions");
    expect(actions.textContent).toContain("Save");
    expect(actions.textContent).toContain("Delete");

    const add2 = mount(makeGateway(LIST));
    await add2.page.activate();
    add2.masterEl.querySelector(".models-provider-add").click();
    const addActions = add2.detailEl.querySelector(".mcp-form-actions");
    expect(addActions.textContent).toContain("Save");
    expect(addActions.textContent).not.toContain("Delete");
  });

  it("gateway rejection surfaces as an error status instead of an unhandled rejection", async () => {
    const gateway = { call: vi.fn().mockRejectedValue(new Error("request timed out")) };
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    expect(masterEl.children.length).toBe(0); // load failed → empty master
    expect(detailEl.textContent).toContain("request timed out");
  });

  describe("live status badges", () => {
    async function mountWithStatus(extra = {}) {
      const gateway = makeGateway(LIST_OAUTH);
      const mcpLogin = makeMcpLogin();
      const mounted = mount(gateway, { mcpLogin, openExternal: vi.fn(), ...extra });
      await mounted.page.activate();
      return { ...mounted, gateway, mcpLogin };
    }

    it("queries mcp_server_status once per activation and never polls the page", async () => {
      const { mcpLogin } = await mountWithStatus();
      expect(mcpLogin.serverStatus).toHaveBeenCalledTimes(1);
      expect(mcpLogin.status).not.toHaveBeenCalled();
      // Idle time must not produce a second status query (the host report has
      // real connection cost; only an in-flight login polls).
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mcpLogin.serverStatus).toHaveBeenCalledTimes(1);
    });
    it("merges state, tool count, and error detail onto the matching rows", async () => {
      const { masterEl } = await mountWithStatus();

      const connected = rowFor(masterEl, "context7").querySelector(".mcp-status-badge");
      expect(connected.className).toContain("is-connected");
      expect(connected.textContent).toEqual("Connected · 3 tools");

      const needsAuth = rowFor(masterEl, "sentry").querySelector(".mcp-status-badge");
      expect(needsAuth.className).toContain("is-needs-auth");
      expect(needsAuth.textContent).toEqual("Sign in required");

      const error = rowFor(masterEl, "flaky").querySelector(".mcp-status-badge");
      expect(error.className).toContain("is-error");
      expect(error.textContent).toContain("ECONNREFUSED");
      expect(error.title).toEqual("connect ECONNREFUSED 127.0.0.1:9999");

      const disabled = rowFor(masterEl, "paused").querySelector(".mcp-status-badge");
      expect(disabled.className).toContain("is-disabled");
    });

    it("offers sign-in only for http rows awaiting authorization", async () => {
      const { masterEl, detailEl } = await mountWithStatus();

      clickRow(masterEl, "context7"); // connected stdio
      expect(detailEl.querySelector('[data-action="mcp-login"]')).toBeNull();
      expect(detailEl.querySelector('[data-action="mcp-logout"]')).toBeNull();

      clickRow(masterEl, "sentry"); // needs-auth http
      const signIn = detailEl.querySelector('[data-action="mcp-login"]');
      expect(signIn).not.toBeNull();
      expect(signIn.disabled).toBe(false);
      expect(signIn.textContent).toEqual("Sign in");
      expect(detailEl.querySelector('[data-action="mcp-logout"]')).toBeNull();

      // Config-disabled rows keep a disabled badge and no sign-in affordance.
      clickRow(masterEl, "paused");
      expect(detailEl.querySelector('[data-action="mcp-login"]')).toBeNull();

      // An `error` row cannot be fixed by `/mcp login` (headers auth, env
      // problems): no sign-in promise, the error badge carries the detail.
      clickRow(masterEl, "flaky");
      expect(detailEl.querySelector('[data-action="mcp-login"]')).toBeNull();

      // No live report at all (status query failed / server not listed):
      // no button either — the row stays a plain config entry.
      clickRow(masterEl, "ghost");
      expect(detailEl.querySelector('[data-action="mcp-login"]')).toBeNull();
    });

    it("renders the tab caption outside the master list and follows tab switches", async () => {
      const { masterEl, captionEl, tabs } = await mountWithStatus();
      const groupCount = LIST_OAUTH.data.groups.piGlobal.length;
      expect(captionEl.textContent).toBe(`User (global) · ${groupCount}`);
      // The caption lives outside the master list; the list itself starts
      // with a row, not the scope header.
      expect(masterEl.textContent).not.toContain(`User (global) · ${groupCount}`);

      clickTab(tabs, "project");
      expect(captionEl.textContent).toBe(`Project · ${LIST_OAUTH.data.groups.project.length}`);
    });

    it("offers sign-out only for connected http rows", async () => {
      const { masterEl, detailEl } = await mountWithStatus();
      clickRow(masterEl, "remote-ok");
      const signOut = detailEl.querySelector('[data-action="mcp-logout"]');
      expect(signOut).not.toBeNull();
      expect(detailEl.querySelector('[data-action="mcp-login"]')).toBeNull();
    });

    it("blocks sign-in for project servers pi does not report as trusted", async () => {
      const { masterEl, detailEl, tabs } = await mountWithStatus();
      clickTab(tabs, "project");
      clickRow(masterEl, "remoteProj");

      const signIn = detailEl.querySelector('[data-action="mcp-login"]');
      expect(signIn).not.toBeNull();
      expect(signIn.disabled).toBe(true);
      expect(detailEl.textContent).toContain("Project not trusted");

      // A project server pi DOES report keeps the normal needs-auth flow.
      clickTab(tabs, "piGlobal");
      clickRow(masterEl, "sentry");
      expect(detailEl.querySelector('[data-action="mcp-login"]').disabled).toBe(false);
    });

    it("sign-in mounts the dialog and refreshes status and list on success", async () => {
      const { gateway, masterEl, detailEl, mcpLogin } = await mountWithStatus();
      clickRow(masterEl, "sentry");
      detailEl.querySelector('[data-action="mcp-login"]').click();

      await vi.waitFor(() => expect(mcpLogin.start).toHaveBeenCalledWith("sentry"));
      expect(document.querySelector(".mcp-login-dialog-backdrop")).not.toBeNull();

      const listCalls = gateway.call.mock.calls.length;
      mcpLogin.emit({ operationId: "op-1", status: "succeeded" });

      await vi.waitFor(() => {
        expect(mcpLogin.serverStatus).toHaveBeenCalledTimes(2);
        expect(gateway.call.mock.calls.length).toBe(listCalls + 1);
      });
      expect(document.querySelector(".mcp-login-dialog-backdrop")).toBeNull();
      expect(gateway.call.mock.calls.at(-1)[0]).toBe("mcp_list_servers");
    });

    it("sign-out calls mcp_logout and refreshes status and list", async () => {
      const { gateway, masterEl, detailEl, mcpLogin } = await mountWithStatus();
      clickRow(masterEl, "remote-ok");
      detailEl.querySelector('[data-action="mcp-logout"]').click();

      await vi.waitFor(() => expect(mcpLogin.logout).toHaveBeenCalledWith("remote-ok"));
      await vi.waitFor(() => expect(mcpLogin.serverStatus).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(gateway.call.mock.calls.at(-1)[0]).toBe("mcp_list_servers"));
      expect(gateway.call.mock.calls.at(-1)[0]).toBe("mcp_list_servers");
    });

    it("a failed status query degrades to the plain config list", async () => {
      const gateway = makeGateway(LIST_OAUTH);
      const mcpLogin = makeMcpLogin();
      mcpLogin.serverStatus = vi.fn(async () => ({ ok: false, error: "pi mcp list failed" }));
      const { page, masterEl } = mount(gateway, { mcpLogin, openExternal: vi.fn() });
      await page.activate();

      expect(masterEl.querySelectorAll(".mcp-status-badge").length).toBe(0);
      expect(masterEl.querySelector(".mcp-status-error").textContent).toContain(
        "Live MCP status unavailable.",
      );
      expect(rowFor(masterEl, "sentry")).not.toBeUndefined();
    });

    it("a rejected status query never breaks the page", async () => {
      const gateway = makeGateway(LIST_OAUTH);
      const mcpLogin = makeMcpLogin();
      mcpLogin.serverStatus = vi.fn(async () => {
        throw new Error("Transport is not connected");
      });
      const { page, masterEl } = mount(gateway, { mcpLogin, openExternal: vi.fn() });
      await page.activate();

      expect(masterEl.querySelectorAll(".mcp-status-badge").length).toBe(0);
      expect(rowFor(masterEl, "sentry")).not.toBeUndefined();
    });
  });

  describe("host login surface adapter", () => {
    it("carries a real WS mcpLoginUpdate frame through the transport into the dialog", async () => {
      const listeners = new Map();
      const wsClient = {
        capabilities: { native: true },
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: (type) => listeners.delete(type),
        sendControl: vi.fn(async (op) => {
          if (op === "mcp_login_start") return { ok: true, operationId: "op-1" };
          if (op === "mcp_server_status") return { ok: true, servers: STATUS_SERVERS };
          return { ok: true };
        }),
      };
      const { page, masterEl, detailEl } = mount(makeGateway(LIST_OAUTH), {
        mcpLogin: createMcpHostOps(new WsTransport(wsClient, {})),
        openExternal: vi.fn(),
      });
      await page.activate();
      clickRow(masterEl, "sentry");
      detailEl.querySelector('[data-action="mcp-login"]').click();

      await vi.waitFor(() =>
        expect(wsClient.sendControl).toHaveBeenCalledWith(
          "mcp_login_start",
          { name: "sentry" },
          expect.anything(),
        ),
      );
      // Exactly the host frame shape the Rust runner emits.
      listeners.get("mcpLoginUpdate")({
        detail: { type: "mcpLoginUpdate", payload: { operationId: "op-1", status: "succeeded" } },
      });

      await vi.waitFor(() =>
        expect(document.querySelector(".mcp-login-dialog-backdrop")).toBeNull(),
      );
      expect(wsClient.sendControl).toHaveBeenCalledWith("mcp_server_status", {}, expect.anything());
    });

    it("forwards the page login surface onto the transport control ops", async () => {
      const transport = {
        mcpLoginStart: vi.fn(async () => ({ ok: true, operationId: "op-1" })),
        mcpLoginCancel: vi.fn(async () => ({ ok: true, cancelled: true })),
        mcpLoginStatus: vi.fn(async () => ({ ok: true, status: "pending" })),
        mcpLogout: vi.fn(async () => ({ ok: true })),
        mcpServerStatus: vi.fn(async () => ({ ok: true, servers: [] })),
        onMcpLoginUpdate: vi.fn(() => () => {}),
      };
      const ops = createMcpHostOps(transport);
      const listener = vi.fn();

      await ops.start("sentry");
      await ops.cancel("op-1");
      await ops.status("op-1");
      await ops.logout("sentry");
      await ops.serverStatus();
      ops.subscribe(listener);

      expect(transport.mcpLoginStart).toHaveBeenCalledWith("sentry");
      expect(transport.mcpLoginCancel).toHaveBeenCalledWith("op-1");
      expect(transport.mcpLoginStatus).toHaveBeenCalledWith("op-1");
      expect(transport.mcpLogout).toHaveBeenCalledWith("sentry");
      expect(transport.mcpServerStatus).toHaveBeenCalledWith();
      expect(transport.onMcpLoginUpdate).toHaveBeenCalledWith(listener);
    });
  });
});
