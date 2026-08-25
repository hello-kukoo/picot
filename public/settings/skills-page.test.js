// @vitest-environment jsdom

// ABOUTME: Locks the Settings > Skills renderer to the tree DOM contract.
// ABOUTME: Covers roots (sourceRoot shown), nested group cards, skill rows, switches, pending, shadowed, trust, locale.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localeListeners = new Set();
vi.mock("../i18n.js", () => ({
  t: (key, params) => {
    if (params) {
      if (key.endsWith("enabledCount")) return `${params.enabled}/${params.total}`;
      if (key.endsWith("shadowedBy")) return `shadowed by ${params.name}`;
    }
    return key;
  },
  onLocaleChange: (fn) => {
    localeListeners.add(fn);
    return () => {
      localeListeners.delete(fn);
    };
  },
}));

const { setupSkillsPage } = await import("./skills-page.js");

const BAOYU_GROUP_ID = "/root/a/skills::baoyu";

function skill(id, name, status, extra = {}) {
  return {
    kind: "skill",
    id,
    name,
    description: `${name} skill`,
    enabled: status === "enabled",
    status,
    ruleRelativeDir: `skills/baoyu/${name}`,
    ruleBaseDir: "/root/a",
    sourceRoot: "/root/a/skills",
    scope: "user",
    source: "auto",
    ambiguous: false,
    shadowedBy: undefined,
    ...extra,
  };
}

function makeInventory(overrides = {}) {
  return {
    scope: "global",
    settingsPath: "/home/.pi/agent/settings.json",
    trusted: true,
    roots: [
      {
        sourceRoot: "/root/a/skills",
        ruleBaseDir: "/root/a",
        scope: "user",
        source: "auto",
        children: [
          {
            kind: "group",
            id: BAOYU_GROUP_ID,
            sourceRoot: "/root/a/skills",
            ruleBaseDir: "/root/a",
            ruleBaseRelativePath: "skills/baoyu",
            name: "baoyu",
            scope: "user",
            source: "auto",
            state: "mixed",
            ambiguous: false,
            children: [
              skill("/a/baoyu/diagram/SKILL.md", "diagram", "enabled"),
              skill("/a/baoyu/infographic/SKILL.md", "infographic", "disabled"),
              skill("/a/baoyu/article/SKILL.md", "article", "disabled"),
            ],
          },
        ],
      },
    ],
    customRules: [],
    discoveredRoots: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeInventoryWithTopSkill() {
  const inv = makeInventory();
  inv.roots[0].children.unshift(
    skill("/a/topskill/SKILL.md", "topskill", "enabled", {
      ruleRelativeDir: "skills/topskill",
    }),
  );
  return inv;
}

function makeInventoryWithTwoTopSkills() {
  const inv = makeInventory();
  inv.roots[0].children.unshift(
    skill("/a/alpha/SKILL.md", "alpha", "enabled", { ruleRelativeDir: "skills/alpha" }),
    skill("/a/topskill/SKILL.md", "topskill", "enabled", { ruleRelativeDir: "skills/topskill" }),
  );
  return inv;
}

function makeProjectInventory() {
  const rel = skill("/c/release/notes/SKILL.md", "release-notes", "enabled", {
    ruleRelativeDir: "skills/release/release-notes",
    ruleBaseDir: "/cwd/.pi",
    sourceRoot: "/cwd/.pi/skills",
    scope: "project",
  });
  return {
    scope: "project",
    settingsPath: "/cwd/.pi/settings.json",
    trusted: true,
    roots: [
      {
        sourceRoot: "/cwd/.pi/skills",
        ruleBaseDir: "/cwd/.pi",
        scope: "project",
        source: "auto",
        children: [
          {
            kind: "group",
            id: "/cwd/.pi/skills::release",
            sourceRoot: "/cwd/.pi/skills",
            ruleBaseDir: "/cwd/.pi",
            ruleBaseRelativePath: "skills/release",
            name: "release",
            scope: "project",
            source: "auto",
            state: "all-on",
            ambiguous: false,
            children: [rel],
          },
        ],
      },
    ],
    customRules: [],
    discoveredRoots: [],
    diagnostics: [],
  };
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushPromises = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

function mockRpc(inventory) {
  return async (cmd) => ({
    success: true,
    data: cmd.type === "list_skill_inventory" ? inventory : inventory,
  });
}

function mutationResponse(inventory) {
  return { success: true, data: { inventory, runtimeRestartRequired: true } };
}

let container;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  localeListeners.clear();
});
afterEach(() => {
  container.remove();
});

describe("skills-page tree renderer", () => {
  it("renders a root with its sourceRoot path, a group card, and skill rows", async () => {
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(makeInventory()) });
    await page.load("global");
    expect(container.querySelector('[data-skill-root="/root/a/skills"]')).not.toBeNull();
    expect(
      container.querySelector('[data-skill-root="/root/a/skills"] .skills-root-path').textContent,
    ).toBe("/root/a/skills");
    expect(container.querySelector(`[data-skill-group="${BAOYU_GROUP_ID}"]`)).not.toBeNull();
    expect(container.querySelector('[data-skill-group-state="mixed"]').textContent).toBe("1/3");
    const groupToggle = container.querySelector(
      `[data-skill-group="${BAOYU_GROUP_ID}"] .skills-switch`,
    );
    expect(groupToggle.indeterminate).toBe(true);
    expect(groupToggle.getAttribute("aria-checked")).toBe("mixed");
    // Groups start collapsed: skill rows are not rendered until the group is expanded.
    expect(container.querySelectorAll("[data-skill-row]").length).toBe(0);
    container.querySelector(`[data-skill-group="${BAOYU_GROUP_ID}"] .skills-expand`).click();
    expect(container.querySelectorAll("[data-skill-row]").length).toBe(3);
    expect(container.querySelectorAll(".skills-switch").length).toBe(4);
  });

  it("wraps top-level single-skills in one card titled with the root basename", async () => {
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(makeInventoryWithTopSkill()) });
    await page.load("global");
    const card = container.querySelector("[data-skill-card]");
    expect(card).not.toBeNull();
    expect(card.querySelector(".skills-group-name").textContent).toBe("skills");
    // The sourceRoot itself is not toggleable: the card header has no switch,
    // and the switch lives on the skill row inside the card.
    expect(card.querySelector(".skills-group-header .skills-switch")).toBeNull();
    expect(card.querySelector('[data-skill-toggle="topskill"]')).not.toBeNull();
  });

  it("aggregates multiple top-level single-skills into one card", async () => {
    const page = setupSkillsPage({
      container,
      rpcCommand: mockRpc(makeInventoryWithTwoTopSkills()),
    });
    await page.load("global");
    const cards = container.querySelectorAll("[data-skill-card]");
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.querySelector(".skills-group-name").textContent).toBe("skills");
    expect(card.querySelector(".skills-group-header .skills-switch")).toBeNull();
    expect(card.querySelectorAll("[data-skill-row]").length).toBe(2);
    expect(card.querySelector('[data-skill-toggle="alpha"]')).not.toBeNull();
    expect(card.querySelector('[data-skill-toggle="topskill"]')).not.toBeNull();
  });

  it("shows the group name and its directory path on a group card", async () => {
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(makeInventory()) });
    await page.load("global");
    const group = container.querySelector(`[data-skill-group="${BAOYU_GROUP_ID}"]`);
    expect(group.querySelector(".skills-group-name").textContent).toBe("baoyu");
    expect(group.querySelector(".skills-group-source").textContent).toBe("skills/baoyu");
  });

  it("disables only the target controls while pending, then rerenders server state", async () => {
    const inventory = makeInventory();
    const deferred = defer();
    const recorded = [];
    const rpcCommand = async (cmd) => {
      if (cmd.type === "list_skill_inventory") return { success: true, data: inventory };
      recorded.push(cmd);
      return deferred.promise;
    };
    const success = vi.fn();
    const page = setupSkillsPage({ container, rpcCommand, showSuccess: success });
    await page.load("global");
    container.querySelector(`[data-skill-group="${BAOYU_GROUP_ID}"] .skills-expand`).click();

    const toggle = container.querySelector('[data-skill-toggle="diagram"] .skills-switch');
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(container.querySelector('[data-skill-toggle="diagram"] .skills-switch').disabled).toBe(
      true,
    );

    const disabled = makeInventory();
    disabled.roots[0].children[0].children[0] = skill(
      "/a/baoyu/diagram/SKILL.md",
      "diagram",
      "disabled",
    );
    disabled.roots[0].children[0].state = "all-off";
    deferred.resolve(mutationResponse(disabled));
    await flushPromises();

    expect(recorded[0]).toMatchObject({
      type: "set_skill_enabled",
      scope: "global",
      target: { kind: "skill", id: "/a/baoyu/diagram/SKILL.md" },
      enabled: false,
    });
    expect(container.querySelector('[data-skill-toggle="diagram"] .skills-switch').checked).toBe(
      false,
    );
    expect(success).toHaveBeenCalled();
  });

  it("renders a shadowed row with a disabled switch and the winner note", async () => {
    const inventory = makeInventory();
    inventory.roots[0].children[0].children[2] = skill(
      "/a/baoyu/article/SKILL.md",
      "article",
      "shadowed",
      { enabled: true },
    );
    inventory.roots[0].children[0].children[2].shadowedBy = {
      id: "/x",
      canonicalPath: "/x",
      name: "winner",
    };
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(inventory) });
    await page.load("global");
    container.querySelector(`[data-skill-group="${BAOYU_GROUP_ID}"] .skills-expand`).click();
    const row = container.querySelector('[data-skill-row="article"]');
    expect(row.querySelector(".skills-switch").disabled).toBe(true);
    expect(row.querySelector(".skills-shadowed-note").textContent).toBe("shadowed by winner");
  });

  it("renders custom glob rules as read-only code entries", async () => {
    const inventory = makeInventory({ customRules: ["skills/external/*"] });
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(inventory) });
    await page.load("global");
    const codes = container.querySelectorAll(".skills-custom-rule");
    expect(Array.from(codes).map((c) => c.textContent)).toEqual(["skills/external/*"]);
  });

  it("shows a trust warning and disables switches for an untrusted project", async () => {
    const inventory = makeProjectInventory();
    inventory.trusted = false;
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(inventory) });
    await page.load("project");
    expect(container.querySelector(".skills-notice")).not.toBeNull();
    expect(container.querySelector(".skills-switch").disabled).toBe(true);
  });

  it("renders an error state when the server returns failure", async () => {
    const rpcCommand = async () => ({ success: false, error: "boom" });
    const page = setupSkillsPage({ container, rpcCommand });
    await page.load("global");
    expect(container.querySelector(".skills-error").textContent).toContain("boom");
  });

  it("rescans from an error state", async () => {
    const rpcCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: "offline" })
      .mockResolvedValueOnce({ success: true, data: makeInventory() });
    const page = setupSkillsPage({ container, rpcCommand });
    await page.load("global");
    expect(container.querySelector(".skills-error").textContent).toContain("offline");

    container.querySelector(".skills-rescan").click();
    await flushPromises();
    expect(rpcCommand).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-skill-root]")).not.toBeNull();
  });

  it("destroy clears the page and unsubscribes from locale updates", async () => {
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(makeInventory()) });
    await page.load("global");
    page.destroy();
    for (const listener of localeListeners) listener();
    expect(container.children).toHaveLength(0);
  });

  it("rerenders on locale change without losing the selected scope", async () => {
    const page = setupSkillsPage({ container, rpcCommand: mockRpc(makeInventory()) });
    await page.load("global");
    for (const fn of localeListeners) fn();
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(container.querySelector('[data-scope="global"]').classList.contains("active")).toBe(
      true,
    );
  });

  it("switches scope on tab click and requests the other inventory", async () => {
    let lastScope = null;
    const rpcCommand = async (cmd) => {
      lastScope = cmd.scope;
      return {
        success: true,
        data: cmd.scope === "global" ? makeInventory() : makeProjectInventory(),
      };
    };
    const page = setupSkillsPage({ container, rpcCommand });
    await page.load("global");
    container.querySelector('[data-scope="project"]').dispatchEvent(new Event("click"));
    await flushPromises();
    expect(lastScope).toBe("project");
    expect(container.querySelector('[data-scope="project"]').classList.contains("active")).toBe(
      true,
    );
  });
});
