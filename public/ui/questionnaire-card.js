// ABOUTME: Renders the complete ask-user-question form and preserves its local answers.
// ABOUTME: Drains the extension's sequential dialog requests after the user submits.

import { onLocaleChange, t } from "../i18n.js";
import { renderMarkdown } from "./markdown.js";

const TOOL_NAME = "ask_user_question";

function asText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function parseArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string") return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeQuestion(question, index) {
  const source = question && typeof question === "object" ? question : {};
  const options = Array.isArray(source.options)
    ? source.options.map((option) => {
        if (option && typeof option === "object") {
          return {
            label: asText(option.label ?? option.value),
            description: asText(option.description),
            preview: asText(option.preview),
          };
        }
        return { label: asText(option), description: "", preview: "" };
      })
    : [];
  return {
    id: asText(source.id) || `question-${index + 1}`,
    label: asText(source.label),
    prompt: asText(source.prompt ?? source.question ?? source.text ?? source.label),
    description: asText(source.description),
    preview: asText(source.preview),
    multiSelect: source.multiSelect === true,
    options,
  };
}

function questionText(question) {
  return question.prompt || question.label || question.id;
}

function createElement(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/**
 * Standalone renderer for the main-window ask_user_question flow.
 *
 * `send` receives the same extension_ui_response object that DialogHandler
 * sends. `confirmAbandon` is the only integration seam for the existing
 * dialog layer; it receives the localized title/body and returns a boolean or
 * promise. `handleRequest()` returns true when it owns a request and false
 * when the caller should pass it to DialogHandler.
 */
export class QuestionnaireCard {
  constructor({
    container,
    send = null,
    respond = null,
    confirmAbandon = null,
    wsClient = null,
    abortSignal = null,
  } = {}) {
    this.container = container;
    this.send = typeof respond === "function" ? respond : send;
    this.confirmAbandon = confirmAbandon;
    this.wsClient = wsClient;
    this.abortSignal = abortSignal;
    this.questions = [];
    this.answers = [];
    this.cursor = 0;
    this.pendingRequest = null;
    this.pendingSentinel = false;
    this.submitted = false;
    this.cancelRequested = false;
    this.confirming = false;
    this._destroyed = false;

    this._onKeyDown = (event) => {
      if (event.key === "Escape" && this.isActive() && !this.confirming) {
        event.preventDefault();
        void this.requestAbandon();
      }
    };
    this._onDisconnected = () => this.handleAbort();
    this._onAbortSignal = () => this.handleAbort();
    document.addEventListener("keydown", this._onKeyDown);
    wsClient?.addEventListener?.("disconnected", this._onDisconnected);
    abortSignal?.addEventListener?.("abort", this._onAbortSignal, { once: true });
    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (this.isActive()) this.render();
    });
  }

  isActive() {
    return this.questions.length > 0 && !this._destroyed;
  }

  /** Start from a tool_execution_start event. Returns false for other tools. */
  start(toolExecution) {
    if (toolExecution?.toolName !== TOOL_NAME) return false;
    const args = parseArgs(toolExecution.args);
    if (!Array.isArray(args.questions) || args.questions.length === 0) return false;
    if (this.isActive()) this.teardown();
    this.clear();
    this.toolCallId = toolExecution.toolCallId || null;
    this.questions = args.questions.map(normalizeQuestion);
    this.answers = this.questions.map((question) =>
      question.multiSelect ? { selected: new Set(), custom: "" } : { selected: null, custom: "" },
    );
    this.cursor = 0;
    this.pendingRequest = null;
    this.pendingSentinel = false;
    this.submitted = false;
    this.cancelRequested = false;
    this.render();
    return true;
  }

  handleToolExecutionStart(event) {
    return this.start(event);
  }

  /**
   * Consume a matching extension request. Before Submit it is held so the
   * walker remains blocked while the user reviews all questions. After Submit
   * the request is answered and later requests are drained automatically.
   */
  handleRequest(request) {
    if (!this.isActive()) return false;
    if (this.cancelRequested) {
      this.respond(request, { cancelled: true });
      this.teardown({ cancelPending: false });
      return true;
    }
    if (!this._matchesCursor(request)) return false;
    if (this.pendingRequest) return false;
    this.pendingRequest = request;
    if (this.submitted) this._drainPendingRequest();
    return true;
  }

  handleExtensionUIRequest(request) {
    return this.handleRequest(request);
  }

  submit() {
    if (!this.isActive()) return false;
    this.submitted = true;
    this.container?.querySelector(".questionnaire-submit")?.setAttribute("aria-busy", "true");
    this._drainPendingRequest();
    return true;
  }

  async requestAbandon() {
    if (!this.isActive() || this.confirming) return false;
    this.confirming = true;
    this.overlay?.classList.add("hidden");
    let confirmed = false;
    try {
      const result =
        typeof this.confirmAbandon === "function"
          ? await this.confirmAbandon({
              title: t("questionnaire.abandonConfirmTitle"),
              message: t("questionnaire.abandonConfirmBody"),
            })
          : typeof window.confirm === "function"
            ? window.confirm(t("questionnaire.abandonConfirmBody"))
            : false;
      confirmed = result === true;
    } finally {
      this.confirming = false;
      if (this.isActive() && !confirmed) this.overlay?.classList.remove("hidden");
    }
    if (!confirmed || !this.isActive()) return false;
    this.cancelRequested = true;
    if (this.pendingRequest) {
      this.respond(this.pendingRequest, { cancelled: true });
      this.teardown({ cancelPending: false });
    } else {
      // The walker may not have emitted its next request yet. Keep a small
      // cancellation tombstone so that request is answered instead of stranded.
      this.submitted = true;
      this.overlay?.classList.add("hidden");
    }
    return true;
  }

  abandon() {
    return this.requestAbandon();
  }

  handleToolExecutionEnd(event) {
    if (!this.isActive()) return;
    if (!event?.toolCallId || event.toolCallId === this.toolCallId) this.teardown();
  }

  handleSessionSwitch() {
    this.teardown();
  }

  handleAbort() {
    this.teardown();
  }

  clear() {
    this.questions = [];
    this.answers = [];
    this.toolCallId = null;
    this.pendingRequest = null;
    this.pendingSentinel = false;
    this.cursor = 0;
    this.submitted = false;
    this.cancelRequested = false;
    this.overlay?.remove();
    this.overlay = null;
  }

  teardown({ cancelPending = true } = {}) {
    if (cancelPending && this.pendingRequest) {
      this.respond(this.pendingRequest, { cancelled: true });
    }
    this.clear();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    document.removeEventListener("keydown", this._onKeyDown);
    this.wsClient?.removeEventListener?.("disconnected", this._onDisconnected);
    this.abortSignal?.removeEventListener?.("abort", this._onAbortSignal);
    this.unsubscribeLocaleChange?.();
    this.unsubscribeLocaleChange = null;
    this.clear();
    this.send = null;
    this.container = null;
  }

  _matchesCursor(request) {
    const question = this.questions[this.cursor];
    if (!question || !request?.id) return false;
    const prompt = questionText(question);
    const title = asText(request.title);
    if (prompt && title && !title.includes(prompt)) return false;
    if (question.multiSelect) return request.method === "input";
    if (this.pendingRequest?.method === "select") return false;
    if (request.method === "select") return true;
    return request.method === "input" && this.pendingSentinel;
  }

  _drainPendingRequest() {
    const request = this.pendingRequest;
    if (!request) return;
    const question = this.questions[this.cursor];
    const answer = this.answers[this.cursor];
    if (!question || !answer) return;

    if (!question.multiSelect && request.method === "select") {
      const custom = answer.custom.trim();
      const selectedIndex = custom ? (request.options || []).length - 1 : answer.selected;
      const safeIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? selectedIndex : 0;
      const value = request.options?.[safeIndex];
      if (typeof value !== "string") return;
      this.respond(request, { value });
      if (custom) {
        this.pendingRequest = null;
        this.pendingSentinel = true;
        return;
      }
      this._advance();
      return;
    }

    if (!question.multiSelect && request.method === "input" && this.pendingSentinel) {
      this.respond(request, { value: answer.custom.trim() });
      this.pendingSentinel = false;
      this._advance();
      return;
    }

    if (question.multiSelect && request.method === "input") {
      const custom = answer.custom.trim();
      const value =
        custom ||
        [...answer.selected]
          .sort((a, b) => a - b)
          .map((index) => index + 1)
          .join(",");
      // An empty multi-select is a valid answer, not a questionnaire cancel.
      this.respond(request, { value });
      this._advance();
    }
  }

  _advance() {
    this.pendingRequest = null;
    this.pendingSentinel = false;
    this.cursor += 1;
    if (this.cursor >= this.questions.length) {
      this.teardown();
    }
  }

  respond(request, response) {
    if (typeof this.send === "function") {
      this.send({ type: "extension_ui_response", id: request.id, ...response });
    }
  }

  render() {
    if (!this.container || !this.isActive()) return;
    this.overlay?.remove();
    const overlay = createElement("div", "questionnaire-card-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", t("questionnaire.title"));
    const card = createElement("div", "questionnaire-card");
    const heading = createElement("h2", "questionnaire-title", t("questionnaire.title"));
    card.appendChild(heading);

    const form = createElement("div", "questionnaire-questions");
    this.questions.forEach((question, questionIndex) => {
      form.appendChild(this._renderQuestion(question, questionIndex));
    });
    card.appendChild(form);

    const actions = createElement("div", "questionnaire-actions");
    const abandon = createElement("button", "questionnaire-abandon", t("questionnaire.abandon"));
    abandon.type = "button";
    abandon.addEventListener("click", () => void this.requestAbandon());
    const submit = createElement("button", "questionnaire-submit", t("questionnaire.submit"));
    submit.type = "button";
    submit.classList.add("btn-primary");
    submit.addEventListener("click", () => this.submit());
    actions.append(abandon, submit);
    card.appendChild(actions);
    overlay.appendChild(card);
    this.container.appendChild(overlay);
    this.overlay = overlay;
    const firstControl = overlay.querySelector("input, button");
    firstControl?.focus();
  }

  _renderQuestion(question, questionIndex) {
    const answer = this.answers[questionIndex];
    const section = createElement("section", "questionnaire-question");
    section.dataset.questionIndex = String(questionIndex);
    const heading = createElement("h3", "questionnaire-question-title", questionText(question));
    section.appendChild(heading);
    if (question.label && question.label !== questionText(question)) {
      section.insertBefore(
        createElement("div", "questionnaire-question-label", question.label),
        heading,
      );
    }
    if (question.description)
      section.appendChild(
        createElement("p", "questionnaire-question-description", question.description),
      );
    if (question.preview)
      section.appendChild(this._renderMarkdown(question.preview, "questionnaire-preview"));

    const options = createElement(
      "div",
      question.multiSelect
        ? "questionnaire-options questionnaire-options--multi"
        : "questionnaire-options",
    );
    question.options.forEach((option, optionIndex) => {
      const optionLabel = createElement("label", "questionnaire-option");
      const control = document.createElement("input");
      control.type = question.multiSelect ? "checkbox" : "radio";
      control.name = `questionnaire-${questionIndex}`;
      control.checked = question.multiSelect
        ? answer.selected.has(optionIndex)
        : answer.selected === optionIndex;
      if (question.multiSelect) {
        control.addEventListener("change", () => {
          if (control.checked) answer.selected.add(optionIndex);
          else answer.selected.delete(optionIndex);
        });
        control.addEventListener("click", () => {
          if (control.checked) answer.selected.add(optionIndex);
          else answer.selected.delete(optionIndex);
        });
      } else {
        const select = () => {
          answer.selected = optionIndex;
          for (const row of section.querySelectorAll(".questionnaire-option")) {
            row.classList.remove("is-selected");
          }
          optionLabel.classList.add("is-selected");
        };
        control.addEventListener("change", select);
        control.addEventListener("click", select);
      }
      optionLabel.classList.toggle("is-selected", control.checked);
      const body = createElement("span", "questionnaire-option-body");
      body.appendChild(createElement("span", "questionnaire-option-label", option.label));
      if (option.description)
        body.appendChild(
          createElement("span", "questionnaire-option-description", option.description),
        );
      optionLabel.append(control, body);
      if (option.preview)
        optionLabel.appendChild(
          this._renderMarkdown(option.preview, "questionnaire-option-preview"),
        );
      options.appendChild(optionLabel);
    });
    section.appendChild(options);

    const custom = document.createElement("input");
    custom.type = "text";
    custom.className = "questionnaire-custom-answer";
    custom.placeholder = t("questionnaire.customAnswerPlaceholder");
    custom.value = answer.custom;
    custom.setAttribute("aria-label", t("questionnaire.customAnswerPlaceholder"));
    custom.addEventListener("input", () => {
      answer.custom = custom.value;
    });
    if (question.multiSelect)
      section.appendChild(
        createElement("p", "questionnaire-multi-hint", t("questionnaire.multiSelectHint")),
      );
    section.appendChild(custom);
    return section;
  }

  _renderMarkdown(text, className) {
    const element = createElement("div", className);
    const parsed = new DOMParser().parseFromString(renderMarkdown(text), "text/html");
    appendSafeMarkdownNodes(element, parsed.body);
    return element;
  }
}

const SAFE_MARKDOWN_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "DIV",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SPAN",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const SAFE_MARKDOWN_URLS = /^(?:https?:|mailto:)/i;

function appendSafeMarkdownNodes(target, source) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(node.nodeValue || ""));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toUpperCase();
    if (!SAFE_MARKDOWN_TAGS.has(tag)) {
      appendSafeMarkdownNodes(target, node);
      continue;
    }
    const safe = document.createElement(tag.toLowerCase());
    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      if (!SAFE_MARKDOWN_URLS.test(href)) {
        appendSafeMarkdownNodes(safe, node);
        target.appendChild(safe);
        continue;
      }
      safe.setAttribute("href", href);
      safe.setAttribute("target", "_blank");
      safe.setAttribute("rel", "noopener noreferrer");
    }
    appendSafeMarkdownNodes(safe, node);
    target.appendChild(safe);
  }
}

export function isAskUserQuestionTool(event) {
  return event?.toolName === TOOL_NAME && Array.isArray(parseArgs(event.args).questions);
}
