// ABOUTME: Renders pi-subagents async-status snapshots in a read-only mirror panel.
// ABOUTME: Malformed frames clear and hide the panel; raw JSON is never displayed.

import { onLocaleChange, t } from "../i18n.js";
import {
  MAX_ROWS,
  omittedRowCount,
  parseSubagentAsyncLines,
  rowElapsedMs,
  SNAPSHOT_STATES,
  toolElapsedMs,
} from "./subagent-async-snapshot.js";

const GLYPHS = {
  queued: "○",
  running: "◐",
  complete: "✓",
  failed: "×",
  partial: "◑",
  paused: "Ⅱ",
  stopped: "■",
  rejected: "×",
};

export class SubagentAsyncMirrorPanel {
  #element;
  #title;
  #summary;
  #list;
  #more;
  /** Last rendered snapshot and its `nowMs`: a locale switch repaints without a new frame. */
  #snapshot = null;
  #nowMs = 0;
  #unsubscribeLocaleChange = null;

  constructor({ container, widgetPlacement = "aboveEditor" } = {}) {
    this.#element = document.createElement("section");
    this.#element.className = "subagent-async-panel hidden";
    this.#element.dataset.widgetKey = "subagent-async";
    this.#title = document.createElement("strong");
    this.#title.className = "subagent-async-panel__title";
    this.#setTitle();
    this.#element.setAttribute("aria-live", "off");
    const header = document.createElement("div");
    header.className = "subagent-async-panel__header";
    this.#summary = document.createElement("span");
    this.#summary.className = "subagent-async-panel__summary";
    this.#list = document.createElement("ol");
    this.#list.className = "subagent-async-panel__list";
    this.#more = document.createElement("div");
    this.#more.className = "subagent-async-panel__more hidden";
    header.append(this.#title, this.#summary);
    this.#element.append(header, this.#list, this.#more);
    this.#insert(container, widgetPlacement);
    this.#unsubscribeLocaleChange = onLocaleChange(() => this.#refreshLocale());
  }

  get element() {
    return this.#element;
  }

  /**
   * Accepts a raw `widgetLines` value: `undefined` and malformed values clear
   * and hide the panel; a valid snapshot re-renders it. Returns `true` so the
   * registry treats the frame as consumed for this runtime.
   */
  applyWidgetLines(lines, nowMs = Date.now()) {
    const snapshot = parseSubagentAsyncLines(lines);
    if (!snapshot || (snapshot.runs.length === 0 && snapshot.omittedRuns === 0)) {
      this.clear();
      return true;
    }
    this.#snapshot = snapshot;
    this.#nowMs = nowMs;
    this.#renderSnapshot();
    return true;
  }

  clear() {
    this.#snapshot = null;
    this.#list.replaceChildren();
    this.#setMore(0);
    this.#summary.textContent = "";
    this.#element.classList.add("hidden");
  }

  destroy() {
    this.#unsubscribeLocaleChange?.();
    this.#unsubscribeLocaleChange = null;
    this.#element.remove();
  }

  #renderSnapshot() {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    this.#setTitle();
    if (snapshot.runs.length === 0) {
      this.#list.replaceChildren();
      this.#setMore(0);
      this.#summary.textContent = t("subagentAsync.summary", { count: snapshot.omittedRuns });
      this.#element.classList.remove("hidden");
      return;
    }
    this.#summary.textContent = SNAPSHOT_STATES.map((state) => {
      const count = snapshot.runs.filter((item) => item.state === state).length;
      return count > 0 ? `${count} ${t(`subagentAsync.state.${state}`)}` : null;
    })
      .filter(Boolean)
      .join(" · ");
    this.#list.replaceChildren(
      ...snapshot.runs.slice(0, MAX_ROWS).map((item) => this.#renderRow(item, this.#nowMs)),
    );
    this.#setMore(omittedRowCount(snapshot));
    this.#element.classList.remove("hidden");
  }

  #setTitle() {
    this.#title.textContent = t("subagentAsync.title");
    this.#element.setAttribute("aria-label", this.#title.textContent);
  }

  /** Repaints the last snapshot in the new locale; cleared panels only re-title themselves. */
  #refreshLocale() {
    this.#setTitle();
    this.#renderSnapshot();
  }

  #setMore(count) {
    this.#more.textContent = count > 0 ? t("subagentAsync.more", { count }) : "";
    this.#more.classList.toggle("hidden", count === 0);
  }

  #renderRow(run, nowMs) {
    const item = document.createElement("li");
    item.className = "subagent-async-panel__job";
    item.dataset.state = run.state;
    const main = document.createElement("div");
    main.className = "subagent-async-panel__jobMain";
    main.append(
      this.#renderGlyph(run.state),
      this.#renderName(run.label),
      this.#renderState(run.state),
    );
    if (run.needsAttention) main.append(renderAttentionBadge());
    item.append(main);
    const detail = this.#renderDetail(run, nowMs);
    if (detail.childNodes.length > 0) item.append(detail);
    return item;
  }

  #renderGlyph(state) {
    const glyph = document.createElement("span");
    glyph.className = "subagent-async-panel__glyph";
    glyph.classList.toggle("is-live", state === "running");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = GLYPHS[state] ?? "•";
    return glyph;
  }

  #renderName(label) {
    const name = document.createElement("span");
    name.className = "subagent-async-panel__name";
    name.textContent = label;
    name.title = label;
    return name;
  }

  #renderState(state) {
    const text = document.createElement("span");
    text.className = "subagent-async-panel__state";
    text.textContent = t(`subagentAsync.state.${state}`);
    return text;
  }

  #renderDetail(run, nowMs) {
    const detail = document.createElement("div");
    detail.className = "subagent-async-panel__detail";
    const parts = [];
    if (run.currentTool !== null) {
      parts.push(t("subagentAsync.currentTool", { name: run.currentTool }));
    }
    const toolMs = toolElapsedMs(run, nowMs);
    if (toolMs !== null) {
      parts.push(t("subagentAsync.toolElapsed", { duration: formatDuration(toolMs) }));
    }
    if (run.turnCount !== null) parts.push(t("subagentAsync.turns", { count: run.turnCount }));
    if (run.toolCount !== null) parts.push(t("subagentAsync.toolCalls", { count: run.toolCount }));
    const elapsedMs = rowElapsedMs(run, nowMs);
    if (elapsedMs !== null) {
      parts.push(t("subagentAsync.elapsed", { duration: formatDuration(elapsedMs) }));
    }
    for (const text of parts) {
      const span = document.createElement("span");
      span.textContent = text;
      detail.append(span);
    }
    return detail;
  }

  #insert(container, placement) {
    const form = container?.querySelector("form");
    if (!container || !form) return;
    if (placement === "belowEditor") form.insertAdjacentElement("afterend", this.#element);
    else form.insertAdjacentElement("beforebegin", this.#element);
  }
}

function renderAttentionBadge() {
  const badge = document.createElement("span");
  badge.className = "subagent-async-panel__attention";
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⚠ ";
  badge.append(icon, document.createTextNode(t("subagentAsync.attention")));
  return badge;
}

function formatDuration(ms) {
  return t("subagentAsync.seconds", { count: Math.floor(ms / 1000) });
}
