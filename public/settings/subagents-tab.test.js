// @vitest-environment jsdom

// ABOUTME: Locks the Settings > Subagents tab to the host wire contract.
// ABOUTME: Covers scoped master/detail, metadata-only lists, byte-exact raw, state handling, safety.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages, t } from "../i18n.js";

const LOCALES = ["en", "zh", "ja", "es"];
const REQUIRED_COPY = [
  "title",
  "scopes.global",
  "scopes.project",
  "state.conflict",
  "state.error",
  "create.disabled",
  "detail.reloadNotice",
];

describe("subagents locales", () => {
  it("provides actionable scope and error copy in all supported languages", () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(`public/locales/${locale}.json`, "utf8")).settings
        .subagents;
      for (const key of REQUIRED_COPY) {
        const value = key.split(".").reduce((node, part) => node?.[part], messages);
        expect(value, `${locale}: ${key}`).toBeTruthy();
      }
    }
  });
});

import { WsTransport } from "../app/transport.js";
import { setupSubagentsTab } from "./subagents-tab.js";

setMessages({
  settings: {
    subagents: {
      title: "Subagents",
      scopes: { global: "Global", project: "Current project" },
      groups: {
        user: "Your definitions",
        package: "Packages",
        project: "Project definitions",
        builtin: "Built-in (read-only)",
      },
      status: { candidate: "Disk candidate — runtime winner unverified" },
      diskOnlyMode: "Disk candidates only: effectiveness and collisions are unverified.",
      state: {
        loading: "Loading…",
        empty: "No agent definitions in this scope.",
        error: "Failed to load subagents.",
        conflict: "The workspace or inventory changed. Refresh and retry.",
      },
      retry: "Retry",
      detail: {
        runtimeName: "Runtime name",
        source: "Source",
        path: "File",
        noFile: "No definition file (built-in)",
        scope: "Scope",
        savedOverride: "Saved override",
        model: "Model",
        thinking: "Thinking",
        none: "None",
        inferred: "Inferred",
        overrides: "Overrides",
        save: "Save",
        saved:
          "Saved to disk. Reload or start a new session; verify with /subagents-models or /run.",
        invalidModel: "Use a provider/model ID.",
        reloadNotice: "Overrides take effect in new sessions (or after /reload).",
        rawLoading: "Loading definition…",
        rawUnavailable: "Definition unavailable.",
      },
      alsoIn: "Also available in: {scopes}",
      create: {
        title: "New agent .md",
        name: "Name",
        description: "Description",
        prompt: "Prompt",
        submit: "Create",
        disabled: "Creation unavailable: runtime identity unverified.",
        invalid: "Enter a name, description, and nonempty prompt.",
      },
    },
  },
});

const HOSTILE_RAW =
  '---\nname: evil\ndescription: <img src=x onerror="window.__pwned=1">\n---\n<script>window.__pwned=2</script>\n';

function candidate(overrides = {}) {
  return {
    id: "c-user-1",
    runtimeName: "coder",
    localName: "coder",
    source: "user",
    sourceScope: "global",
    packageIdentity: null,
    filePath: "/home/u/.pi/agent/agents/coder.md",
    parsedFields: { name: "coder", description: "writes code", runner: "native" },
    status: "candidate",
    winnerId: null,
    readOnly: true,
    nativeOverrideSupported: true,
    writeQualified: false,
    writeDiagnostic: { source: "parity", message: "winner or out-of-scope occupancy unverified" },
    savedOverride: { model: null, thinking: null },
    inferredValue: null,
    settingsRevision: "rev-1",
    ...overrides,
  };
}

function inventory(entries, overrides = {}) {
  return {
    agentRoot: "/home/u/.pi/agent",
    workspaceRoot: null,
    projectRoot: null,
    resolutionContext: {
      mode: "disk-candidates-only",
      reason: "live /run winner not observable",
      projectWritesAllowed: false,
    },
    entries,
    diagnostics: [
      {
        source: ".agents/",
        message: "out-of-scope occupancy not verified; no definition body read",
      },
    ],
    inventoryRevision: "inv-1",
    settingsRevisions: { global: "rev-1", project: "project-rev" },
    ...overrides,
  };
}

function hostError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTransport() {
  return {
    listSubagents: vi.fn(),
    getSubagentDetail: vi.fn(),
    createSubagent: vi.fn(),
    setSubagentOverride: vi.fn(),
  };
}

let container;

function setup(
  transport,
  {
    identity = { workspaceId: "w1", workspaceGeneration: 3 },
    landingOnly = false,
    confirmDiscard,
  } = {},
) {
  let current = identity;
  const page = setupSubagentsTab({
    container,
    transport,
    t,
    getWorkspaceIdentity: () => current,
    landingOnly,
    confirmDiscard,
  });
  return { page, setIdentity: (next) => (current = next) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tabLabels = () =>
  [...container.querySelectorAll("[data-subagents-scope]")].map((b) => b.dataset.subagentsScope);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe("subagents transport", () => {
  it("sends fixed host operations without workspace identity on global requests", async () => {
    const sendControl = vi.fn().mockResolvedValue({ entries: [] });
    const transport = new WsTransport({ sendControl });
    await transport.listSubagents("global");
    await transport.getSubagentDetail("project", "id-1", {
      workspaceId: "w1",
      workspaceGeneration: 3,
    });
    await transport.createSubagent({ scope: "global", name: "coder" });
    await transport.setSubagentOverride({ scope: "global", candidateId: "id-1" });
    expect(sendControl.mock.calls.map(([op, args]) => [op, args])).toEqual([
      ["subagents_inventory", { scope: "global" }],
      [
        "subagents_get_detail",
        { scope: "project", candidateId: "id-1", workspaceId: "w1", workspaceGeneration: 3 },
      ],
      ["subagents_create", { scope: "global", name: "coder" }],
      ["subagents_set_override", { scope: "global", candidateId: "id-1" }],
    ]);
  });
});

describe("subagents tab", () => {
  it("shows Global first and default-selected; global requests carry no project identity", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    const { page } = setup(transport);
    await page.activate();
    expect(tabLabels()).toEqual(["global", "project"]);
    const globalTab = container.querySelector('[data-subagents-scope="global"]');
    expect(globalTab.getAttribute("aria-selected")).toBe("true");
    expect(transport.listSubagents).toHaveBeenCalledWith("global", null);
  });

  it("keeps Current project selectable for a registered workspace with exact identity", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory(
        [candidate({ id: "c-p", runtimeName: "proj", sourceScope: "project", source: "project" })],
        {
          workspaceRoot: "/ws",
          projectRoot: "/ws",
        },
      ),
    );
    const { page } = setup(transport);
    await page.activate();
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    expect(transport.listSubagents).toHaveBeenLastCalledWith("project", {
      workspaceId: "w1",
      workspaceGeneration: 3,
    });
    expect(container.textContent).toContain("proj");
    expect(container.textContent).not.toContain("writes code");
  });

  it("hides the project tab without a workspace identity and on landingOnly", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([]));
    const noIdentity = setup(transport, { identity: null });
    await noIdentity.page.activate();
    expect(tabLabels()).toEqual(["global"]);

    const landing = setup(transport, { landingOnly: true });
    await landing.page.activate();
    expect(tabLabels()).toEqual(["global"]);
    expect(transport.listSubagents).toHaveBeenCalledWith("global", null);
  });

  it("groups user, package, and a separate read-only builtin group", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([
        candidate(),
        candidate({
          id: "c-pkg",
          runtimeName: "pkg.tool",
          source: "package",
          packageIdentity: "tool",
          filePath: "/home/u/.pi/agent/npm/node_modules/tool/agents/tool.md",
        }),
        candidate({
          id: "c-builtin",
          runtimeName: "builtin-agent",
          source: "builtin",
          filePath: null,
        }),
      ]),
    );
    const { page } = setup(transport);
    await page.activate();
    const headers = [...container.querySelectorAll(".subagents-group-header")].map(
      (h) => h.textContent,
    );
    expect(headers).toEqual(["Your definitions", "Packages", "Built-in (read-only)"]);
    expect(container.querySelectorAll(".subagents-row")).toHaveLength(3);
  });

  it("annotates one dual-scope package identity once without duplicating rows", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([
        candidate({
          id: "c-shared",
          runtimeName: "shared.s",
          source: "package",
          sourceScope: "project",
          packageIdentity: "shared",
          additionalScopes: ["global"],
        }),
      ]),
    );
    const { page } = setup(transport);
    await page.activate();
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    const rows = container.querySelectorAll(".subagents-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("shared.s");
    const badges = rows[0].querySelectorAll(".subagents-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("Also available in: global");
  });

  it("renders loading, empty, generic error with retry, and conflict states", async () => {
    const transport = makeTransport();
    const pending = deferred();
    transport.listSubagents.mockReturnValueOnce(pending.promise);
    const { page } = setup(transport);
    const activating = page.activate();
    expect(container.textContent).toContain("Loading…");
    pending.resolve(inventory([]));
    await activating;
    expect(container.textContent).toContain("No agent definitions in this scope.");

    transport.listSubagents.mockRejectedValueOnce(hostError("config_unavailable", "boom"));
    container.querySelector(".subagents-retry").click();
    await flush();
    expect(container.textContent).toContain("Failed to load subagents.");

    transport.listSubagents.mockRejectedValueOnce(hostError("stale_generation"));
    container.querySelector(".subagents-retry").click();
    await flush();
    expect(container.textContent).toContain("The workspace or inventory changed.");
    expect(transport.listSubagents).toHaveBeenCalledTimes(3);
  });

  it("lists metadata only and fetches byte-exact raw definition by candidate id", async () => {
    const raw = "---\nname: real-name\ndescription: d\naliases: nick\n---\n\nPROMPT BODY  \n";
    const entry = candidate({
      id: "c-raw",
      runtimeName: "real-name",
      localName: "real-name",
      parsedFields: { name: "real-name", description: "d", runner: "native" },
    });
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([entry]));
    transport.getSubagentDetail.mockResolvedValue({
      candidateId: "c-raw",
      rawDefinition: raw,
      diagnostic: null,
    });
    const { page } = setup(transport);
    await page.activate();
    expect(container.textContent).not.toContain("PROMPT BODY");
    container.querySelector(".subagents-row").click();
    await flush();
    expect(transport.getSubagentDetail).toHaveBeenCalledWith("global", "c-raw", null);
    const pre = container.querySelector(".subagents-raw");
    expect(pre).not.toBeNull();
    // Host bytes exactly, including the trailing whitespace a parsedFields
    // reconstruction would strip.
    expect(pre.textContent).toBe(raw);
  });

  it("never issues a detail request or raw panel for a file-less builtin source", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([candidate({ id: "c-b", runtimeName: "b", source: "builtin", filePath: null })]),
    );
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    expect(transport.getSubagentDetail).not.toHaveBeenCalled();
    expect(container.querySelector(".subagents-raw")).toBeNull();
    expect(container.textContent).toContain("No definition file");
  });

  it("disk-candidates-only: no winner/effective label, save stays disabled, reload notice shown", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    transport.getSubagentDetail.mockResolvedValue({
      candidateId: "c-user-1",
      rawDefinition: "---\nname: coder\n---\n",
      diagnostic: null,
    });
    const { page } = setup(transport);
    await page.activate();
    expect(container.textContent).toContain("Disk candidates only");
    container.querySelector(".subagents-row").click();
    await flush();
    const save = container.querySelector(".subagents-save");
    expect(save).not.toBeNull();
    expect(save.disabled).toBe(true);
    // Status copy states the unverified-candidate fact; nothing on the page
    // labels the entry as the effective/winner agent, and the tab membership
    // ("Global") is never claimed as its effective scope.
    const status = container.querySelector(".subagents-status");
    expect(status.textContent).toBe("Disk candidate — runtime winner unverified");
    expect(container.querySelector("[data-winner]")).toBeNull();
    expect(container.querySelector("[data-effective]")).toBeNull();
    expect(container.textContent).toContain("or after /reload");
  });

  it("disables override controls with a diagnostic for external/unknown runners", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([
        candidate({
          id: "c-ext",
          runtimeName: "ext",
          parsedFields: { name: "ext", description: "mcp backed", runner: "mcp" },
          nativeOverrideSupported: false,
        }),
      ]),
    );
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    for (const input of container.querySelectorAll(".subagents-override-input")) {
      expect(input.disabled).toBe(true);
    }
    expect(container.querySelector(".subagents-save").disabled).toBe(true);
    expect(container.textContent).toContain("winner or out-of-scope occupancy unverified");
  });

  it("shadowed-style details expose no jump-to-winner link and no enabled save", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([
        candidate({ id: "c-a", runtimeName: "twin" }),
        candidate({ id: "c-b", runtimeName: "twin", sourceScope: "project", source: "project" }),
      ]),
    );
    transport.getSubagentDetail.mockResolvedValue({
      candidateId: "c-a",
      rawDefinition: "---\nname: twin\n---\nx",
      diagnostic: null,
    });
    const { page } = setup(transport);
    await page.activate();
    container.querySelectorAll(".subagents-row")[0].click();
    await flush();
    expect(container.querySelector(".subagents-jump")).toBeNull();
    const save = container.querySelector(".subagents-save");
    expect(save === null || save.disabled).toBe(true);
  });

  it("renders hostile YAML as inert text — no script or img executes", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory([candidate({ id: "c-x", runtimeName: "evil" })]),
    );
    transport.getSubagentDetail.mockResolvedValue({
      candidateId: "c-x",
      rawDefinition: HOSTILE_RAW,
      diagnostic: null,
    });
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(globalThis.window.__pwned).toBeUndefined();
    expect(container.querySelector(".subagents-raw").textContent).toBe(HOSTILE_RAW);
  });

  it("invalidates stale entries on workspace/generation change and ignores late promises", async () => {
    const transport = makeTransport();
    const first = deferred();
    const second = deferred();
    transport.listSubagents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { page, setIdentity } = setup(transport);
    const activatingA = page.activate();
    setIdentity({ workspaceId: "w1", workspaceGeneration: 4 });
    const activatingB = page.activate();
    // The old workspace's inventory resolves late: it must never render.
    first.resolve(inventory([candidate({ id: "old", runtimeName: "stale-entry" })]));
    await activatingA;
    expect(container.textContent).not.toContain("stale-entry");
    second.resolve(inventory([candidate({ id: "new", runtimeName: "fresh-entry" })]));
    await activatingB;
    await flush();
    expect(container.textContent).toContain("fresh-entry");
  });

  it("does not retain stale definition text when an inventory refresh keeps the candidate ID", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    transport.getSubagentDetail.mockResolvedValue({
      candidateId: "c-user-1",
      rawDefinition: "old prompt",
    });
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    expect(container.querySelector(".subagents-raw").textContent).toBe("old prompt");
    await page.activate();
    expect(container.textContent).not.toContain("old prompt");
  });

  it("resetProject drops the cached project inventory so the next activate refetches", async () => {
    const transport = makeTransport();
    const project = inventory([
      candidate({ id: "c-p2", runtimeName: "p2", sourceScope: "project", source: "project" }),
    ]);
    transport.listSubagents.mockResolvedValue(project);
    const { page } = setup(transport);
    await page.activate();
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    expect(transport.listSubagents).toHaveBeenCalledTimes(2);
    page.resetProject();
    await page.activate();
    expect(transport.listSubagents).toHaveBeenCalledTimes(3);
    expect(transport.listSubagents).toHaveBeenLastCalledWith("project", {
      workspaceId: "w1",
      workspaceGeneration: 3,
    });
  });

  it("shows saved layer fields and an evidenced inferred value only when present", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory(
        [
          candidate({
            id: "c-saved",
            savedOverride: { model: "prov/model", thinking: "high" },
            inferredValue: { model: "prov/model", thinking: "medium", source: "project layer" },
          }),
        ],
        { resolutionContext: { mode: "verified", reason: null, projectWritesAllowed: true } },
      ),
    );
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    expect(container.textContent).toContain("prov/model");
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("project layer");
    // Without evidence the inferred row must not render at all.
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    expect(container.textContent).not.toContain("project layer");
  });

  it("surfaces out-of-scope sources as diagnostics only, without any detail affordance", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    const { page } = setup(transport);
    await page.activate();
    const diagnostics = container.querySelector(".subagents-diagnostics");
    expect(diagnostics).not.toBeNull();
    expect(diagnostics.textContent).toContain(".agents/");
    expect(diagnostics.textContent).toContain("no definition body read");
    expect(diagnostics.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("subagents draft actions", () => {
  it("keeps only the changed model and preserves saved thinking:false", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory(
        [candidate({ writeQualified: true, savedOverride: { model: "a/b", thinking: false } })],
        { resolutionContext: { mode: "verified", reason: null, projectWritesAllowed: true } },
      ),
    );
    transport.getSubagentDetail.mockResolvedValue({ rawDefinition: "---\nname: coder\n---\nbody" });
    transport.setSubagentOverride.mockResolvedValue({ inventory: inventory([]) });
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-row").click();
    await flush();
    const model = container.querySelector('[aria-label="Model"]');
    expect(model.disabled).toBe(false);
    model.value = "a/c";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector(".subagents-save").click();
    await flush();
    expect(transport.setSubagentOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        candidateId: "c-user-1",
        expectedRevision: "rev-1",
        model: { op: "set", value: "a/c" },
        thinking: { op: "keep" },
      }),
    );
  });

  it("guards project draft loss when leaving after a workspace switch", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([]));
    const confirmDiscard = vi.fn(() => false);
    const { page, setIdentity } = setup(transport, { confirmDiscard });
    await page.activate();
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    container.querySelector(".subagents-new").click();
    const prompt = container.querySelector('[name="prompt"]');
    prompt.value = "keep me";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    setIdentity({ workspaceId: "w2", workspaceGeneration: 4 });
    expect(page.leave()).toBe(false);
    expect(confirmDiscard).toHaveBeenCalled();
  });

  it("retains a new-agent prompt across scope switches and refuses unqualified writes", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(inventory([candidate()]));
    const { page } = setup(transport);
    await page.activate();
    container.querySelector(".subagents-new").click();
    const prompt = container.querySelector('[name="prompt"]');
    prompt.value = "Do this safely";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    container.querySelector('[data-subagents-scope="global"]').click();
    await flush();
    expect(container.querySelector('[name="prompt"]').value).toBe("Do this safely");
    expect(container.querySelector(".subagents-create").disabled).toBe(true);
    expect(transport.createSubagent).not.toHaveBeenCalled();
  });
});

describe("subagents creation safety", () => {
  it("does not invent a target settings revision from the first candidate", async () => {
    const transport = makeTransport();
    transport.listSubagents.mockResolvedValue(
      inventory(
        [candidate({ id: "global", sourceScope: "global", settingsRevision: "global-rev" })],
        { resolutionContext: { mode: "verified", reason: null, projectWritesAllowed: true } },
      ),
    );
    transport.createSubagent.mockResolvedValue({ inventory: inventory([]) });
    const { page } = setup(transport);
    await page.activate();
    container.querySelector('[data-subagents-scope="project"]').click();
    await flush();
    container.querySelector(".subagents-new").click();
    for (const [field, value] of Object.entries({
      name: "helper",
      description: "help",
      prompt: "Do work",
    })) {
      const input = container.querySelector(`[name="${field}"]`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    container.querySelector(".subagents-create").click();
    await flush();
    expect(transport.createSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: "project-rev",
        confirmShadowedIds: [],
        expectedInventoryRevision: "inv-1",
        scope: "project",
      }),
    );
  });
});
