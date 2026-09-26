// ABOUTME: Vitest coverage for the pane scrollbar auto-hide class toggle.
// ABOUTME: Panes in the watched list show their thumb only while scrolling.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  SCROLL_AUTO_HIDE_IDLE_MS,
  SCROLL_AUTO_HIDE_SELECTOR,
  setupScrollbarAutoHide,
} from "./scrollbar-auto-hide.js";

let teardown = null;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

function mount(className) {
  const el = document.createElement("div");
  el.className = className;
  document.body.appendChild(el);
  return el;
}

test("a watched pane shows its thumb while scrolling and hides it when idle", () => {
  teardown = setupScrollbarAutoHide();
  const pane = mount("messages");
  expect(pane.classList.contains("is-scrolling")).toBe(false);

  pane.dispatchEvent(new Event("scroll"));
  expect(pane.classList.contains("is-scrolling")).toBe(true);

  vi.advanceTimersByTime(SCROLL_AUTO_HIDE_IDLE_MS);
  expect(pane.classList.contains("is-scrolling")).toBe(false);
});

test("continuous scrolling keeps the thumb visible", () => {
  teardown = setupScrollbarAutoHide();
  const pane = mount("messages");

  pane.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(SCROLL_AUTO_HIDE_IDLE_MS - 100);
  pane.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(SCROLL_AUTO_HIDE_IDLE_MS - 100);
  expect(pane.classList.contains("is-scrolling")).toBe(true);

  vi.advanceTimersByTime(200);
  expect(pane.classList.contains("is-scrolling")).toBe(false);
});

test("panes outside the watched list are untouched", () => {
  teardown = setupScrollbarAutoHide();
  const other = mount("some-other-pane");
  other.dispatchEvent(new Event("scroll"));
  expect(other.classList.contains("is-scrolling")).toBe(false);
});

test("every watched pane keeps its own idle timer", () => {
  teardown = setupScrollbarAutoHide();
  for (const selector of SCROLL_AUTO_HIDE_SELECTOR.split(",")) {
    const className = selector.trim().replace(/^\./, "").replace(/\./g, " ");
    const pane = mount(className);
    pane.dispatchEvent(new Event("scroll"));
    expect(pane.classList.contains("is-scrolling")).toBe(true);
  }
});

test("disconnect stops the toggling", () => {
  const stop = setupScrollbarAutoHide();
  const pane = mount("messages");
  stop();

  pane.dispatchEvent(new Event("scroll"));
  expect(pane.classList.contains("is-scrolling")).toBe(false);
});
