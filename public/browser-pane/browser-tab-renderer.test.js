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

  const dialog = document.querySelector(".browser-annotation-meta");
  expect(dialog?.textContent).toContain("/slide[2]/shape[@id=7]");
  renderer.destroy();
});

test("the native pane hides while the dialog is open and returns after", async () => {
  vi.useFakeTimers();
  const transport = makeTransport();
  const container = document.createElement("div");
  document.body.append(container);
  const renderer = createBrowserTabRenderer({ tab: makeTab(), transport });
  renderer.mount(container);
  await vi.advanceTimersByTimeAsync(1);
  const paneKey = "w:browser:/w/a.docx";
  expect(transport.browserPaneSetVisible).toHaveBeenLastCalledWith({
    paneId: paneKey,
    visible: true,
  });

  container.querySelector(".browser-pane-action").click();
  await vi.advanceTimersByTimeAsync(1);
  const anchor = document.createElement("div");
  anchor.setAttribute("data-path", "/slide[1]/shape[@id=6]");
  document.body.append(anchor);
  anchor.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(300);

  // A host-DOM modal cannot paint over the OS-level child webview, so the
  // pane must be hidden for as long as the dialog is up.
  expect(transport.browserPaneSetVisible).toHaveBeenLastCalledWith({
    paneId: paneKey,
    visible: false,
  });

  document.querySelector(".file-preview-dialog-button.primary").click();
  await vi.advanceTimersByTimeAsync(1);
  expect(transport.browserPaneSetVisible).toHaveBeenLastCalledWith({
    paneId: paneKey,
    visible: true,
  });
  renderer.destroy();
});
