// ABOUTME: Info-panel "AI analysis" block -- hands the session's turns to the
// ABOUTME: model against a throwaway session and renders risk/blocker prose.

/**
 * AI analysis of a whole session, rendered inside the Info panel's Session
 * Info section.
 *
 * The turns are supplied by the caller through `resolveTurns` because the two
 * sources (the live recorder and the saved session log) and the order they are
 * merged in belong to the composition root, not to this view. `analyzeWithAi`
 * is the model call itself (see session-ai-runner.js): it runs against a
 * throwaway background session, so the user's own conversation is never
 * touched. This module owns only the button state machine and the Markdown
 * rendering of the answer.
 *
 * `state` lives here rather than in `render()` because the section is built
 * once and only repaints its own body between runs.
 */

import { t as translate } from "../i18n.js";
import { createIcon } from "../icons.js";
import { renderMarkdown } from "../ui/markdown.js";
import { parseSanitizedMarkup } from "../ui/sanitize-markup.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {{
 *   t?: (key: string, params?: object) => string,
 *   resolveTurns: () => Promise<Array<object>> | Array<object>,
 *   analyzeWithAi: (turns: Array<object>) => Promise<string>,
 *   isStreaming?: () => boolean,
 * }} options
 * @returns {{ element: HTMLElement, reset: () => void, refresh: () => void, isBusy: () => boolean }}
 */
export function createSessionAiAnalysis({
  t = translate,
  resolveTurns,
  analyzeWithAi,
  isStreaming = () => false,
} = {}) {
  const section = element("section", "session-ai");
  section.setAttribute("aria-labelledby", "session-ai-heading");

  const heading = element("h4", "session-ai-heading");
  heading.id = "session-ai-heading";
  const headingIcon = createIcon("sparkles", { size: 14 });
  if (headingIcon) heading.appendChild(headingIcon);
  const headingText = element("span", "", t("sessionInfo.aiTitle"));
  heading.appendChild(headingText);

  // Icon-only affordance: hover/focus reveals the explanation via the native
  // title tooltip instead of a paragraph that sits there permanently.
  const hint = element("span", "session-ai-hint");
  hint.tabIndex = 0;
  hint.setAttribute("role", "img");
  const hintIcon = createIcon("info", { size: 13 });
  if (hintIcon) hint.appendChild(hintIcon);
  heading.appendChild(hint);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-button ui-button--sm ui-button--secondary session-ai-btn";

  const body = element("div", "session-ai-body");

  section.append(heading, button, body);

  let state = { status: "idle", text: "", error: null };

  function paintButton() {
    button.textContent = t(
      state.status === "loading"
        ? "sessionInfo.aiAnalyzing"
        : state.status === "done" || state.status === "error"
          ? "sessionInfo.aiRerun"
          : "sessionInfo.aiRun",
    );
    // Analysing a turn that is still streaming would report its own open spans
    // as stuck, so the control waits for the task to finish.
    const streaming = Boolean(isStreaming?.());
    button.disabled = state.status === "loading" || streaming;
    button.title = streaming ? t("sessionInfo.aiBusy") : "";
  }

  /** Re-apply translated labels (locale change) and the streaming guard. */
  function paintLabels() {
    headingText.textContent = t("sessionInfo.aiTitle");
    hint.title = t("sessionInfo.aiHint");
    hint.setAttribute("aria-label", hint.title);
    paintButton();
  }

  function paintBody() {
    body.replaceChildren();
    if (state.status === "loading") {
      body.appendChild(element("p", "session-ai-status ui-loading", t("sessionInfo.aiAnalyzing")));
      return;
    }
    if (state.status === "error") {
      body.appendChild(element("p", "session-ai-error", state.error || t("sessionInfo.aiFailed")));
      return;
    }
    if (state.status === "done") {
      const card = element("div", "session-ai-card");
      const content = document.createElement("div");
      content.className = "session-ai-result message-content";
      content.appendChild(parseSanitizedMarkup(renderMarkdown(state.text || "")));
      card.appendChild(content);
      body.appendChild(card);
    }
  }

  function paint() {
    paintButton();
    paintBody();
  }

  async function run() {
    if (state.status === "loading" || isStreaming?.()) return;
    state = { status: "loading", text: "", error: null };
    paint();
    try {
      const turns = (await resolveTurns?.()) ?? [];
      if (!Array.isArray(turns) || !turns.length) {
        throw new Error(t("sessionInfo.aiNoTurns"));
      }
      const text = await analyzeWithAi(turns);
      state = { status: "done", text, error: null };
    } catch (error) {
      state = { status: "error", text: "", error: error?.message || String(error) };
    }
    paint();
  }

  button.addEventListener("click", () => {
    void run();
  });

  paintLabels();

  return {
    element: section,
    /** Drop a previous session's answer -- it describes work this one never did. */
    reset() {
      state = { status: "idle", text: "", error: null };
      paint();
    },
    /** Re-apply labels and the streaming guard without touching the answer. */
    refresh: paintLabels,
    isBusy: () => state.status === "loading",
  };
}
