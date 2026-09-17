// ABOUTME: Exercises questionnaire rendering, cursor draining, and teardown behavior.
// ABOUTME: Keeps wire responses byte-compatible with the extension's dialog walker.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { QuestionnaireCard } from "./questionnaire-card.js";

const messages = {
  questionnaire: {
    title: "Questions for you",
    submit: "Submit answers",
    abandon: "Abandon",
    abandonConfirmTitle: "Abandon questionnaire?",
    abandonConfirmBody: "The agent will receive a decline.",
    multiSelectHint: "Choose all that apply.",
    customAnswerPlaceholder: "Type a custom answer",
  },
};

function makeCard(overrides = {}) {
  const sent = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const card = new QuestionnaireCard({
    container,
    send: (message) => sent.push(message),
    ...overrides,
  });
  return { card, container, sent };
}

function start(card, questions) {
  expect(
    card.start({ toolCallId: "tool-1", toolName: "ask_user_question", args: { questions } }),
  ).toBe(true);
}

beforeEach(() => {
  setMessages(messages);
  document.body.replaceChildren();
});

describe("QuestionnaireCard rendering", () => {
  it("renders every question with descriptions, previews, and real controls", () => {
    const { card, container } = makeCard();
    start(card, [
      {
        label: "Scope",
        prompt: "Which scope?",
        description: "Pick the smallest useful scope.",
        preview: "**Preview**",
        options: [{ label: "Project", description: "One project" }],
      },
      {
        prompt: "Which risks?",
        multiSelect: true,
        options: [{ label: "Latency" }, { label: "Cost" }],
      },
    ]);

    expect(container.querySelectorAll(".questionnaire-question")).toHaveLength(2);
    expect(container.querySelector(".questionnaire-preview strong")?.textContent).toBe("Preview");
    expect(container.querySelectorAll("input[type='radio']")).toHaveLength(1);
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(2);
    expect(container.querySelector(".questionnaire-card-overlay")?.getAttribute("role")).toBe(
      "dialog",
    );
    expect(document.activeElement).toBe(container.querySelector("input[type='radio']"));
  });
});

describe("QuestionnaireCard request cursor", () => {
  it("waits for submit, then echoes the incoming option line verbatim", () => {
    const { card, container, sent } = makeCard();
    start(card, [
      { prompt: "Pick a layout", options: [{ label: "Compact" }, { label: "Spacious" }] },
    ]);

    container.querySelectorAll("input[type='radio']")[1].click();
    expect(
      card.handleRequest({
        id: "q1",
        method: "select",
        title: "Pick a layout\nChoose one",
        options: ["1. Compact — Dense", "2. Spacious — More room", "3. Tipo personalizado."],
      }),
    ).toBe(true);
    expect(sent).toHaveLength(0);

    container.querySelector(".questionnaire-submit").click();
    expect(sent).toEqual([
      {
        type: "extension_ui_response",
        id: "q1",
        value: "2. Spacious — More room",
      },
    ]);
    expect(card.isActive()).toBe(false);
  });

  it("formats checked multi-select indexes, including an explicit empty answer", () => {
    const { card, container, sent } = makeCard();
    start(card, [
      {
        prompt: "Which checks?",
        multiSelect: true,
        options: [{ label: "Unit" }, { label: "Integration" }, { label: "E2E" }],
      },
    ]);
    container.querySelectorAll("input[type='checkbox']")[0].click();
    container.querySelectorAll("input[type='checkbox']")[2].click();
    container.querySelector(".questionnaire-submit").click();
    card.handleRequest({
      id: "q2",
      method: "input",
      title: "Which checks? Enter the numbers",
    });
    expect(sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q2",
      value: "1,3",
    });

    const second = makeCard();
    start(second.card, [
      { prompt: "Which checks?", multiSelect: true, options: [{ label: "Unit" }] },
    ]);
    second.container.querySelector(".questionnaire-submit").click();
    second.card.handleRequest({ id: "q-empty", method: "input", title: "Which checks?" });
    expect(second.sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q-empty",
      value: "",
    });
    expect(second.sent.at(-1)).not.toHaveProperty("cancelled");
  });

  it("pairs a sentinel select with its later input and preserves custom text", () => {
    const { card, container, sent } = makeCard();
    start(card, [{ prompt: "What should ship?", options: [{ label: "Bug fix" }] }]);
    const custom = container.querySelector(".questionnaire-custom-answer");
    custom.value = "Ship the smallest useful version";
    custom.dispatchEvent(new Event("input"));
    container.querySelector(".questionnaire-submit").click();

    const sentinel = {
      id: "q-custom-select",
      method: "select",
      title: "What should ship?",
      // Deliberately non-English: only the request payload is authoritative.
      options: ["1. Bug fix — Repair behavior", "2. Escribe algo."],
    };
    expect(card.handleRequest(sentinel)).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q-custom-select",
      value: "2. Escribe algo.",
    });
    expect(
      card.handleRequest({
        id: "q-custom-input",
        method: "input",
        title: "What should ship?\nType your answer:",
      }),
    ).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q-custom-input",
      value: "Ship the smallest useful version",
    });
  });

  it("falls through when no card exists or a request does not match the cursor", () => {
    const { card } = makeCard();
    expect(card.handleRequest({ id: "q", method: "select", title: "Pick", options: [] })).toBe(
      false,
    );
    start(card, [{ prompt: "Pick a layout", options: [{ label: "Compact" }] }]);
    expect(card.handleRequest({ id: "other", method: "input", title: "Unrelated" })).toBe(false);
    expect(card.pendingRequest).toBeNull();
  });
});

describe("QuestionnaireCard abandon and teardown", () => {
  it("confirms abandon, then cancels the next in-flight request", async () => {
    const confirmAbandon = vi.fn(async ({ title, message }) => {
      expect(title).toBe("Abandon questionnaire?");
      expect(message).toContain("decline");
      return true;
    });
    const { card, sent } = makeCard({ confirmAbandon });
    start(card, [{ prompt: "Pick one", options: [{ label: "One" }] }]);

    await expect(card.requestAbandon()).resolves.toBe(true);
    expect(
      card.handleRequest({
        id: "q-cancel",
        method: "select",
        title: "Pick one",
        options: ["1. One", "2. Escribe algo."],
      }),
    ).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: "extension_ui_response",
      id: "q-cancel",
      cancelled: true,
    });
    expect(card.isActive()).toBe(false);
  });

  it.each([
    ["tool end", (card) => card.handleToolExecutionEnd({ toolCallId: "tool-1" })],
    ["session switch", (card) => card.handleSessionSwitch()],
    ["socket abort", (card) => card.handleAbort()],
  ])("tears down on %s", (_name, teardown) => {
    const { card, container } = makeCard();
    start(card, [{ prompt: "Pick one", options: [{ label: "One" }] }]);
    teardown(card);
    expect(card.isActive()).toBe(false);
    expect(container.querySelector(".questionnaire-card-overlay")).toBeNull();
  });
});
