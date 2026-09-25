// ABOUTME: Browser tab renderer tests: the annotation round-trip against a
// ABOUTME: jsdom-backed eval bridge, including native pane visibility.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { createBrowserTabRenderer } from "./browser-tab-renderer.js";

const MESSAGES = {
  files: {
    browser: {
      annotate: "标注",
      annotateTooltip: "标注元素",
      refresh: "刷新",
      refreshTooltip: "重新加载",
      restartTooltip: "重启渲染",
      restartWatch: "重启渲染",
      loading: "加载中…",
      cannotOpen: "无法打开",
      pickHint: "点选页面元素，Esc 取消",
      selectorUnavailable: "选择器不可用",
      dialogTitle: "标注元素",
      dialogPlaceholder: "想让 agent 对这个元素做什么？",
      cancel: "取消",
      addToComposer: "加入输入框",
    },
  },
};

/** Mirror the host bridge: the pane evaluates the expression and Tauri
 * serializes the wrapper's JSON string into JSON again, so the wire carries a
 * JSON string containing a JSON envelope. */
function makeEvalTransport() {
  return vi.fn(async ({ js }) => {
    let value = null;
    try {
      value = new Function(`return (${js.trim()})`)();
    } catch {
      value = null;
    }
    const envelope = JSON.stringify({ ok: true, value: value ?? null });
    return JSON.stringify(envelope);
  });
}

function makeTransport() {
  return {
    browserPaneCreate: vi.fn(async () => ({})),
    browserPaneSetRect: vi.fn(async () => ({})),
    browserPaneSetVisible: vi.fn(async () => ({})),
    browserPaneDestroy: vi.fn(async () => ({})),
    browserPaneNavigate: vi.fn(async () => ({})),
    browserPaneEval: makeEvalTransport(),
    browserPaneUrl: vi.fn(async () => ({})),
    officecliWatchMark: vi.fn(async () => ({})),
  };
}

function makeTab() {
  return {
    id: "browser:/w/a.docx",
    kind: "browser",
    url: "http://127.0.0.1:41001/",
    filePath: "/w/a.docx",
    fileName: "a.docx",
  };
}

beforeEach(async () => {
  setMessages(MESSAGES);
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.__TAURI__ = { window: { getCurrentWindow: () => ({ label: "w" }) } };
  document.body.replaceChildren();
  const input = document.createElement("textarea");
  input.id = "message-input";
  document.body.append(input);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.__TAURI__;
  document.body.replaceChildren();
});

test("a picked element opens a dialog that names its docPath", async () => {
  vi.useFakeTimers();
  const transport = makeTransport();
  const container = document.createElement("div");
  document.body.append(container);
  const renderer = createBrowserTabRenderer({ tab: makeTab(), transport });
  renderer.mount(container);
  await vi.advanceTimersByTimeAsync(1);

  container.querySelector(".browser-pane-action").click();
  await vi.advanceTimersByTimeAsync(1);

  const anchor = document.createElement("div");
  anchor.setAttribute("data-path", "/slide[2]/shape[@id=7]");
  document.body.append(anchor);
  anchor.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(300);

  const card = document.getElementById("picot-annotation-card");
  expect(card?.textContent).toContain("/slide[2]/shape[@id=7]");
  // The card lives inside the pane page (the eval mock runs scripts against
  // this document), never in the host preview DOM.
  expect(container.querySelector(".browser-annotation-card")).toBeNull();
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.advanceTimersByTimeAsync(300);
  expect(document.getElementById("picot-annotation-card")).toBeNull();
  renderer.destroy();
});

test("the page card submits into the composer without hiding the page", async () => {
  vi.useFakeTimers();
  const transport = makeTransport();
  const container = document.createElement("div");
  document.body.append(container);
  const renderer = createBrowserTabRenderer({ tab: makeTab(), transport });
  renderer.mount(container);
  await vi.advanceTimersByTimeAsync(1);

  container.querySelector(".browser-pane-action").click();
  await vi.advanceTimersByTimeAsync(1);
  const anchor = document.createElement("div");
  anchor.setAttribute("data-path", "/slide[2]/shape[@id=7]");
  document.body.append(anchor);
  anchor.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(300);

  const card = document.getElementById("picot-annotation-card");
  card.querySelector("textarea").value = "字号大一点";
  [...card.querySelectorAll("button")].find((b) => b.textContent === "加入输入框").click();
  await vi.advanceTimersByTimeAsync(300);
  const input = document.getElementById("message-input");
  expect(input.value).toContain('<office-element file="a.docx">');
  expect(input.value).toContain("feedback: 字号大一点");

  // The page stays visible throughout: never hidden, never shrunk.
  expect(transport.browserPaneSetVisible).not.toHaveBeenCalledWith(
    expect.objectContaining({ visible: false }),
  );
  expect(transport.browserPaneSetRect).not.toHaveBeenCalled();
  renderer.destroy();
});
