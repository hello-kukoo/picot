import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import {
  activeAtMention,
  buildMentionCandidate,
  createHostFileMentionSearch,
  setupAtFileMention,
} from "./at-file-mention.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function setCaret(input, index) {
  input.setSelectionRange(index, index);
}

function canned(items) {
  return vi.fn(async () => ({ items, truncated: false }));
}

describe("at-file-mention", () => {
  let dom;
  let input;
  let container;

  beforeEach(async () => {
    dom = new JSDOM(`
      <textarea id="input"></textarea>
      <div id="popup" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.queueMicrotask = (callback) => callback();
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("input");
    container = document.getElementById("popup");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.queueMicrotask;
    delete globalThis.fetch;
  });

  test("recognizes an @ token only at a supported boundary", () => {
    input.value = "@src/a";
    setCaret(input, 6);
    expect(activeAtMention(input)).toEqual({ prefix: "@src/a", start: 0, end: 6 });

    input.value = "name@host";
    setCaret(input, 9);
    expect(activeAtMention(input)).toBeNull();

    input.value = "see @foo";
    setCaret(input, 8);
    expect(activeAtMention(input).prefix).toBe("@foo");

    // A space after the token closes it.
    input.value = "@foo bar";
    setCaret(input, 8);
    expect(activeAtMention(input)).toBeNull();
  });

  test("localizes the popup aria label from i18n", () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([]),
    });
    expect(container.getAttribute("aria-label")).toBe(enMessages.fileMention.listLabel);
    controller.destroy();
  });

  test("does not duplicate a closing quote that already follows the cursor", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        {
          value: '@"dir/file.ts"',
          label: "file.ts",
          description: "dir/file.ts",
          isDirectory: false,
        },
      ]),
    });
    // Cursor sits before an existing closing quote.
    input.value = '@"dir/f"';
    setCaret(input, 7);
    await controller.update();
    controller.select(0);
    // The existing closing quote is reused (no doubling); the file suffix still applies.
    expect(input.value).toBe('@"dir/file.ts" ');
    expect(input.value).not.toContain('""');
    controller.destroy();
  });

  test("falls back to direct replacement when setRangeText throws", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/a tail";
    setCaret(input, 6);
    input.setRangeText = () => {
      throw new Error("unsupported");
    };
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/a.ts  tail");
    expect(input.selectionStart).toBe("@src/a.ts ".length);
    controller.destroy();
  });

  test("closing the menu aborts the in-flight request", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () => resolve({ items: [], truncated: false });
        }),
    );
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    const pending = controller.update();
    controller.close();
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("keeps a quoted path with spaces active and never crosses a newline", () => {
    input.value = '@"my folder/f';
    setCaret(input, 14);
    expect(activeAtMention(input).prefix).toBe('@"my folder/f');

    input.value = "line one\n@src/a";
    setCaret(input, input.value.length);
    expect(activeAtMention(input).prefix).toBe("@src/a");

    input.value = "line one\n@src a";
    setCaret(input, input.value.length);
    expect(activeAtMention(input)).toBeNull();
  });

  test("inserts a file candidate with a trailing space and correct caret", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/a";
    setCaret(input, 6);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/a.ts ");
    expect(input.selectionStart).toBe("@src/a.ts ".length);
    controller.destroy();
  });

  test("inserts a directory candidate with no trailing space", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/", label: "src/", description: "src", isDirectory: true },
      ]),
    });
    input.value = "@sr";
    setCaret(input, 3);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe("@src/");
    controller.destroy();
  });

  test("leaves the caret inside a quoted directory so typing can continue", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: '@"my dir/"', label: "dir/", description: "my dir", isDirectory: true },
      ]),
    });
    input.value = '@"my d';
    setCaret(input, 6);
    await controller.update();
    controller.select(0);
    expect(input.value).toBe('@"my dir/"');
    // Caret sits one code unit before the closing quote.
    expect(input.selectionStart).toBe(input.value.length - 1);
    controller.destroy();
  });

  test("preserves any text after the replaced token and fires an input event", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@src/a.ts", label: "a.ts", description: "src/a.ts", isDirectory: false },
      ]),
    });
    input.value = "@src/axy";
    setCaret(input, 6); // cursor right after "@src/a", suffix "xy" is preserved
    await controller.update();
    const spy = vi.fn();
    input.addEventListener("input", spy);
    controller.select(0);
    expect(input.value).toBe("@src/a.ts xy");
    expect(spy).toHaveBeenCalled();
    controller.destroy();
  });

  test("cycles selection with arrows and closes on Escape", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a", label: "a", description: "a", isDirectory: false },
        { value: "@b", label: "b", description: "b", isDirectory: false },
        { value: "@c", label: "c", description: "c", isDirectory: false },
      ]),
    });
    input.value = "@";
    setCaret(input, 1);
    await controller.update();
    expect(container.classList.contains("hidden")).toBe(false);

    const down = new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    input.dispatchEvent(down);
    expect(input.getAttribute("aria-activedescendant")).toBe("popup-opt-1");
    const up = new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    input.dispatchEvent(up);
    expect(input.getAttribute("aria-activedescendant")).toBe("popup-opt-0");
    const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    input.dispatchEvent(esc);
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("Enter selects an open candidate instead of sending, and sends normally after close", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    const sendListener = vi.fn((event) => event.preventDefault());
    // Registered AFTER the mention controller, mirroring the composer send path.
    input.addEventListener("keydown", sendListener);

    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const enterOpen = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input.dispatchEvent(enterOpen);
    expect(sendListener).not.toHaveBeenCalled();
    expect(input.value).toBe("@a.ts ");

    // After selection the popup is closed, so Enter reaches the send listener.
    sendListener.mockClear();
    const enterClosed = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input.dispatchEvent(enterClosed);
    expect(sendListener).toHaveBeenCalled();
    controller.destroy();
  });

  test("Tab on an open menu inserts instead of traversing focus", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    const tabListener = vi.fn();
    input.addEventListener("keydown", tabListener);
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const tab = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true });
    input.dispatchEvent(tab);
    expect(tabListener).not.toHaveBeenCalled();
    expect(input.value).toBe("@a.ts ");
    controller.destroy();
  });

  test("does not consume keys during IME composition", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    const composing = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(input.value).toBe("@a"); // not inserted
    controller.destroy();
  });

  test("debounces the request and aborts a superseded one", async () => {
    let firstSignal = null;
    const searchFiles = vi.fn((_root, _query, signal) => {
      if (searchFiles.mock.calls.length === 1) firstSignal = signal;
      return Promise.resolve({ items: [], truncated: false });
    });
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(searchFiles).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(searchFiles).toHaveBeenCalledTimes(1);

    // A second keystroke supersedes and aborts the first in-flight request.
    input.value = "@ab";
    setCaret(input, 3);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstSignal.aborted).toBe(true);
    controller.destroy();
  });

  test("suppresses a stale response whose value or caret changed", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () =>
            resolve({
              items: [{ value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false }],
              truncated: false,
            });
        }),
    );
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    const pending = controller.update();
    // Mutate the textarea before the response lands.
    input.value = "@b";
    setCaret(input, 2);
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("looks up the workspace root live on every request", async () => {
    const getWorkspaceRoot = vi.fn(() => "/repo");
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot,
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    expect(getWorkspaceRoot).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  test("uses unique option ids across two controllers", async () => {
    const dom2 = new JSDOM(`<textarea id="i2"></textarea><div id="p2" class="hidden"></div>`);
    const input2 = dom2.window.document.getElementById("i2");
    const container2 = dom2.window.document.getElementById("p2");
    dom2.window.HTMLElement.prototype.scrollIntoView = vi.fn();

    const searchFiles = canned([
      { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
    ]);
    const c1 = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    const c2 = setupAtFileMention({
      input: input2,
      container: container2,
      document: dom2.window.document,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    await c1.update();
    input2.value = "@a";
    input2.setSelectionRange(2, 2);
    await c2.update();
    expect(container.querySelector(".at-file-mention-option").id).toBe("popup-opt-0");
    expect(container2.querySelector(".at-file-mention-option").id).toBe("p2-opt-0");
    c1.destroy();
    c2.destroy();
    dom2.window.close();
  });

  test("closes on blur and selects on click", async () => {
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles: canned([
        { value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false },
      ]),
    });
    input.value = "@a";
    setCaret(input, 2);
    await controller.update();
    input.dispatchEvent(new dom.window.Event("blur"));
    expect(container.classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  test("a pending response cannot mutate the DOM after destroy()", async () => {
    let resolveSearch;
    const searchFiles = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSearch = () =>
            resolve({
              items: [{ value: "@a.ts", label: "a.ts", description: "a.ts", isDirectory: false }],
              truncated: false,
            });
        }),
    );
    const controller = setupAtFileMention({
      input,
      container,
      getWorkspaceRoot: () => "/repo",
      searchFiles,
    });
    input.value = "@a";
    setCaret(input, 2);
    const pending = controller.update();
    controller.destroy();
    resolveSearch();
    await pending;
    expect(container.classList.contains("hidden")).toBe(true);
    expect(container.children.length).toBe(0);
  });
});

describe("host file-mention search", () => {
  test("maps workspace-relative entries onto absolute mention candidates", async () => {
    const transport = {
      fileMentions: vi.fn(async () => ({
        operation: "file_mentions",
        entries: [
          { name: "a.ts", relativePath: "src/a.ts", kind: "file" },
          { name: "pkg", relativePath: "src/pkg", kind: "directory" },
          { name: "b md", relativePath: "docs/b md", kind: "file" },
        ],
      })),
    };
    const search = createHostFileMentionSearch(() => transport);

    const result = await search("/repo/", "a");

    // Pi TUI mention semantics are absolute paths; directories keep the trailing
    // slash and paths with spaces are quoted so the token stays whole.
    expect(transport.fileMentions).toHaveBeenCalledWith("a");
    expect(result.items).toEqual([
      {
        value: "@/repo/src/a.ts",
        label: "a.ts",
        description: "/repo/src/a.ts",
        isDirectory: false,
      },
      {
        value: "@/repo/src/pkg/",
        label: "pkg/",
        description: "/repo/src/pkg",
        isDirectory: true,
      },
      {
        value: `@"/repo/docs/b md"`,
        label: "b md",
        description: "/repo/docs/b md",
        isDirectory: false,
      },
    ]);
  });

  test("returns an empty list when the transport or workspace root is unavailable", async () => {
    // Ephemeral runtimes clear their transport on teardown; the search must
    // degrade to no candidates instead of throwing inside the popup.
    const search = createHostFileMentionSearch(() => null);

    await expect(search("/repo", "a")).resolves.toEqual({ items: [] });
    await expect(createHostFileMentionSearch(() => ({}))("/repo", "a")).resolves.toEqual({
      items: [],
    });
  });

  test("candidate label uses the basename even for nested paths", () => {
    expect(buildMentionCandidate("/repo/src/deep/file.rs", false)).toMatchObject({
      value: "@/repo/src/deep/file.rs",
      label: "file.rs",
      isDirectory: false,
    });
  });
});
