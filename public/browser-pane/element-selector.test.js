// ABOUTME: Element selector tests (spec 2026-09-22): script behavior in
// ABOUTME: jsdom, data-path capture, and the controller's token/timeout flow.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildElementSelectorScript, createElementSelectorController } from "./element-selector.js";

/** Execute the built IIFE expression against this jsdom document.
 * `new Function` rather than eval: same expression semantics, and the
 * selector string under test is the same one the pane bridge ships. */
function runScriptExpression(code) {
  // Trim + parens: `return \n(function…)` would trip ASI and return
  // undefined; the wrapper keeps the expression on the return's line.
  return new Function(`return (${code.trim()})`)();
}

function installScript(token = "t1") {
  return runScriptExpression(buildElementSelectorScript(token));
}

function clickElement(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  window.__picotSelector = null;
  window.__picotSelectorResult = null;
  // jsdom does not implement innerText (the capture field's source); map it
  // to textContent so captured text asserts like a real webview.
  if (!("innerText" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent;
      },
      set(value) {
        this.textContent = value;
      },
    });
  }
});

afterEach(() => {
  window.__picotSelector?.destroy?.();
  window.__picotSelector = null;
  window.__picotSelectorResult = null;
  document.documentElement.className = "";
  document.querySelectorAll(".__picot-hover-label").forEach((el) => {
    el.remove();
  });
  document.querySelectorAll("style").forEach((el) => {
    el.remove();
  });
});

test("installs select mode and reports the session token", () => {
  const result = installScript("tok-1");
  expect(result.installed).toBe(true);
  expect(result.sessionToken).toBe("tok-1");
  expect(document.documentElement.classList.contains("__picot-select-mode")).toBe(true);
});

test("does not cancel pointer events before the browser dispatches click", () => {
  installScript("tok-pointer");
  const el = document.createElement("p");
  document.body.append(el);
  const down = new Event("pointerdown", { bubbles: true, cancelable: true });
  const up = new Event("pointerup", { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  el.dispatchEvent(up);
  expect(down.defaultPrevented).toBe(false);
  expect(up.defaultPrevented).toBe(false);
  el.remove();
});

test("captures clicked element fields including docPath from data-path anchor", () => {
  installScript("tok-2");
  const anchor = document.createElement("div");
  anchor.setAttribute("data-path", "/body/p[4]");
  const child = document.createElement("span");
  child.textContent = "第三季度营收分析";
  anchor.appendChild(child);
  document.body.append(anchor);
  clickElement(child);
  const result = window.__picotSelectorResult;
  expect(result).toBeTruthy();
  expect(result.__picotSessionToken).toBe("tok-2");
  expect(result.docPath).toBe("/body/p[4]");
  expect(result.tag).toBe("span");
  expect(result.text).toContain("第三季度营收分析");
  expect(result.selector).toContain("span");
  expect(typeof result.boundingRect.width).toBe("number");
  expect(Array.isArray(result.parentChain)).toBe(true);
  // Capture mode tears down immediately after one pick.
  expect(document.documentElement.classList.contains("__picot-select-mode")).toBe(false);
  anchor.remove();
});

test("docPath is null on pages without data-path anchors", () => {
  installScript("tok-3");
  const el = document.createElement("p");
  document.body.appendChild(el);
  clickElement(el);
  expect(window.__picotSelectorResult.docPath).toBe(null);
  el.remove();
});

test("Escape cancels and leaves a cancellation marker", () => {
  installScript("tok-4");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(window.__picotSelectorResult).toEqual({
    __cancelled: true,
    __picotSessionToken: "tok-4",
  });
  expect(document.documentElement.classList.contains("__picot-select-mode")).toBe(false);
});

function makeAdapter(scriptRuns = true) {
  return {
    isConnected: () => true,
    executeJavaScript: vi.fn(async (code) => {
      if (!scriptRuns) return null;
      // Execute the IIFE and read the result the way the poll does.
      if (code.includes("__picotSelectorResult")) {
        const raw = runScriptExpression(code);
        return raw ? { ...raw } : null;
      }
      if (code.trim().startsWith("(function()")) {
        return runScriptExpression(code);
      }
      return null;
    }),
  };
}

test("controller resolves a selection end to end", async () => {
  vi.useFakeTimers();
  try {
    const adapter = makeAdapter();
    const controller = createElementSelectorController({ webviewAdapter: adapter });
    const outcomes = [];
    controller.start({ onFinish: (outcome) => outcomes.push(outcome) });

    // Install completed synchronously; simulate the page-side pick.
    const anchor = document.createElement("div");
    anchor.setAttribute("data-path", "/body/p[1]");
    document.body.appendChild(anchor);
    clickElement(anchor);

    await vi.advanceTimersByTimeAsync(250);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe("selected");
    expect(outcomes[0].selection.docPath).toBe("/body/p[1]");
    anchor.remove();
  } finally {
    vi.useRealTimers();
  }
});

test("controller fails with timeout when nothing is picked", async () => {
  vi.useFakeTimers();
  try {
    const adapter = makeAdapter();
    const controller = createElementSelectorController({ webviewAdapter: adapter });
    const outcomes = [];
    controller.start({ onFinish: (outcome) => outcomes.push(outcome) });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ type: "failed", reason: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});
