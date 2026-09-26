// ABOUTME: Unit tests for the composer arrow-key insertion guard — the
// ABOUTME: WKWebView/AppKit C0 fallback (U+001C-U+001F) must never reach the
// ABOUTME: composer value, while ordinary typing stays untouched.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { guardComposerArrowInsertion } from "./composer-caret-guard.js";

let textarea;
let detach;

beforeEach(() => {
  textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  detach = guardComposerArrowInsertion(textarea);
});

afterEach(() => {
  detach?.();
  textarea.remove();
});

const beforeInput = (data) =>
  textarea.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data,
      cancelable: true,
      bubbles: true,
    }),
  );

test("beforeinput cancels an insertText carrying the C0 arrow encoding", () => {
  let cancelled = false;
  textarea.addEventListener("beforeinput", (event) => {
    cancelled = event.defaultPrevented;
  });
  beforeInput(String.fromCharCode(0x1d));
  expect(cancelled).toBe(true);
});

test("beforeinput leaves ordinary text insertion alone", () => {
  const spy = vi.fn();
  textarea.addEventListener("beforeinput", (event) => {
    if (event.defaultPrevented) spy();
  });
  beforeInput("a");
  expect(spy).not.toHaveBeenCalled();
});

test("an input pass strips C0 arrows that slipped past beforeinput", () => {
  // AppKit's insertText can bypass the beforeinput contract: simulate the
  // landed value, then let the guard's input pass repair it.
  const right = String.fromCharCode(0x1d);
  textarea.value = `abc${right}${right}`;
  textarea.setSelectionRange(5, 5);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));

  expect(textarea.value).toBe("abc");
  // The caret keeps its reading position (after "abc").
  expect(textarea.selectionStart).toBe(3);
});

test("an input pass without C0 arrows does not rewrite the value", () => {
  textarea.value = "plain text";
  const spy = vi.spyOn(textarea, "setSelectionRange");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  expect(textarea.value).toBe("plain text");
  expect(spy).not.toHaveBeenCalled();
});
