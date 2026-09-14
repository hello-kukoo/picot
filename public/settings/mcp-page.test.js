// @vitest-environment jsdom

// ABOUTME: Verifies the MCP settings page: three layer tabs, per-entry readonly/editable,
// ABOUTME: source display, array-command round-trip, disable toggle payload, nav availability.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { setupMcpPage } from "./mcp-page.js";

setMessages({
  settings: {
    mcp: {
      title: "MCP",
      groups: { sharedGlobal: "Shared (global)", piGlobal: "Pi (global)", project: "Project" },
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
    installed: true,
    groups: {
      sharedGlobal: [
        {
          name: "grep",
          entry: { url: "https://mcp.grep.app", directTools: true },
          sourceFile: "/home/u/.config/mcp/mcp.json",
          editable: false,
          ownDisabled: false,
          effectiveDisabled: false,
        },
      ],
      piGlobal: [
        {
          name: "context7",
          entry: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { K: "${V}" } },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          ownDisabled: false,
          effectiveDisabled: false,
        },
        {
          name: "chrome-devtools",
          entry: { command: ["npx", "-y", "chrome-devtools-mcp"], lifecycle: "lazy" },
          sourceFile: "/home/u/.pi/agent/mcp.json",
          editable: true,
          ownDisabled: false,
          effectiveDisabled: false,
        },
      ],
      project: [
        {
          name: "repoTool",
          entry: { command: "run repo" },
          sourceFile: "/ws/repo/.mcp.json",
          editable: false,
          ownDisabled: false,
          effectiveDisabled: false,
        },
        {
          name: "local",
          entry: { command: "run local" },
          sourceFile: "/ws/repo/.pi/mcp.json",
          editable: true,
          ownDisabled: false,
          effectiveDisabled: false,
        },
      ],
    },
    groupErrors: {},
  },
};

function mount(gateway) {
  const masterEl = document.createElement("div");
  const detailEl = document.createElement("div");
  const tabs = document.createElement("div");
  for (const key of ["sharedGlobal", "piGlobal", "project"]) {
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

  it("renders three tabs, switches active tab, and unhides nav when installed", async () => {
    const { page, masterEl, tabs, navItem } = mount(makeGateway(LIST));
    await page.activate();
    await page.refreshAvailability();
    const tabButtons = Array.from(tabs.querySelectorAll("[data-mcp-tab]"));
    expect(tabButtons.map((b) => b.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(masterEl.textContent).toContain("grep"); // sharedGlobal default tab
    expect(navItem.classList.contains("hidden")).toBe(false);

    clickTab(tabs, "piGlobal");
    expect(masterEl.textContent).toContain("context7");
    expect(tabs.querySelector('[data-mcp-tab="piGlobal"]').getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("keeps the nav hidden when the adapter is not installed", async () => {
    const { page, navItem } = mount(
      makeGateway({ ok: true, data: { installed: false, groups: {}, groupErrors: {} } }),
    );
    await page.refreshAvailability();
    expect(navItem.classList.contains("hidden")).toBe(true);
  });

  it("shared tab: read-only detail with source path, no add button", async () => {
    const { page, masterEl, detailEl } = mount(makeGateway(LIST));
    await page.activate();
    expect(masterEl.querySelector(".models-provider-add")).toBeNull();
    clickRow(masterEl, "grep");
    expect(detailEl.textContent).toContain("read-only");
    expect(detailEl.textContent).toContain("/home/u/.config/mcp/mcp.json");
    expect(detailEl.querySelector(".mcp-entry-raw").textContent).toContain("mcp.grep.app");
    expect(detailEl.querySelector(".mcp-form")).toBeNull();
  });

  it("pi-global tab: add button at the master bottom; editable form saves normalized entry", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl, tabs } = mount(gateway);
    await page.activate();
    clickTab(tabs, "piGlobal");
    const add = masterEl.querySelector(".models-provider-add");
    expect(add).not.toBeNull();
    expect(add.textContent).toBe("+ Add MCP");
    expect(masterEl.lastElementChild).toBe(add); // bottom of the list
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
    expect(payload.entry.env).toEqual({ K: "${V}" });
  });

  it("array command: joined display, unmodified save passes the original array through", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl, tabs } = mount(gateway);
    await page.activate();
    clickTab(tabs, "piGlobal");
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
    expect(payload.entry.lifecycle).toBe("lazy"); // unknown keys preserved
  });

  it("project tab: .mcp.json entry read-only, .pi/mcp.json entry editable", async () => {
    const { page, masterEl, detailEl, tabs } = mount(makeGateway(LIST));
    await page.activate();
    clickTab(tabs, "project");
    clickRow(masterEl, "repoTool");
    expect(detailEl.textContent).toContain("read-only");
    expect(detailEl.textContent).toContain(".mcp.json");
    clickRow(masterEl, "local");
    expect(detailEl.querySelector(".mcp-form")).not.toBeNull();
    expect(detailEl.textContent).toContain(".pi/mcp.json");
  });

  it("detail: exactly one switch at the top; clicking sends the toggle payload", async () => {
    const gateway = makeGateway(LIST);
    const { page, masterEl, detailEl } = mount(gateway);
    await page.activate();
    clickRow(masterEl, "grep");
    expect(detailEl.querySelectorAll('[role="switch"]').length).toBe(1); // no duplicate
    const toggle = detailEl.querySelector('.mcp-entry [role="switch"]');
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // enabled
    expect(
      detailEl.querySelector(".mcp-entry").firstElementChild.classList.contains("mcp-toggle-row"),
    ).toBe(true);
    toggle.click();
    await vi.waitFor(() =>
      expect(gateway.call).toHaveBeenCalledWith("mcp_toggle_server", expect.anything()),
    );
    const payload = gateway.call.mock.calls.find((c) => c[0] === "mcp_toggle_server")[1];
    expect(payload).toEqual({ name: "grep", disable: true });
  });

  it("save and delete share one action row in the edit form", async () => {
    const { page, masterEl, detailEl, tabs } = mount(makeGateway(LIST));
    await page.activate();
    clickTab(tabs, "piGlobal");
    clickRow(masterEl, "context7");
    const actions = detailEl.querySelector(".mcp-form-actions");
    expect(actions).not.toBeNull();
    expect(actions.textContent).toContain("Save");
    expect(actions.textContent).toContain("Delete");

    const add2 = mount(makeGateway(LIST));
    await add2.page.activate();
    clickTab(add2.tabs, "piGlobal");
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
