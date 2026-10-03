// ABOUTME: Verifies the focused Discovered Skills tab keeps inventory ownership behavior.
// ABOUTME: Covers activation and trust state exposure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key) => key,
}));

import { setupDiscoveredSkillsTab } from "./skills-discovered-tab.js";

function inventory(overrides = {}) {
  return {
    trusted: true,
    roots: [
      {
        sourceRoot: "/home/.pi/agent/skills",
        scope: "user",
        rootKind: "pi",
        children: [
          { kind: "skill", id: "skill", name: "review", description: "review", status: "enabled" },
        ],
      },
    ],
    customRules: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("Discovered Skills tab", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
  });

  it("loads inventory and exposes trust state", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledWith({ type: "list_skill_inventory", scope: "global" });
    expect(tab.isProjectTrusted()).toBe(true);
  });

  it("renders roots without a Claude-specific add-root affordance", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    // The Custom tab no longer offers any "add root" button; adding
    // directories is handled by the inline install entry.
    expect(container.querySelector(".skills-add-root")).toBeNull();
    expect(container.querySelector(".skills-add-root-confirmation")).toBeNull();
  });

  it("offers a per-scope install entry that reports scope and trigger", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const onInstallRequest = vi.fn();
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand, onInstallRequest });
    await tab.activate();
    const button = container.querySelector(".skills-install-entry");
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("settings.skills.install");
    expect(button.getAttribute("aria-label")).toBe(
      "settings.skills.install — settings.skills.global",
    );
    button.click();
    expect(onInstallRequest).toHaveBeenCalledTimes(1);
    expect(onInstallRequest).toHaveBeenCalledWith("global", button);
  });

  it("reports project scope from the install entry on the project tab", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const onInstallRequest = vi.fn();
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand, onInstallRequest });
    await tab.activate();
    await tab.load("project");
    const button = container.querySelector(".skills-install-entry");
    button.click();
    expect(onInstallRequest).toHaveBeenCalledWith("project", button);
  });

  it("disables the project install entry when the project is untrusted", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({
      success: true,
      data: inventory({ trusted: false }),
    });
    const onInstallRequest = vi.fn();
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand, onInstallRequest });
    await tab.activate();
    await tab.load("project");
    const button = container.querySelector(".skills-install-entry");
    expect(button.disabled).toBe(true);
    button.click();
    expect(onInstallRequest).not.toHaveBeenCalled();
  });

  it("keeps the global install entry available when the project is untrusted", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({
      success: true,
      data: inventory({ trusted: false }),
    });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-install-entry").disabled).toBe(false);
  });

  it("freezes scope tabs, rescan and toggles while the install area is open", async () => {
    const groupInventory = inventory({
      roots: [
        {
          sourceRoot: "/home/.pi/agent/skills",
          scope: "user",
          rootKind: "pi",
          children: [
            {
              kind: "group",
              id: "group-a",
              name: "group-a",
              ruleBaseRelativePath: "group-a",
              state: "all-on",
              children: [
                {
                  kind: "skill",
                  id: "skill-0",
                  name: "alpha",
                  description: "alpha",
                  status: "enabled",
                },
              ],
            },
          ],
        },
      ],
    });
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: groupInventory });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    container.querySelector(".skills-expand").click();
    tab.setInstallLocked(true);
    const scopeTab = container.querySelector(".skills-scope-tab");
    const rescan = container.querySelector(".skills-header .skills-rescan");
    const groupControl = container.querySelector(".skills-group-header input.skills-switch");
    const rowSwitch = container.querySelector(".skills-skill-row .skills-switch");
    expect(scopeTab.disabled).toBe(true);
    expect(rescan.disabled).toBe(true);
    expect(groupControl.disabled).toBe(true);
    expect(rowSwitch.disabled).toBe(true);
    tab.setInstallLocked(false);
    expect(container.querySelector(".skills-scope-tab").disabled).toBe(false);
    expect(container.querySelector(".skills-group-header input.skills-switch").disabled).toBe(
      false,
    );
  });

  it("disables the install entry while a scope switch is in flight", async () => {
    let resolveSecond;
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: inventory() })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    const switching = tab.load("project");
    expect(container.querySelector(".skills-install-entry").disabled).toBe(true);
    resolveSecond?.({ success: true, data: inventory() });
    await switching;
    expect(container.querySelector(".skills-install-entry").disabled).toBe(false);
  });
});

describe("Discovered Skills group status control", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
  });

  function groupInventory(state, statuses) {
    return {
      trusted: true,
      roots: [
        {
          sourceRoot: "/home/.pi/agent/skills",
          scope: "user",
          rootKind: "pi",
          children: [
            {
              kind: "group",
              id: "group-a",
              name: "group-a",
              ruleBaseRelativePath: "group-a",
              state,
              children: statuses.map((status, index) => ({
                kind: "skill",
                id: `skill-${index}`,
                name: `skill-${index}`,
                description: "d",
                status,
              })),
            },
          ],
        },
      ],
      customRules: [],
      diagnostics: [],
    };
  }

  it("renders the group header as a status badge plus a separate switch", async () => {
    const rpcCommand = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("all-on", ["enabled", "enabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();

    const header = container.querySelector(".skills-group-header");
    const badge = header.querySelector("span.skills-group-status[data-skill-group-state='all-on']");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("settings.skills.allEnabled");
    const groupSwitch = header.querySelector("input.skills-switch");
    expect(groupSwitch).not.toBeNull();
    expect(groupSwitch.checked).toBe(true);
    expect(groupSwitch.indeterminate).toBe(false);
  });

  it("shows the switch in the middle for a mixed group", async () => {
    const rpcCommand = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("mixed", ["enabled", "disabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    const groupSwitch = container.querySelector(".skills-group-header input.skills-switch");
    expect(groupSwitch.checked).toBe(false);
    expect(groupSwitch.indeterminate).toBe(true);
    expect(
      container.querySelector("span.skills-group-status[data-skill-group-state='mixed']")
        .textContent,
    ).toBe("settings.skills.enabledCount");
  });

  it("toggles the whole group on from the switch while mixed", async () => {
    const mixed = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("mixed", ["enabled", "disabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand: mixed });
    await tab.activate();
    const groupSwitch = container.querySelector(".skills-group-header input.skills-switch");
    groupSwitch.checked = true;
    groupSwitch.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(mixed).toHaveBeenCalledWith({
        type: "set_skill_enabled",
        scope: "global",
        target: { kind: "group", id: "group-a" },
        enabled: true,
      }),
    );
  });

  it("turns a fully enabled group off from the switch", async () => {
    const allOn = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("all-on", ["enabled", "enabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand: allOn });
    await tab.activate();
    const groupSwitch = container.querySelector(".skills-group-header input.skills-switch");
    groupSwitch.checked = false;
    groupSwitch.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(allOn).toHaveBeenCalledWith(
        expect.objectContaining({ type: "set_skill_enabled", enabled: false }),
      ),
    );
  });
});
