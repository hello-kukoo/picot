import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTriggerRouter,
  resolveActiveTrigger,
  resolveSlashToken,
} from "./composer-triggers.js";

describe("resolveActiveTrigger", () => {
  const slash = (value, caret) => resolveSlashToken(value, caret);
  const trigger = (value, caret) => resolveActiveTrigger(value, caret);

  test("whole-input slash at input start resolves", () => {
    expect(slash("/code", 5)).toEqual({ start: 0, end: 5, query: "code" });
    expect(trigger("/code", 5)).toEqual({ kind: "slash", start: 0, end: 5, query: "code" });
  });

  test("slash mid-prompt after whitespace resolves (D3 token-boundary rule)", () => {
    const value = "please /code now";
    expect(trigger(value, 12)).toEqual({ kind: "slash", start: 7, end: 12, query: "code" });
  });

  test("slash after a newline resolves", () => {
    const value = "first line\n/cmd";
    expect(trigger(value, value.length)).toEqual({
      kind: "slash",
      start: 11,
      end: 15,
      query: "cmd",
    });
  });

  test("colon and @ stay inside the token (/skill:name)", () => {
    expect(trigger("/skill:code-review", 18)).toEqual({
      kind: "slash",
      start: 0,
      end: 18,
      query: "skill:code-review",
    });
  });

  test("a/b prose never resolves (token must start with /)", () => {
    expect(trigger("a/b", 3)).toBeNull();
    expect(trigger("see a/b here", 8)).toBeNull();
  });

  test("caret before the slash start does not resolve", () => {
    expect(trigger("/code", 0)).toBeNull();
    expect(trigger("run /code", 4)).toBeNull();
  });

  test("slash token ends at whitespace", () => {
    // Caret beyond the space: the token containing it has no `/` start.
    expect(trigger("/cmd rest", 9)).toBeNull();
    // Caret right after the space inside the next word: no slash token.
    expect(trigger("/cmd rest", 5)).toBeNull();
  });

  test("slash tokens are whitespace-delimited: quotes are not boundaries", () => {
    // A quoted argument is NOT a trigger context — `say "/deploy` must stay
    // prose (the quote is a word character, so the `/` is mid-token).
    expect(trigger('say "/deploy', 12)).toBeNull();
    // Quoted whitespace inside a would-be token splits it like any space.
    expect(trigger('/"foo bar"', 10)).toBeNull();
    // A quote after the slash is just token content.
    expect(slash('/"foo', 5)).toEqual({ start: 0, end: 5, query: '"foo' });
  });

  test("precedence: /abc@d yields exactly one trigger — slash", () => {
    const result = trigger("/abc@d", 6);
    expect(result).toEqual({ kind: "slash", start: 0, end: 6, query: "abc@d" });
  });

  test("/abc @d resolves to mention when the caret is in @d", () => {
    const result = trigger("/abc @d", 7);
    expect(result.kind).toBe("mention");
    expect(result.start).toBe(5);
    expect(result.end).toBe(7);
    expect(result.query).toBe("@d");
  });

  test("mention semantics preserved: rightmost @, quotes, whitespace end", () => {
    expect(trigger("@src/a", 6)).toEqual({ kind: "mention", start: 0, end: 6, query: "@src/a" });
    expect(trigger("name@host", 9)).toBeNull();
    expect(trigger('@"my path"', 11)).toEqual({
      kind: "mention",
      start: 0,
      end: 11,
      query: '@"my path"',
    });
    expect(trigger("@foo bar", 8)).toBeNull();
  });

  test("plain prose resolves nothing", () => {
    expect(trigger("hello world", 11)).toBeNull();
    expect(trigger("", 0)).toBeNull();
  });
});

describe("createTriggerRouter", () => {
  let dom;
  let input;

  const makePicker = (kind) => ({
    kind,
    updates: [],
    closes: 0,
    open: false,
    update(trigger) {
      this.updates.push(trigger);
      this.open = true;
    },
    close() {
      this.closes += 1;
      this.open = false;
    },
    isOpen() {
      return this.open;
    },
    // Real pickers preventDefault + stopImmediatePropagation when consuming.
    handleKeydown: vi.fn((event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }),
  });

  beforeEach(() => {
    dom = new JSDOM(`<textarea id="input"></textarea>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    input = document.getElementById("input");
  });

  afterEach(() => {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.KeyboardEvent;
  });

  const keydown = (opts) =>
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { cancelable: true, ...opts }));

  test("routes the active trigger to exactly one picker", () => {
    const slash = makePicker("slash");
    const mention = makePicker("mention");
    createTriggerRouter({ input, pickers: [slash, mention] });

    input.value = "please /rev";
    input.setSelectionRange(11, 11);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(slash.updates).toHaveLength(1);
    expect(slash.updates[0]).toEqual({ kind: "slash", start: 7, end: 11, query: "rev" });
    expect(mention.closes).toBe(1);
    expect(slash.closes).toBe(0);
  });

  test("mention gets the trigger when the caret is in an @token", () => {
    const slash = makePicker("slash");
    const mention = makePicker("mention");
    createTriggerRouter({ input, pickers: [slash, mention] });

    input.value = "see @src/a";
    input.setSelectionRange(11, 11);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(mention.updates).toHaveLength(1);
    expect(slash.closes).toBe(1);
  });

  test("no active trigger closes both pickers", () => {
    const slash = makePicker("slash");
    const mention = makePicker("mention");
    createTriggerRouter({ input, pickers: [slash, mention] });

    input.value = "plain text";
    input.setSelectionRange(10, 10);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(slash.closes).toBe(1);
    expect(mention.closes).toBe(1);
    expect(slash.updates).toHaveLength(0);
  });

  test("keydown reaches only the open active picker; closed pickers untouched", () => {
    const slash = makePicker("slash");
    const mention = makePicker("mention");
    createTriggerRouter({ input, pickers: [slash, mention] });

    slash.open = true;
    input.value = "/rev";
    input.setSelectionRange(4, 4);
    keydown({ key: "ArrowDown" });
    expect(slash.handleKeydown).toHaveBeenCalledOnce();
    expect(mention.handleKeydown).not.toHaveBeenCalled();

    slash.handleKeydown.mockClear();
    slash.open = false;
    keydown({ key: "ArrowDown" });
    expect(slash.handleKeydown).not.toHaveBeenCalled();
  });

  test("IME composition keys fall through untouched", () => {
    const slash = makePicker("slash");
    createTriggerRouter({ input, pickers: [slash] });
    slash.open = true;
    input.value = "/rev";
    input.setSelectionRange(4, 4);
    keydown({ key: "Enter", isComposing: true });
    keydown({ key: "Enter", keyCode: 229 });
    expect(slash.handleKeydown).not.toHaveBeenCalled();
  });

  test("Enter falls through when no picker is open (send still fires)", () => {
    const slash = makePicker("slash");
    const mention = makePicker("mention");
    createTriggerRouter({ input, pickers: [slash, mention] });
    const send = vi.fn();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.defaultPrevented) send();
    });

    input.value = "hello";
    keydown({ key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
    expect(slash.handleKeydown).not.toHaveBeenCalled();

    // With the slash picker open the router consumes the key first.
    slash.open = true;
    input.value = "/rev";
    input.setSelectionRange(4, 4);
    keydown({ key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
    expect(slash.handleKeydown).toHaveBeenCalledOnce();
  });
});
