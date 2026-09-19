import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { t } from "../i18n.js";
import { createTriggerRouter } from "./composer-triggers.js";
import { setupSkillSlashCommand, titleCaseSkillName } from "./skill-slash-command.js";

const SKILLS = [
  {
    command: "/skill:code-review",
    name: "code-review",
    description: "Review a diff",
    scope: "personal",
    kind: "skill",
  },
  {
    command: "/skill:research",
    name: "research",
    description: "Investigate primary sources",
    scope: "project",
    kind: "skill",
  },
  {
    command: "/review",
    name: "review",
    description: "Review staged git changes",
    scope: "project",
    kind: "prompt",
  },
];

describe("skill slash command (router-driven)", () => {
  let dom;
  let input;
  let container;

  beforeEach(() => {
    dom = new JSDOM(`
      <textarea id="input"></textarea>
      <div id="skills" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.queueMicrotask = (callback) => callback();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("input");
    container = document.getElementById("skills");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.queueMicrotask;
  });

  function makePicker(loadSkills = async () => SKILLS) {
    return setupSkillSlashCommand({ input, container, loadSkills });
  }

  function mountRouter(picker) {
    return createTriggerRouter({
      input,
      pickers: [{ kind: "slash", ...picker }],
    });
  }

  const keydown = (opts) =>
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { cancelable: true, ...opts }));

  test("opens for a slash token mid-prompt after whitespace (D3 rule)", async () => {
    const picker = makePicker();
    input.value = "please /diff";
    input.setSelectionRange(12, 12);
    await picker.update();

    expect(container.classList.contains("hidden")).toBe(false);
    expect(container.querySelectorAll(".skill-slash-option")).toHaveLength(1);
    expect(container.textContent).toContain("Code Review");
    expect(container.textContent).toContain("Personal");
  });

  test("whole-input slash still opens and filters", async () => {
    const picker = makePicker();
    input.value = "/skill:res";
    input.setSelectionRange(input.value.length, input.value.length);
    await picker.update();

    expect(container.querySelectorAll(".skill-slash-option")).toHaveLength(1);
    expect(container.textContent).toContain("Research");
  });

  test("renders prompt templates alongside skills with kind markers", async () => {
    const picker = makePicker();
    input.value = "/review";
    input.setSelectionRange(input.value.length, input.value.length);
    await picker.update();

    const options = container.querySelectorAll(".skill-slash-option");
    expect(options).toHaveLength(2);
    expect(options[0].dataset.kind).toBe("skill");
    expect(options[1].dataset.kind).toBe("prompt");
    // Visual distinction rides on the icon: file-text renders 5 paths, box 3.
    expect(options[0].querySelectorAll(".skill-slash-icon path")).toHaveLength(3);
    expect(options[1].querySelectorAll(".skill-slash-icon path")).toHaveLength(5);
  });

  test("C2: an unresolvable query opens nothing and renders no empty state", async () => {
    const picker = makePicker();
    input.value = "/zzz-nomatch";
    input.setSelectionRange(input.value.length, input.value.length);
    await picker.update();

    expect(container.classList.contains("hidden")).toBe(true);
    expect(container.children).toHaveLength(0);
    // The heading and "No matching skills" empty state are dead UI (C2).
    expect(container.querySelector(".skill-slash-heading")).toBeNull();
    expect(container.querySelector(".skill-slash-empty")).toBeNull();
  });

  test("C2: a query that narrows to zero matches closes an open menu", async () => {
    const picker = makePicker();
    input.value = "/re";
    input.setSelectionRange(3, 3);
    await picker.update();
    expect(container.classList.contains("hidden")).toBe(false);

    input.value = "/rezzz";
    input.setSelectionRange(6, 6);
    await picker.update();
    expect(container.classList.contains("hidden")).toBe(true);
  });

  test("C2: a slow catalog load does not reopen for a stale or emptied query", async () => {
    let resolveSkills;
    const picker = makePicker(
      () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    );
    input.value = "/re";
    input.setSelectionRange(3, 3);
    const pending = picker.update();
    await Promise.resolve();
    // User keeps typing into a non-matching token and empties the slash span.
    input.value = "plain prose now";
    input.setSelectionRange(input.value.length, input.value.length);
    resolveSkills(SKILLS);
    await pending;

    expect(container.classList.contains("hidden")).toBe(true);
  });

  test("keyboard selection through the router inserts the command in place", async () => {
    const picker = makePicker();
    mountRouter(picker);
    const send = vi.fn();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.defaultPrevented) send();
    });

    input.value = "run / now";
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(container.classList.contains("hidden")).toBe(false));
    expect(container.querySelectorAll(".skill-slash-option")).toHaveLength(3);

    keydown({ key: "ArrowDown" });
    keydown({ key: "Enter" });

    // The token (not the whole input) is replaced; surrounding prose stays.
    expect(input.value).toBe("run /skill:research  now");
    expect(input.selectionStart).toBe("/skill:research ".length + 4);
    expect(container.classList.contains("hidden")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  test("router: Enter falls through and sends when no menu is open", async () => {
    const picker = makePicker();
    mountRouter(picker);
    const send = vi.fn();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.defaultPrevented) send();
    });

    input.value = "hello there";
    keydown({ key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
  });

  test("does not select while IME composition is active", async () => {
    const picker = makePicker();
    mountRouter(picker);
    input.value = "/";
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(container.classList.contains("hidden")).toBe(false));

    keydown({ key: "Enter", isComposing: true });
    keydown({ key: "Enter", keyCode: 229 });

    expect(input.value).toBe("/");
    expect(container.classList.contains("hidden")).toBe(false);
  });

  test("retries loading commands after a transient failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const picker = makePicker(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Pi is reloading");
      return SKILLS;
    });

    input.value = "/";
    input.setSelectionRange(1, 1);
    await picker.update();
    await picker.update();

    expect(attempts).toBe(2);
    expect(container.textContent).toContain("Research");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("does not reopen after blur while the catalog is loading", async () => {
    let resolveSkills;
    const picker = makePicker(
      () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    );

    input.value = "/";
    input.setSelectionRange(1, 1);
    input.focus();
    const pendingUpdate = picker.update();
    await Promise.resolve();
    input.blur();
    resolveSkills(SKILLS);
    await pendingUpdate;

    expect(container.classList.contains("hidden")).toBe(true);
  });

  test("aria wiring uses the slashCommands i18n namespace", () => {
    makePicker();
    expect(container.getAttribute("aria-label")).toBe(t("slashCommands.listLabel"));
  });

  test("formats kebab-case names for display", () => {
    expect(titleCaseSkillName("agent-evaluation")).toBe("Agent Evaluation");
  });
});
