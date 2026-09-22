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
    // The Discovered tab no longer offers any "add root" button; adding
    // directories is handled by the Install tab.
    expect(container.querySelector(".skills-add-root")).toBeNull();
    expect(container.querySelector(".skills-add-root-confirmation")).toBeNull();
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

  it("renders the group toggle as one labelled control, not a badge plus a switch", async () => {
    const rpcCommand = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("all-on", ["enabled", "enabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();

    const control = container.querySelector(
      "button.skills-group-status[data-skill-group-state='all-on']",
    );
    expect(control).not.toBeNull();
    expect(control.closest(".skills-group-enable-all")).not.toBeNull();
    expect(control.textContent).toBe("settings.skills.allEnabled");
    expect(control.getAttribute("aria-pressed")).toBe("true");
    // The old shape (status badge + separate switch) must be gone from the
    // group header.
    const header = control.closest(".skills-group-header");
    expect(header.querySelectorAll(".skills-group-status").length).toBe(1);
    expect(header.querySelector(".skills-switch")).toBeNull();
  });

  it("toggles the whole group from that one control", async () => {
    const mixed = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("mixed", ["enabled", "disabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand: mixed });
    await tab.activate();
    const control = container.querySelector(
      "button.skills-group-status[data-skill-group-state='mixed']",
    );
    expect(control.textContent).toBe("settings.skills.enabledCount");
    control.click();
    await vi.waitFor(() =>
      expect(mixed).toHaveBeenCalledWith({
        type: "set_skill_enabled",
        scope: "global",
        target: { kind: "group", id: "group-a" },
        enabled: true,
      }),
    );
  });

  it("turns a fully enabled group off", async () => {
    const allOn = vi
      .fn()
      .mockResolvedValue({ success: true, data: groupInventory("all-on", ["enabled", "enabled"]) });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand: allOn });
    await tab.activate();
    container.querySelector("button.skills-group-status[data-skill-group-state='all-on']").click();
    await vi.waitFor(() =>
      expect(allOn).toHaveBeenCalledWith(
        expect.objectContaining({ type: "set_skill_enabled", enabled: false }),
      ),
    );
  });
});
