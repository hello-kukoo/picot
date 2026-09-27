import { afterEach, describe, expect, it, vi } from "vitest";
import { bindDialogEscape, dialogOwnsEscape } from "./dialog-escape.js";

describe("bindDialogEscape", () => {
  const unbinders = [];

  afterEach(() => {
    for (const unbind of unbinders.splice(0)) unbind();
  });

  it("closes on Escape and reports ownership", () => {
    const onClose = vi.fn();
    unbinders.push(bindDialogEscape(onClose));
    expect(dialogOwnsEscape()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the topmost active dialog first", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    unbinders.push(bindDialogEscape(outer));
    unbinders.push(bindDialogEscape(inner));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("skips inactive entries so hidden dialogs do not steal Escape", () => {
    const hidden = vi.fn();
    const visible = vi.fn();
    unbinders.push(bindDialogEscape(hidden, { isActive: () => false }));
    unbinders.push(bindDialogEscape(visible, { isActive: () => true }));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(hidden).not.toHaveBeenCalled();
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it("does not close when Escape was already handled", () => {
    const onClose = vi.fn();
    unbinders.push(bindDialogEscape(onClose));
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });
});
