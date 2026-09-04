// ABOUTME: Terminal panel find bar: input + prev/next/close delegating to the
// ABOUTME: active TerminalTab's SearchAddon. Owns its DOM only; opening is
// ABOUTME: triggered by the app's Cmd/Ctrl+F handler, closing restores focus.

import { t } from "./i18n.js";
import { setButtonIcon } from "./icons.js";

/**
 * TerminalSearch renders a small find bar inside the terminal panel and
 * forwards queries to the active tab. It never touches the WebSocket protocol:
 * search is a pure WebView-side concern over the already-rendered buffer.
 */
export class TerminalSearch {
  constructor({ getActiveTab } = {}) {
    this.getActiveTab = getActiveTab || (() => null);
    this.root = null;
    this.input = null;
    this.prevButton = null;
    this.nextButton = null;
    this.closeButton = null;
  }

  /** Build and append the hidden search bar into `container` (panel root). */
  mount(container) {
    if (!container || this.root) return;
    this.root = document.createElement("div");
    this.root.className = "terminal-search hidden";
    this.root.dataset.terminalSearch = "";
    this.root.setAttribute("role", "search");

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "terminal-search-input";
    this.input.placeholder = t("terminal.searchPlaceholder");
    this.input.setAttribute("aria-label", t("terminal.searchPlaceholder"));
    this.input.addEventListener("keydown", (event) => this._inputKeydown(event));

    this.prevButton = document.createElement("button");
    this.prevButton.type = "button";
    this.prevButton.className = "terminal-search-btn";
    setButtonIcon(this.prevButton, "arrow-up", { size: 14 });
    this.prevButton.title = t("terminal.searchPrevious");
    this.prevButton.setAttribute("aria-label", t("terminal.searchPrevious"));
    this.prevButton.addEventListener("click", () => this._find(true));

    this.nextButton = document.createElement("button");
    this.nextButton.type = "button";
    this.nextButton.className = "terminal-search-btn";
    setButtonIcon(this.nextButton, "arrow-down", { size: 14 });
    this.nextButton.title = t("terminal.searchNext");
    this.nextButton.setAttribute("aria-label", t("terminal.searchNext"));
    this.nextButton.addEventListener("click", () => this._find(false));

    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "terminal-search-btn";
    setButtonIcon(this.closeButton, "x", { size: 14 });
    this.closeButton.title = t("terminal.searchClose");
    this.closeButton.setAttribute("aria-label", t("terminal.searchClose"));
    this.closeButton.addEventListener("click", () => this.close());

    this.root.append(this.input, this.prevButton, this.nextButton, this.closeButton);
    container.appendChild(this.root);
  }

  isOpen() {
    return Boolean(this.root) && !this.root.classList.contains("hidden");
  }

  /** Show the bar, clear the query, and put focus in the input. */
  open() {
    if (!this.root) return;
    this.root.classList.remove("hidden");
    this.input.value = "";
    this.input.focus();
  }

  /** Hide the bar, clear the highlight, and hand focus back to the terminal. */
  close() {
    if (!this.root) return;
    this.root.classList.add("hidden");
    this.getActiveTab()?.clearSearch?.();
    this.getActiveTab()?.focus?.();
  }

  toggle() {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Refresh translatable strings after a locale switch. */
  applyLocale() {
    if (!this.root) return;
    this.input.placeholder = t("terminal.searchPlaceholder");
    this.input.setAttribute("aria-label", t("terminal.searchPlaceholder"));
    this.prevButton.title = t("terminal.searchPrevious");
    this.prevButton.setAttribute("aria-label", t("terminal.searchPrevious"));
    this.nextButton.title = t("terminal.searchNext");
    this.nextButton.setAttribute("aria-label", t("terminal.searchNext"));
    this.closeButton.title = t("terminal.searchClose");
    this.closeButton.setAttribute("aria-label", t("terminal.searchClose"));
  }

  destroy() {
    this.root?.remove();
    this.root = null;
    this.input = null;
    this.prevButton = null;
    this.nextButton = null;
    this.closeButton = null;
  }

  _find(previous) {
    const term = this.input.value;
    if (!term) return;
    const tab = this.getActiveTab();
    if (previous) {
      tab?.findPrevious?.(term);
    } else {
      tab?.findNext?.(term);
    }
  }

  _inputKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      // stopPropagation keeps the app-level Escape/shortcut handlers out of
      // the way while the user is composing a query.
      event.stopPropagation();
      this._find(event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }
}
