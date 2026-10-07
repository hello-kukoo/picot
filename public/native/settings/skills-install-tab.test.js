// ABOUTME: Tests the embeddable inline local Skills install controller.
// ABOUTME: Verifies fixed-scope open, opaque payloads, selection, lifecycle, and stale guards.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key, params) => {
    let value = key;
    if (params)
      for (const [name, item] of Object.entries(params))
        value = value.replace(`{${name}}`, String(item));
    return value;
  },
}));

import { setupSkillsInstallTab } from "./skills-install-tab.js";
import { manageModalDialog } from "./skills-modal.js";

const scan = {
  sourceId: "opaque-source",
  scanRevision: "opaque-revision",
  tree: [
    {
      kind: "group",
      id: "group-1",
      name: "Group",
      children: [
        { kind: "skill", id: "skill-1", name: "One", description: "first" },
        { kind: "skill", id: "skill-2", name: "Two", description: "second" },
      ],
    },
  ],
  defaultSelection: [
    { kind: "skill", id: "skill-1" },
    { kind: "skill", id: "skill-2" },
  ],
};

const installResult = {
  addedEntries: ["../skills"],
  skippedEntries: [],
  runtimeRestartRequired: true,
};

function transport(overrides = {}) {
  return {
    pickSkillSource: vi.fn().mockResolvedValue({ sourceId: "opaque-source" }),
    scanSkillInstallSource: vi.fn().mockResolvedValue(scan),
    installSkillLinks: vi.fn().mockResolvedValue(installResult),
    ...overrides,
  };
}

/** Mounts the controller on a fresh container and records its callbacks. */
function mount({ client, ...options } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const transportClient = client ?? transport();
  const calls = { states: [], installed: [], closed: 0 };
  const controller = setupSkillsInstallTab({
    container,
    transport: transportClient,
    isProjectTrusted: () => true,
    onStateChange: (state) => calls.states.push(state),
    onInstalled: (event) => calls.installed.push(event),
    onClose: () => {
      calls.closed += 1;
    },
    ...options,
  });
  return { container, transport: transportClient, controller, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe("skills install controller", () => {
  it("stays dormant until opened with a valid scope", async () => {
    const { container, transport: client, controller } = mount();

    expect(controller.isOpen()).toBe(false);
    expect(container.childElementCount).toBe(0);
    expect(client.pickSkillSource).not.toHaveBeenCalled();

    // "user" is the inventory alias, never an install target.
    expect(controller.open("user")).toBe(false);
    expect(container.childElementCount).toBe(0);

    expect(controller.open("global")).toBe(true);
    expect(controller.isOpen()).toBe(true);
    // Opening goes straight to the native folder picker — no idle choose step.
    await vi.waitFor(() => expect(client.pickSkillSource).toHaveBeenCalled());

    // The scope is fixed for the session: a second open is refused.
    expect(controller.open("project")).toBe(false);
  });

  it("closes the area when the picker is cancelled", async () => {
    const client = transport({ pickSkillSource: vi.fn().mockResolvedValue(null) });
    const { container, controller } = mount({ client });
    controller.open("global");

    await vi.waitFor(() => expect(client.pickSkillSource).toHaveBeenCalled());
    await vi.waitFor(() => expect(controller.isOpen()).toBe(false));
    expect(client.scanSkillInstallSource).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });

  it("scans and submits only opaque install authority for the opened scope", async () => {
    const { container, transport: client, controller, calls } = mount();
    controller.open("global");

    await vi.waitFor(() =>
      expect(container.querySelectorAll("[data-install-node]")).toHaveLength(3),
    );
    expect(container.querySelectorAll("[data-scope]")).toHaveLength(0);

    container.querySelector(".skills-install-review").click();
    expect(client.installSkillLinks).not.toHaveBeenCalled();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(client.installSkillLinks).toHaveBeenCalled());
    expect(client.installSkillLinks).toHaveBeenCalledWith({
      sourceId: "opaque-source",
      scope: "global",
      scanRevision: "opaque-revision",
      selection: [
        { kind: "skill", id: "skill-1" },
        { kind: "skill", id: "skill-2" },
      ],
    });
    await vi.waitFor(() => expect(calls.installed).toHaveLength(1));
    expect(calls.installed[0]).toEqual({ scope: "global", result: installResult });
    expect(calls.states).toEqual(["scanning", "selecting", "confirming", "installing", "done"]);
  });

  it("keeps the project target fixed for the whole install", async () => {
    const { container, transport: client, controller, calls } = mount();
    expect(controller.open("project")).toBe(true);

    // The target is a read-only badge, never a second scope control.
    expect(container.querySelectorAll("[data-scope]")).toHaveLength(0);
    expect(container.querySelectorAll("button.skills-scope-tab")).toHaveLength(0);
    expect(container.querySelector(".skills-install-target").textContent).toBe(
      "settings.installSkills.project",
    );
    expect(controller.open("global")).toBe(false);

    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(client.installSkillLinks).toHaveBeenCalled());
    expect(client.installSkillLinks.mock.calls[0][0].scope).toBe("project");
    expect(calls.installed[0].scope).toBe("project");
  });

  it("refuses a project target without a workspace", async () => {
    const client = transport();
    const { container, controller, calls } = mount({ client, hasWorkspace: () => false });

    expect(controller.open("project")).toBe(true);
    expect(container.textContent).toContain("settings.installSkills.projectNeedsWorkspace");
    expect(calls.states.at(-1)).toBe("error");

    // A rescan attempt cannot sneak past the refusal.
    await settle();
    expect(client.pickSkillSource).not.toHaveBeenCalled();
  });

  it("refuses a project target in an untrusted workspace", () => {
    const { container, controller } = mount({ isProjectTrusted: () => false });

    controller.open("project");
    expect(container.textContent).toContain("settings.installSkills.projectUntrusted");
    expect(controller.isOpen()).toBe(true);
  });

  it("updates group selection, half-selection, and gating", async () => {
    const { container, controller } = mount();
    controller.open("global");
    await vi.waitFor(() =>
      expect(container.querySelector("[data-install-node='group-1']")).not.toBeNull(),
    );

    const skillOne = container.querySelector("[data-install-node='skill-1'] input");
    skillOne.checked = false;
    skillOne.dispatchEvent(new Event("change"));
    expect(container.querySelector("[data-install-node='group-1'] input").indeterminate).toBe(true);

    const groupInput = container.querySelector("[data-install-node='group-1'] input");
    groupInput.checked = false;
    groupInput.dispatchEvent(new Event("change"));
    expect(container.querySelector(".skills-install-review").disabled).toBe(true);
  });

  it("cancels confirmation without writing", async () => {
    const { container, transport: client, controller } = mount();
    controller.open("global");
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-cancel").click();
    expect(client.installSkillLinks).not.toHaveBeenCalled();
    expect(container.querySelector(".skills-install-review")).not.toBeNull();
  });

  it("renders a scan failure and allows another pick", async () => {
    const client = transport({
      scanSkillInstallSource: vi.fn().mockRejectedValue(new Error("scan exploded")),
    });
    const { container, controller } = mount({ client });
    controller.open("global");

    const choose = () => container.querySelector(".skills-install-choose");
    await vi.waitFor(() => expect(container.textContent).toContain("scan exploded"));
    expect(choose().disabled).toBe(false);
    choose().click();
    await vi.waitFor(() => expect(client.pickSkillSource).toHaveBeenCalledTimes(2));
  });

  it("renders an install failure without retrying or re-scanning by itself", async () => {
    const client = transport({
      installSkillLinks: vi.fn().mockRejectedValue(new Error("install exploded")),
    });
    const { container, controller, calls } = mount({ client });
    controller.open("global");
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(container.textContent).toContain("install exploded"));

    expect(calls.installed).toHaveLength(0);
    expect(client.installSkillLinks).toHaveBeenCalledTimes(1);
    expect(calls.states.at(-1)).toBe("error");

    // The frozen scan survives: the user may re-confirm or re-pick, but the
    // controller never retries on its own.
    expect(container.querySelector(".skills-install-review")).not.toBeNull();
    container.querySelector(".skills-install-review").click();
    expect(container.querySelector(".skills-install-confirm")).not.toBeNull();
    expect(client.installSkillLinks).toHaveBeenCalledTimes(1);
    expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1);
  });

  it("hides the re-pick affordance while scanning so scans cannot overlap", async () => {
    let resolveScan;
    const client = transport({
      scanSkillInstallSource: vi.fn(() => new Promise((r) => (resolveScan = r))),
    });
    const { container, controller } = mount({ client });
    controller.open("global");

    // Opening starts the pick immediately; while the scan is pending there is
    // no re-pick button to race with (the isBusy guard covers any other path).
    await vi.waitFor(() => expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".skills-install-choose")).toBeNull();
    expect(controller.isBusy()).toBe(true);
    resolveScan(scan);
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-choose")).not.toBeNull(),
    );
    expect(container.querySelector(".skills-install-choose").disabled).toBe(false);
  });

  it("refuses a repeat submit and offers no cancel while installing", async () => {
    let resolveInstall;
    const client = transport({
      installSkillLinks: vi.fn(() => new Promise((r) => (resolveInstall = r))),
    });
    const { container, controller, calls } = mount({ client });
    controller.open("global");
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(client.installSkillLinks).toHaveBeenCalledTimes(1));

    expect(controller.isBusy()).toBe(true);
    expect(container.querySelector(".skills-install-confirm")).toBeNull();
    expect(container.querySelector(".skills-install-cancel")).toBeNull();
    expect(container.querySelector(".skills-install-review").disabled).toBe(true);
    expect(container.querySelector(".skills-install-close").disabled).toBe(true);

    // Neither the (disabled) close button nor a repeat submit does anything.
    container.querySelector(".skills-install-close").click();
    container.querySelector(".skills-install-review").click();
    expect(client.installSkillLinks).toHaveBeenCalledTimes(1);
    expect(controller.isOpen()).toBe(true);
    expect(calls.closed).toBe(0);

    resolveInstall(installResult);
    await vi.waitFor(() => expect(calls.installed).toHaveLength(1));
    expect(controller.isBusy()).toBe(false);

    container.querySelector(".skills-install-done").click();
    expect(controller.isOpen()).toBe(false);
    expect(calls.closed).toBe(1);
  });

  it("tracks busy state across the whole lifecycle", async () => {
    const { container, controller } = mount();
    expect(controller.isBusy()).toBe(false);
    controller.open("global");
    expect(controller.isBusy()).toBe(true); // scanning — open goes straight to the picker
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    expect(controller.isBusy()).toBe(false); // selecting
    container.querySelector(".skills-install-review").click();
    expect(controller.isBusy()).toBe(true); // confirming
    container.querySelector(".skills-install-cancel").click();
    expect(controller.isBusy()).toBe(false);
  });

  it("closes to idle, discards a late scan response, and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    let resolveScan;
    const client = transport({
      scanSkillInstallSource: vi.fn(() => new Promise((r) => (resolveScan = r))),
    });
    const { container, controller, calls } = mount({ client });
    controller.open("global", { trigger });

    await vi.waitFor(() => expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1));
    container.querySelector(".skills-install-close").click();

    expect(controller.isOpen()).toBe(false);
    expect(controller.isBusy()).toBe(false);
    expect(calls.closed).toBe(1);
    expect(calls.states.at(-1)).toBe("idle");
    expect(container.childElementCount).toBe(0);
    expect(document.activeElement).toBe(trigger);

    // The host scan keeps running; its late response must be dropped silently.
    resolveScan(scan);
    await settle();
    expect(container.childElementCount).toBe(0);
    expect(container.querySelector(".skills-install-tree")).toBeNull();
    expect(calls.states.at(-1)).toBe("idle");

    // Reopening starts a clean session that needs a fresh scan.
    controller.open("global", { trigger });
    expect(container.querySelector(".skills-install-tree")).toBeNull();
    await vi.waitFor(() => expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(2));
  });

  it("closes while confirming and restores focus to the trigger", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const { container, controller } = mount();
    controller.open("global", { trigger });
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    expect(document.activeElement).toBe(container.querySelector(".skills-install-confirm"));

    container.querySelector(".skills-install-close").click();
    expect(container.querySelector(".skills-install-confirmation")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("releases only its own modal dialog", async () => {
    const otherHost = document.createElement("section");
    const otherDialog = document.createElement("div");
    const otherButton = document.createElement("button");
    otherDialog.appendChild(otherButton);
    otherHost.appendChild(otherDialog);
    document.body.appendChild(otherHost);
    manageModalDialog(otherDialog, {
      owner: "package-skills",
      initialFocus: otherButton,
      inertRoot: document.body,
    });

    const { controller } = mount();
    controller.open("global");
    controller.close();
    controller.destroy();

    // The other owner's dialog keeps its trap, its focus, and no focus theft.
    expect(document.activeElement).toBe(otherButton);
    expect(otherDialog.closest("[inert]")).toBeNull();
    manageModalDialog(null, { owner: "package-skills" });
  });

  it("destroys its container, dialog, in-flight responses, and locale hook", async () => {
    let resolveScan;
    const client = transport({
      scanSkillInstallSource: vi.fn(() => new Promise((r) => (resolveScan = r))),
    });
    const { container, controller, calls } = mount({ client });
    controller.open("global");
    await vi.waitFor(() => expect(client.scanSkillInstallSource).toHaveBeenCalledTimes(1));

    controller.destroy();
    expect(container.childElementCount).toBe(0);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(controller.isOpen()).toBe(false);

    // Late responses and any further calls are inert after destroy.
    resolveScan(scan);
    await settle();
    expect(container.childElementCount).toBe(0);
    // No state is emitted after destroy: the record still ends at "scanning".
    expect(calls.states).toEqual(["scanning"]);
    expect(controller.open("global")).toBe(false);
    expect(container.childElementCount).toBe(0);
    controller.close();
    expect(calls.closed).toBe(0);
    controller.destroy(); // idempotent
    expect(container.childElementCount).toBe(0);
  });

  it("releases its confirming dialog on destroy", async () => {
    const { container, controller } = mount();
    controller.open("global");
    await vi.waitFor(() =>
      expect(container.querySelector(".skills-install-review")).not.toBeNull(),
    );
    container.querySelector(".skills-install-review").click();
    expect(document.querySelectorAll("[inert]").length).toBeGreaterThan(0);

    controller.destroy();
    expect(container.querySelector(".skills-install-confirmation")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(container.childElementCount).toBe(0);
  });
});

describe("skills install controller — workspaceless (landing)", () => {
  it("keeps the global scope usable and never names a project scope", async () => {
    const client = transport();
    const { container, controller } = mount({ client, hasWorkspace: () => false });
    expect(controller.open("global")).toBe(true);

    await vi.waitFor(() =>
      expect(container.querySelector("[data-install-node='group-1']")).not.toBeNull(),
    );

    // The global install still submits, and it never names a project scope.
    container.querySelector(".skills-install-review").click();
    container.querySelector(".skills-install-confirm").click();
    await vi.waitFor(() => expect(client.installSkillLinks).toHaveBeenCalled());
    expect(client.installSkillLinks.mock.calls[0][0].scope).toBe("global");
  });
});
