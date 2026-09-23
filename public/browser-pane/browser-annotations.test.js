// ABOUTME: Browser annotation attachment tests (spec 2026-09-22): both
// ABOUTME: formatted blocks, the dialog flow, and composer appension.

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendAttachmentToComposer,
  formatBrowserElementAttachment,
  formatOfficeElementAttachment,
  openAnnotationDialog,
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

test("dialog resolves with the comment and honours cancel", async () => {
  const dialogPromise = openAnnotationDialog({ docPath: "/body/p[2]", url: "http://x/" });
  const textarea = document.querySelector(".browser-annotation-input");
  expect(textarea).toBeTruthy();
  textarea.value = "加粗这一段";
  document.querySelector(".file-preview-dialog-button.primary").click();
  await expect(dialogPromise).resolves.toBe("加粗这一段");

  const cancelled = openAnnotationDialog({ url: "http://x/" });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect(cancelled).resolves.toBeNull();
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
