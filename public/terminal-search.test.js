// ABOUTME: Tests for the terminal find bar: mount/open/close lifecycle,
// ABOUTME: query delegation to the active tab, and focus restoration.
import { afterEach, expect, test, vi } from "vitest";
import { TerminalSearch } from "./terminal-search.js";

// Tests assert aria-labels against the i18n key (fallback form), so stub
// i18n to return the key itself and avoid missing-key console warns.
vi.mock("./i18n.js", () => ({ t: (key) => key }));

function makeSearch(tabOverrides = {}) {
  const tab = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearSearch: vi.fn(),
    focus: vi.fn(),
    ...tabOverrides,
  };
  const search = new TerminalSearch({ getActiveTab: () => tab });
  search.mount(document.body);
  return { search, tab };
}

function key(input, keyName, init = {}) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...init }));
}

afterEach(() => {
  document.body.textContent = "";
});

test("mount appends a hidden search bar", () => {
  const { search } = makeSearch();
  const root = document.body.querySelector("[data-terminal-search]");
  expect(root).not.toBeNull();
  expect(root.classList.contains("hidden")).toBe(true);
  expect(search.isOpen()).toBe(false);
  search.destroy();
});

test("open shows the bar, clears the query, and focuses the input", () => {
  const { search } = makeSearch();
  search.open();
  expect(search.isOpen()).toBe(true);
  expect(document.activeElement).toBe(search.input);
  expect(search.input.value).toBe("");
  search.destroy();
});

test("Enter finds next and Shift+Enter finds previous", () => {
  const { search, tab } = makeSearch();
  search.open();
  search.input.value = "make";
  key(search.input, "Enter");
  expect(tab.findNext).toHaveBeenCalledWith("make");
  expect(tab.findPrevious).not.toHaveBeenCalled();
  key(search.input, "Enter", { shiftKey: true });
  expect(tab.findPrevious).toHaveBeenCalledWith("make");
  search.destroy();
});

test("an empty query does not search", () => {
  const { search, tab } = makeSearch();
  search.open();
  key(search.input, "Enter");
  expect(tab.findNext).not.toHaveBeenCalled();
  expect(tab.findPrevious).not.toHaveBeenCalled();
  search.destroy();
});

test("Escape closes, clears the decoration, and refocuses the terminal", () => {
  const { search, tab } = makeSearch();
  search.open();
  key(search.input, "Escape");
  expect(search.isOpen()).toBe(false);
  expect(tab.clearSearch).toHaveBeenCalledTimes(1);
  expect(tab.focus).toHaveBeenCalledTimes(1);
  search.destroy();
});

test("close and next buttons delegate to the active tab", () => {
  const { search, tab } = makeSearch();
  search.open();
  search.input.value = "ls";
  search.nextButton.click();
  search.prevButton.click();
  expect(tab.findNext).toHaveBeenCalledWith("ls");
  expect(tab.findPrevious).toHaveBeenCalledWith("ls");
  search.closeButton.click();
  expect(search.isOpen()).toBe(false);
  expect(tab.clearSearch).toHaveBeenCalledTimes(1);
  search.destroy();
});

test("a missing active tab is tolerated", () => {
  const search = new TerminalSearch({ getActiveTab: () => null });
  search.mount(document.body);
  search.open();
  expect(() => key(search.input, "Enter")).not.toThrow();
  expect(() => search.close()).not.toThrow();
  search.destroy();
});

test("toggle alternates open/close", () => {
  const { search } = makeSearch();
  search.toggle();
  expect(search.isOpen()).toBe(true);
  search.toggle();
  expect(search.isOpen()).toBe(false);
  search.destroy();
});

test("destroy removes the DOM", () => {
  const { search } = makeSearch();
  search.destroy();
  expect(document.body.querySelector("[data-terminal-search]")).toBeNull();
  expect(search.root).toBeNull();
  expect(search.isOpen()).toBe(false);
});

test("applyLocale refreshes placeholder and titles", () => {
  const { search } = makeSearch();
  search.open();
  search.applyLocale();
  expect(search.input.placeholder).toBe("terminal.searchPlaceholder");
  expect(search.prevButton.title).toBe("terminal.searchPrevious");
  expect(search.nextButton.title).toBe("terminal.searchNext");
  expect(search.closeButton.title).toBe("terminal.searchClose");
  search.destroy();
});
