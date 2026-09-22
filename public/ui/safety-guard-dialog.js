// ABOUTME: Rich scrollable bash-approval card for datarx-safety-guard-pi.
// ABOUTME: Intercepts the extension's marker-payload selects before the
// ABOUTME: generic dialog (which long prompts stretch past the viewport) and
// ABOUTME: answers on the same extension_ui_response channel as DialogHandler.

import { t } from "../i18n.js";

const MARKER = '{"__safetyGuardBash"';

/** Scope/lifetime semantics mirrored from the extension's TUI hints. */
function hintForChoice(choice) {
  if (!choice?.scope) return t("settings.safetyGuardDialog.hintOnce");
  const lifetime = choice.lifetime;
  if (choice.scope === "operation-rule") {
    return lifetime === "session"
      ? t("settings.safetyGuardDialog.hintRuleSession")
      : t("settings.safetyGuardDialog.hintRulePermanent");
  }
  if (choice.scope === "operation-global") {
    return t("settings.safetyGuardDialog.hintEverywhere");
  }
  if (lifetime === "session") return t("settings.safetyGuardDialog.hintSession");
  if (lifetime === "permanent") return t("settings.safetyGuardDialog.hintPermanent");
  return t("settings.safetyGuardDialog.hintOnce");
}

export class SafetyGuardDialog {
  /** @param {{container?: HTMLElement|null, send?: ((message: object) => void)|null}} options */
  constructor({ container = null, send = null } = {}) {
    this.container = container;
    this.send = send;
    this.currentId = null;
    this.timeoutId = null;
    this._onKeyDown = (event) => {
      if (event.key === "Escape" && this.currentId !== null) {
        event.preventDefault();
        this.respond({ cancelled: true });
      }
    };
  }

  /**
   * First-shot interception: true when the request is a safety-guard bash
   * prompt with a parseable marker payload (rendered here); false lets the
   * generic dialog handle it — including marker selects whose JSON is broken
   * (graceful degradation per the design spec).
   */
  handleExtensionUIRequest(request) {
    if (this._destroyed || request?.method !== "select") return false;
    const message = typeof request.message === "string" ? request.message : "";
    const markerIndex = message.indexOf(MARKER);
    if (markerIndex < 0) return false;
    let payload;
    try {
      payload = JSON.parse(message.slice(markerIndex));
    } catch {
      return false;
    }
    if (payload?.__safetyGuardBash !== 1 || !Array.isArray(payload.choices)) {
      return false;
    }
    this._render(request, payload);
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._teardown();
    this.send = null;
    this.container = null;
  }

  respond(response) {
    const id = this.currentId;
    this._teardown();
    if (id !== null && typeof this.send === "function") {
      this.send({ type: "extension_ui_response", id, ...response });
    }
  }

  _teardown() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    document.removeEventListener("keydown", this._onKeyDown);
    this.container?.replaceChildren();
    this.container?.classList.add("hidden");
    this.currentId = null;
  }

  _render(request, payload) {
    this._teardown();
    this.currentId = request.id ?? null;
    const card = document.createElement("div");
    card.className = "sg-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", t("settings.safetyGuardDialog.title"));

    const header = document.createElement("div");
    header.className = "sg-header";
    const title = document.createElement("h3");
    title.textContent = t("settings.safetyGuardDialog.title");
    header.append(title);
    card.append(header);

    const body = document.createElement("div");
    body.className = "sg-body";
    for (const section of Array.isArray(payload.sections) ? payload.sections : []) {
      body.append(this._renderSection(section));
    }
    card.append(body);

    const actions = document.createElement("div");
    actions.className = "sg-actions";
    for (const choice of payload.choices) {
      if (typeof choice?.label !== "string" || choice.label === "") continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sg-btn${choice.label === "Block" ? " sg-btn-block" : ""}${
        choice.warning ? " sg-btn-warning" : ""
      }`;
      const labelLine = document.createElement("span");
      labelLine.className = "sg-btn-label";
      labelLine.textContent = choice.label;
      const hintLine = document.createElement("span");
      hintLine.className = "sg-btn-hint";
      hintLine.textContent = hintForChoice(choice);
      button.append(labelLine, hintLine);
      button.addEventListener("click", () => this.respond({ value: choice.label }));
      actions.append(button);
    }
    card.append(actions);

    this.container?.replaceChildren(card);
    this.container?.classList.remove("hidden");
    document.addEventListener("keydown", this._onKeyDown);
    // Block stays the default focus exactly like the TUI (first option).
    const first = actions.querySelector(".sg-btn");
    first?.focus();
    if (request.timeout) {
      this.timeoutId = setTimeout(() => this.respond({ cancelled: true }), request.timeout);
    }
  }

  _renderSection(section) {
    const isExcerpt = section?.label === "Risk excerpts";
    const wrapper = isExcerpt ? document.createElement("details") : document.createElement("div");
    wrapper.className = `sg-section${section?.warning ? " sg-section-warning" : ""}`;
    const label = document.createElement(isExcerpt ? "summary" : "div");
    label.className = "sg-section-label";
    label.textContent = typeof section?.label === "string" ? section.label : "";
    const body = document.createElement("pre");
    body.className = "sg-pre";
    // Plain text by contract (the extension's highlights are >>> markers,
    // never ANSI) — textContent, never innerHTML.
    body.textContent = typeof section?.body === "string" ? section.body : "";
    wrapper.append(label, body);
    return wrapper;
  }
}
