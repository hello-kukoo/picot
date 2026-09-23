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

  const meta = document.querySelector(".browser-annotation-meta");
  expect(meta?.textContent).toContain("/slide[2]/shape[@id=7]");
  // Inline in the pane's own area — not a window-wide modal.
  expect(container.querySelector(".browser-annotation-input")).toBeTruthy();
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();
  renderer.destroy();
});

test("the composer shortens the pane instead of hiding the page", async () => {
  vi.useFakeTimers();
  const box = (width, height) => ({
    x: 0,
    y: 100,
    width,
    height,
    top: 100,
    bottom: 100 + height,
    left: 0,
    right: width,
  });
  // jsdom has no layout: give the pane target and the composer real boxes.
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains("browser-pane-content")) return box(400, 600);
    if (this.classList?.contains("browser-annotation-card")) return box(360, 180);
    return originalRect.call(this);
  };
  const transport = makeTransport();
  const container = document.createElement("div");
  document.body.append(container);
  const renderer = createBrowserTabRenderer({ tab: makeTab(), transport });
  renderer.mount(container);
  await vi.advanceTimersByTimeAsync(1);
  const paneKey = "w:browser:/w/a.docx";

  container.querySelector(".browser-pane-action").click();
  await vi.advanceTimersByTimeAsync(1);
  const anchor = document.createElement("div");
  anchor.setAttribute("data-path", "/slide[2]/shape[@id=7]");
  document.body.append(anchor);
  anchor.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(300);

  // The page stays visible — the pane only gives up the composer's height.
  expect(transport.browserPaneSetVisible).not.toHaveBeenCalledWith({
    paneId: paneKey,
    visible: false,
  });
  expect(transport.browserPaneSetRect).toHaveBeenLastCalledWith({
    paneId: paneKey,
    x: 0,
    y: 100,
    width: 400,
    height: 420,
  });

  document.querySelector(".file-preview-dialog-button.primary").click();
  await vi.advanceTimersByTimeAsync(1);
  expect(transport.browserPaneSetRect).toHaveBeenLastCalledWith({
    paneId: paneKey,
    x: 0,
    y: 100,
    width: 400,
    height: 600,
  });
  renderer.destroy();
  Element.prototype.getBoundingClientRect = originalRect;
});
