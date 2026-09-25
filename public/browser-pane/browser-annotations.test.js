// ABOUTME: Browser annotation attachment tests (spec 2026-09-22): both
// ABOUTME: formatted blocks, the dialog flow, and composer appension.

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendAttachmentToComposer,
  buildPageAnnotationScript,
  formatBrowserElementAttachment,
  formatOfficeElementAttachment,
  openPageAnnotationDialog,
} from "./browser-annotations.js";

const baseSelection = {
  tag: "span",
  text: "第三季度营收分析",
  selector: "div > span",
  url: "http://127.0.0.1:41001/",
  outerHTML: '<span style="font-size:24pt">第三季度营收分析</span>',
  computedStyles: {
    "font-size": "24pt",
    color: "rgb(0, 0, 0)",
    display: "inline",
  },
  boundingRect: { x: 10, y: 20, width: 320, height: 40 },
  reactSource: null,
  parentChain: ["body", "div#doc", "div[data-path]"],
  children: [],
};

beforeEach(() => {
  const input = document.createElement("textarea");
  input.id = "message-input";
  document.body.appendChild(input);
});

afterEach(() => {
  document.getElementById("message-input")?.remove();
});

test("office format carries the executable docPath coordinate", () => {
  const block = formatOfficeElementAttachment(
    { ...baseSelection, docPath: "/body/p[4]" },
    "字号改大",
    "报告.docx",
  );
  expect(block).toContain('<office-element file="报告.docx">');
  expect(block).toContain("path: /body/p[4]");
  expect(block).toContain('selector: [data-path="/body/p[4]"]');
  expect(block).toContain("feedback: 字号改大");
  expect(block).toContain("suggested: officecli set 报告.docx /body/p[4] --prop");
  expect(block).toContain("font-size: 24pt");
  expect(block).toContain("</office-element>");
});

test("browser format matches Paseo field density", () => {
  const block = formatBrowserElementAttachment(
    {
      ...baseSelection,
      reactSource: { fileName: "App.tsx", lineNumber: 42, componentName: "Header" },
    },
    "这个按钮对不齐",
  );
  expect(block).toContain('<browser-element url="http://127.0.0.1:41001/">');
  expect(block).toContain("source: Header @ App.tsx:42");
  expect(block).toContain("selector: div > span");
  expect(block).toContain("size: 320x40");
  expect(block).toContain("parents: body > div#doc > div[data-path]");
  expect(block).toContain("feedback: 这个按钮对不齐");
  expect(block).toContain("html: <span");
  expect(block).toContain("</browser-element>");
});

test("the injected page card submits a comment and cancels on Escape", async () => {
  const run = (script) => new Function(`return (${script})`)();
  const script = buildPageAnnotationScript({
    title: "标注元素",
    meta: "/body/p[1] — http://x/",
    placeholder: "想让 agent 对这个元素做什么？",
    cancelLabel: "取消",
    submitLabel: "加入输入框",
    accent: "#aa3344",
  });
  run(script);
  const card = document.getElementById("picot-annotation-card");
  expect(card).toBeTruthy();
  expect(card.textContent).toContain("/body/p[1] — http://x/");
  const primary = [...card.querySelectorAll("button")].find((b) => b.textContent === "加入输入框");
  expect(primary.style.backgroundColor).toBe("rgb(170, 51, 68)");
  const input = card.querySelector("textarea");
  expect(document.activeElement).toBe(input);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(window.__picotAnnotationResult).toEqual({ comment: null });
  expect(document.getElementById("picot-annotation-card")).toBeNull();

  window.__picotAnnotationResult = undefined;
  run(script);
  const card2 = document.getElementById("picot-annotation-card");
  card2.querySelector("textarea").value = "字号大一点";
  [...card2.querySelectorAll("button")].find((b) => b.textContent === "加入输入框").click();
  expect(window.__picotAnnotationResult).toEqual({ comment: "字号大一点" });
  window.__picotAnnotationResult = undefined;
  document.getElementById("picot-annotation-card")?.remove();
});

test("openPageAnnotationDialog polls the page marker until it settles", async () => {
  const calls = [];
  const evaluate = async (_paneId, expression) => {
    calls.push(expression.slice(0, 40));
    if (expression.includes("picot-annotation-card")) return "ok";
    if (calls.length === 2) return "pending";
    if (calls.length === 3) return "gone";
    return { comment: "好" };
  };
  const comment = await openPageAnnotationDialog({
    paneId: "p",
    evaluate,
    docPath: "/body/p[1]",
    url: "http://x/",
  });
  expect(comment).toBeNull();
  const calls2 = [];
  const evaluate2 = async (_paneId, expression) => {
    calls2.push(1);
    if (expression.includes("picot-annotation-card")) return "ok";
    if (calls2.length < 3) return "pending";
    return "好";
  };
  const comment2 = await openPageAnnotationDialog({
    paneId: "p",
    evaluate: evaluate2,
    url: "http://x/",
  });
  expect(comment2).toBe("好");
});

test("appendAttachmentToComposer appends with separation and focuses", () => {
  const input = document.getElementById("message-input");
  input.value = "帮我看下这段";
  const ok = appendAttachmentToComposer(
    '<office-element file="a.docx">\n  path: /body/p[1]\n</office-element>',
  );
  expect(ok).toBe(true);
  expect(input.value).toContain("帮我看下这段");
  expect(input.value).toContain("path: /body/p[1]");
  expect(document.activeElement).toBe(input);
});
