// @vitest-environment jsdom

// ABOUTME: Verifies the MCP settings page: two native layer tabs, per-entry toggle payloads,
// ABOUTME: array-command round-trip, adapter/shared migration banners, gateway error surfacing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { setupMcpPage } from "./mcp-page.js";

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

function mount(gateway) {
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
  const page = setupMcpPage({
    masterEl,
    detailEl,
    tabs: tabs.querySelectorAll("[data-mcp-tab]"),
    navItem,
    configGateway: gateway,
  });
  return { page, masterEl, detailEl, tabs, navItem };
}

function clickRow(masterEl, name) {
  const row = Array.from(masterEl.querySelectorAll(".pkg-manager-sidebar-row")).find((r) =>
    r.textContent.includes(name),
  );
  row.click();
}

function clickTab(tabs, key) {
  tabs.querySelector(`[data-mcp-tab="${key}"]`).click();
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
    const { page, masterEl } = mount({ call });

    await page.activate();
    const banners = masterEl.querySelectorAll(".mcp-legacy-notice");
    expect(banners.length).toBe(2);
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
    expect(masterEl.querySelectorAll(".mcp-legacy-notice").length).toBe(0);
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
});
