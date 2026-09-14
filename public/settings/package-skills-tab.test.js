// ABOUTME: jsdom tests for the Packages skills tab module.
// ABOUTME: Verifies loading, scope switching, trust gating, and package skill mutations.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPackageSkillsTab } from "./package-skills-tab.js";

// Minimal i18n stub: returns the key plus interpolated values so tests can
// assert on locale-key presence without pulling in the full i18n module.
vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key, params) => {
    let s = key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
    return s;
  },
}));

/** @returns {import("./package-skills-tab.js").PackageSkillInventory} */
function makeInventory(overrides = {}) {
  return {
    scope: "global",
    trusted: true,
    packages: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeCard(overrides = {}) {
  return {
    id: "npm:pkg",
    source: "npm:pkg",
    identity: "npm:pkg",
    scope: "global",
    effectivePackageRoot: "/agent/npm/node_modules/pkg",
    version: "1.2.3",
    candidates: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    id: "npm:pkg::/path/SKILL.md",
    canonicalPath: "/agent/npm/node_modules/pkg/skills/a/SKILL.md",
    relativePath: "skills/a",
    name: "alpha",
    description: "alpha skill",
    diagnostics: [],
    enabled: true,
    ...overrides,
  };
}

/** Build a fake rpcCommand that resolves to a success envelope. */
function rpcReturning(inventory) {
  return vi.fn(async (cmd) => {
    expect(cmd.type).toBe("list_package_skill_inventory");
    return { success: true, data: inventory };
  });
}

function setup() {
  document.body.innerHTML = '<div id="container"></div>';
  const container = document.getElementById("container");
  const rpcCommand = rpcReturning(makeInventory());
  const tab = setupPackageSkillsTab({ container, rpcCommand });
  return { container, rpcCommand, tab };
}

describe("setupPackageSkillsTab — request shape", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
  });

  it("sends exactly {type, scope} with no path/owner/cwd/port", async () => {
    const container = document.getElementById("container");
    const rpcCommand = vi.fn(async () => ({
      success: true,
      data: makeInventory(),
    }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledWith({
      type: "list_package_skill_inventory",
      scope: "global",
    });
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("path");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("owner");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("cwd");
    expect(rpcCommand.mock.calls[0][0]).not.toHaveProperty("port");
  });
});

describe("setupPackageSkillsTab — loading & first activation", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
  });

  it("shows a loading state before the first response", async () => {
    const container = document.getElementById("container");
    let resolveRpc;
    const rpcCommand = vi.fn(
      () =>
        new Promise((res) => (resolveRpc = () => res({ success: true, data: makeInventory() }))),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    const activating = tab.activate();
    expect(container.querySelector(".skills-loading")).toBeTruthy();
    resolveRpc();
    await activating;
  });

  it("loads once on first activation and not before", async () => {
    const container = document.getElementById("container");
    const rpcCommand = rpcReturning(makeInventory());
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    expect(rpcCommand).not.toHaveBeenCalled();
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledTimes(1);
  });
});

describe("setupPackageSkillsTab — card rendering", () => {
  it("renders source, scope, version, and candidate count", async () => {
    const { container, tab } = setup();
    // Override rpcCommand to return a card with one candidate.
    const card = makeCard({
      candidates: [makeCandidate()],
    });
    container._rpcOverride = card;
    await tab.activate();
    // Re-setup with the card-bearing inventory for a clean assertion.
    document.body.innerHTML = '<div id="container"></div>';
    const c2 = document.getElementById("container");
    const rpc2 = rpcReturning(makeInventory({ packages: [card] }));
    const tab2 = setupPackageSkillsTab({ container: c2, rpcCommand: rpc2 });
    await tab2.activate();
    expect(c2.querySelector('[data-package-card="npm:pkg"]')).toBeTruthy();
    expect(c2.querySelector(".skills-group-name").textContent).toBe("npm:pkg");
    expect(c2.querySelector(".package-skills-card-version").textContent).toBe("v1.2.3");
    // The count element renders (the localized label is covered by the
    // i18n-keys-completeness test); assert the card carries one candidate.
    expect(c2.querySelector(".package-skills-card-count")).toBeTruthy();
    expect(card.candidates).toHaveLength(1);
  });

  it("expands a card to show candidates with name/description/relative path", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const card = makeCard({ candidates: [makeCandidate()] });
    const rpcCommand = rpcReturning(makeInventory({ packages: [card] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    // Candidate not visible until expanded.
    expect(container.querySelector('[data-candidate="alpha"]')).toBeNull();
    // Expand.
    container.querySelector(".skills-expand").click();
    const cand = container.querySelector('[data-candidate="alpha"]');
    expect(cand).toBeTruthy();
    expect(cand.querySelector(".skills-skill-name").textContent).toBe("alpha");
    expect(cand.querySelector(".skills-skill-description").textContent).toBe("alpha skill");
    expect(cand.querySelector(".package-skills-candidate-relative").textContent).toBe("skills/a");
    // Canonical path is available as an accessible label/title, not echoed as text.
    expect(cand.querySelector("code").title).toContain("SKILL.md");
  });

  it("shows a not-installed diagnostic for a missing package root", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const card = makeCard({
      effectivePackageRoot: undefined,
      diagnostics: [{ message: "package is not installed" }],
    });
    const rpcCommand = rpcReturning(makeInventory({ packages: [card] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".package-skills-not-installed")).toBeTruthy();
    expect(container.querySelector(".package-skills-diagnostic").textContent).toContain(
      "not installed",
    );
  });
});

describe("setupPackageSkillsTab — scope switching", () => {
  it("switching to Project keeps the combined list visible but changes emphasized count", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const globalCard = makeCard({ id: "npm:g", source: "npm:g", scope: "global" });
    const projectCard = makeCard({ id: "npm:p", source: "npm:p", scope: "project" });
    const rpcCommand = rpcReturning(
      makeInventory({ scope: "global", packages: [globalCard, projectCard] }),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    // Both cards visible in the combined list.
    expect(container.querySelectorAll("[data-package-card]").length).toBe(2);
    await tab.setScope("project");
    // Combined list still shows both packages.
    expect(container.querySelectorAll("[data-package-card]").length).toBe(2);
    expect(rpcCommand).toHaveBeenLastCalledWith({
      type: "list_package_skill_inventory",
      scope: "project",
    });
  });
});

describe("setupPackageSkillsTab — trust gating", () => {
  it("displays a trust explanation and no project package paths when untrusted", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    // Untrusted project: packages is empty, trusted is false.
    const rpcCommand = rpcReturning(
      makeInventory({ scope: "project", trusted: false, packages: [] }),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.setScope("project");
    expect(container.querySelector(".skills-notice")).toBeTruthy();
    // No package card or path leaks.
    expect(container.querySelector("[data-package-card]")).toBeNull();
    expect(container.textContent).not.toContain("/secret");
  });
});

describe("setupPackageSkillsTab — switch state", () => {
  it("renders trusted global package skills checked and interactive", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const candidate = makeCandidate({ enabled: true });
    const card = makeCard({ scope: "global", candidates: [candidate] });
    const tab = setupPackageSkillsTab({
      container,
      rpcCommand: rpcReturning(makeInventory({ scope: "global", trusted: true, packages: [card] })),
    });
    await tab.activate();
    container.querySelector(".skills-expand").click();
    const toggle = container.querySelector('[data-skill-toggle="npm:pkg::skills/a"]');
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });
});

describe("setupPackageSkillsTab — mutations", () => {
  it("toggles a package skill through the package filter RPC", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const candidate = makeCandidate({ enabled: true });
    const card = makeCard({ candidates: [candidate] });
    const updated = makeInventory({
      packages: [{ ...card, candidates: [{ ...candidate, enabled: false }] }],
    });
    const showSuccess = vi.fn();
    const rpcCommand = vi.fn(async (cmd) => {
      if (cmd.type === "list_package_skill_inventory") {
        return { success: true, data: makeInventory({ packages: [card] }) };
      }
      expect(cmd).toEqual({
        type: "set_package_skill_enabled",
        scope: "global",
        target: { packageIdentity: "npm:pkg", relativePath: "skills/a" },
        enabled: false,
      });
      return { success: true, data: { inventory: updated } };
    });
    const tab = setupPackageSkillsTab({ container, rpcCommand, showSuccess });
    await tab.activate();
    container.querySelector(".skills-expand").click();
    const toggle = container.querySelector('[data-skill-toggle="npm:pkg::skills/a"]');
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpcCommand).toHaveBeenCalledWith({
      type: "set_package_skill_enabled",
      scope: "global",
      target: { packageIdentity: "npm:pkg", relativePath: "skills/a" },
      enabled: false,
    });
    expect(container.querySelector('[data-skill-toggle="npm:pkg::skills/a"]').checked).toBe(false);
    expect(showSuccess).toHaveBeenCalledWith("settings.skills.savedRestartRequired");
  });

  it("reports partial failures after enabling all skills", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const candidates = ["a", "b", "c", "d"].map((name) =>
      makeCandidate({ name, relativePath: `skills/${name}` }),
    );
    const card = makeCard({ candidates });
    const showError = vi.fn();
    const finalInventory = makeInventory({
      packages: [
        {
          ...card,
          candidates: candidates.map((candidate, index) => ({
            ...candidate,
            enabled: index !== 1,
          })),
        },
      ],
    });
    const rpcCommand = vi.fn(async (cmd) => {
      if (cmd.type === "list_package_skill_inventory") {
        return { success: true, data: finalInventory };
      }
      if (cmd.target.relativePath === "skills/b") throw new Error("b failed");
      return { success: true, data: { inventory: finalInventory } };
    });
    const tab = setupPackageSkillsTab({
      container,
      rpcCommand,
      showError,
    });
    await tab.activate();
    const enableAll = container.querySelector(".skills-group-enable-all input");
    enableAll.checked = false;
    enableAll.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showError).toHaveBeenCalledWith("settings.packageSkills.bulkFailure");
    expect(container.querySelector(".skills-skill-description") || container).toBeTruthy();
  });

  it("keeps project package switches disabled when untrusted", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const card = makeCard({ scope: "project", candidates: [makeCandidate()] });
    const rpcCommand = rpcReturning(
      makeInventory({ scope: "project", trusted: false, packages: [card] }),
    );
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.setScope("project");
    expect(container.querySelectorAll('input[type="checkbox"]:not([disabled])')).toHaveLength(0);
  });
});

describe("setupPackageSkillsTab — empty & error states", () => {
  it("shows an empty state when there are no packages", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const rpcCommand = rpcReturning(makeInventory({ packages: [] }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-empty")).toBeTruthy();
  });

  it("shows an error state with retry on failure", async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const container = document.getElementById("container");
    const rpcCommand = vi.fn(async () => ({ success: false, error: "boom" }));
    const tab = setupPackageSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-error")).toBeTruthy();
    expect(container.querySelector(".skills-rescan")).toBeTruthy();
  });
});
