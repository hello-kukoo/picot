import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHtmlRenderer, HTML_IFRAME_SANDBOX } from "./file-preview-html.js";
import { initI18n } from "./i18n.js";

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          files: { preview: { htmlLive: "Live HTML preview" } },
        }),
    });
  await initI18n();
});

let container;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (container?.parentNode) container.parentNode.removeChild(container);
});

describe("createHtmlRenderer", () => {
  test("preview mode mounts a sandboxed iframe with srcdoc", () => {
    const renderer = createHtmlRenderer({
      filePath: "index.html",
      content: "<h1>Hello</h1>",
      mode: "preview",
    });
    renderer.mount(container);
    const iframe = container.querySelector("iframe.file-html-frame");
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe(HTML_IFRAME_SANDBOX);
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.srcdoc).toBe("<h1>Hello</h1>");
    expect(iframe.title).toBe("Live HTML preview");
    renderer.destroy();
  });

  test("update replaces srcdoc so the preview hot-reloads", () => {
    const renderer = createHtmlRenderer({
      filePath: "index.html",
      content: "<p>one</p>",
      mode: "preview",
    });
    renderer.mount(container);
    renderer.update({ content: "<p>two</p>" });
    expect(container.querySelector("iframe").srcdoc).toBe("<p>two</p>");
    renderer.destroy();
  });

  test("edit mode uses CodeMirror and getValue returns the source", () => {
    const renderer = createHtmlRenderer({
      filePath: "index.html",
      content: "<p>edit me</p>",
      mode: "edit",
    });
    renderer.mount(container);
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(renderer.getValue()).toBe("<p>edit me</p>");
    renderer.destroy();
  });

  test("destroy removes the iframe", () => {
    const renderer = createHtmlRenderer({
      filePath: "index.html",
      content: "<p>x</p>",
    });
    renderer.mount(container);
    renderer.destroy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
