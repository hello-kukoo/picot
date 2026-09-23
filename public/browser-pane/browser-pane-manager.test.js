// ABOUTME: Browser pane manager tests (spec 2026-09-22): pane lifecycle and
// ABOUTME: rect sync against a stubbed transport.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  closePane,
  evalPane,
  hideAllPanes,
  navigatePane,
  openPane,
  paneUrl,
  paneVisible,
  showPane,
  syncPane,
} from "./browser-pane-manager.js";

function makeTransport() {
  return {
    browserPaneCreate: vi.fn(async () => ({})),
    browserPaneSetRect: vi.fn(async () => ({})),
    browserPaneSetVisible: vi.fn(async () => ({})),
    // new Function instead of eval: same expression semantics without the
    // lint block; the parens keep ASI from swallowing the return.
    browserPaneEval: vi.fn(async ({ js }) => ({
      result: JSON.stringify({ ok: true, value: new Function(`return (${js})`)() }),
    })),
    browserPaneNavigate: vi.fn(async () => ({})),
    browserPaneDestroy: vi.fn(async () => ({})),
  };
}

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.__TAURI__ = { window: { getCurrentWindow: () => ({ label: "native-workspace-w1" }) } };
});

afterEach(() => {
  delete window.__TAURI__;
});

test("openPane creates the child webview at the container rect", async () => {
  const transport = makeTransport();
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", {
    value: () => ({ x: 300, y: 40, width: 480, height: 620 }),
  });
  await openPane({ paneId: "p1", url: "http://127.0.0.1:41001/", container, transport });
  expect(transport.browserPaneCreate).toHaveBeenCalledWith({
    paneId: "native-workspace-w1:p1",
    windowLabel: "native-workspace-w1",
    url: "http://127.0.0.1:41001/",
    x: 300,
    y: 40,
    width: 480,
    height: 620,
  });
});

test("show/hide toggles transport visibility only on change", async () => {
  const transport = makeTransport();
  const container = document.createElement("div");
  await openPane({ paneId: "p2", url: "http://x/", container, transport });
  showPane("p2", true);
  showPane("p2", true);
  expect(transport.browserPaneSetVisible).toHaveBeenCalledTimes(1);
  showPane("p2", false);
  expect(transport.browserPaneSetVisible).toHaveBeenCalledWith({
    paneId: "native-workspace-w1:p2",
    visible: false,
  });
  expect(paneVisible("p2")).toBe(false);
});

test("closePane destroys the webview exactly once", async () => {
  const transport = makeTransport();
  const container = document.createElement("div");
  await openPane({ paneId: "p3", url: "http://x/", container, transport });
  closePane("p3");
  closePane("p3");
  expect(transport.browserPaneDestroy).toHaveBeenCalledTimes(1);
  showPane("p3", true);
  expect(transport.browserPaneSetVisible).not.toHaveBeenCalled();
});

test("navigatePane updates the tracked url; evalPane round-trips values", async () => {
  const transport = makeTransport();
  const container = document.createElement("div");
  await openPane({ paneId: "p4", url: "http://old/", container, transport });
  await navigatePane("p4", "http://127.0.0.1:41002/", transport);
  expect(paneUrl("p4")).toBe("http://127.0.0.1:41002/");
  const value = await evalPane("p4", "({ docPath: '/body/p[1]' })", transport);
  expect(value).toEqual({ docPath: "/body/p[1]" });
});

test("evalPane decodes Tauri's JSON-serialized string result", async () => {
  const transport = makeTransport();
  transport.browserPaneEval = vi.fn(async () => ({
    result: JSON.stringify(JSON.stringify({ ok: true, value: { docPath: "/body/p[4]" } })),
  }));
  const container = document.createElement("div");
  await openPane({ paneId: "p-native-eval", url: "http://x/", container, transport });
  await expect(
    evalPane("p-native-eval", "window.__picotSelectorResult", transport),
  ).resolves.toEqual({
    docPath: "/body/p[4]",
  });
  closePane("p-native-eval");
});

test("evalPane surfaces runtime errors from the wrapper envelope", async () => {
  const transport = makeTransport();
  transport.browserPaneEval = vi.fn(async () => ({
    result: JSON.stringify({ ok: false, error: "ReferenceError: x is not defined" }),
  }));
  const container = document.createElement("div");
  await openPane({ paneId: "p5", url: "http://x/", container, transport });
  await expect(evalPane("p5", "x", transport)).rejects.toThrow("ReferenceError");
});

test("a failed create leaves no entry behind (later opens retry)", async () => {
  const transport = makeTransport();
  transport.browserPaneCreate = vi.fn(async () => {
    throw new Error("url_not_allowed");
  });
  const container = document.createElement("div");
  await expect(
    openPane({ paneId: "p6", url: "http://127.0.0.1:41000/", container, transport }),
  ).rejects.toThrow("url_not_allowed");
  // The pane must be retryable: a second attempt reaches the transport again.
  transport.browserPaneCreate = vi.fn(async () => ({}));
  await openPane({ paneId: "p6", url: "http://ok/", container, transport });
  expect(transport.browserPaneCreate).toHaveBeenCalledTimes(1);
});

test("an unknown window label fails loudly instead of colliding", async () => {
  delete window.__TAURI__;
  const transport = makeTransport();
  const container = document.createElement("div");
  await expect(openPane({ paneId: "p7", url: "http://x/", container, transport })).rejects.toThrow(
    "window_label_unavailable",
  );
  expect(transport.browserPaneCreate).not.toHaveBeenCalled();
});

test("reopening a pane id rebinds it to its new container rect", async () => {
  const transport = makeTransport();
  const first = document.createElement("div");
  Object.defineProperty(first, "getBoundingClientRect", {
    value: () => ({ x: 10, y: 20, width: 300, height: 400 }),
  });
  const second = document.createElement("div");
  Object.defineProperty(second, "getBoundingClientRect", {
    value: () => ({ x: 100, y: 200, width: 500, height: 600 }),
  });
  await openPane({ paneId: "p-rebind", url: "http://x/", container: first, transport });
  showPane("p-rebind", false);
  await openPane({ paneId: "p-rebind", url: "http://x/", container: second, transport });
  expect(transport.browserPaneSetRect).toHaveBeenCalledWith({
    paneId: "native-workspace-w1:p-rebind",
    x: 100,
    y: 200,
    width: 500,
    height: 600,
  });
  closePane("p-rebind");
});

test("hideAllPanes hides every visible native webview", async () => {
  const transport = makeTransport();
  await openPane({
    paneId: "p-hide-1",
    url: "http://x/",
    container: document.createElement("div"),
    transport,
  });
  await openPane({
    paneId: "p-hide-2",
    url: "http://x/",
    container: document.createElement("div"),
    transport,
  });
  showPane("p-hide-1", true);
  showPane("p-hide-2", true);
  hideAllPanes();
  expect(transport.browserPaneSetVisible).toHaveBeenCalledWith({
    paneId: "native-workspace-w1:p-hide-1",
    visible: false,
  });
  expect(transport.browserPaneSetVisible).toHaveBeenCalledWith({
    paneId: "native-workspace-w1:p-hide-2",
    visible: false,
  });
  closePane("p-hide-1");
  closePane("p-hide-2");
});

test("syncPane pushes the current container rect after a layout transition", async () => {
  const transport = makeTransport();
  let rect = { x: 300, y: 40, width: 480, height: 620 };
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", { value: () => rect });
  await openPane({ paneId: "p-sync", url: "http://x/", container, transport });
  rect = { x: 900, y: 80, width: 980, height: 900 };
  await syncPane("p-sync");
  expect(transport.browserPaneSetRect).toHaveBeenLastCalledWith({
    paneId: "native-workspace-w1:p-sync",
    x: 900,
    y: 80,
    width: 980,
    height: 900,
  });
  closePane("p-sync");
});
