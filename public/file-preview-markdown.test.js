import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { attachCopyButtonDelegation, renderFileMarkdown } from "./file-preview-markdown.js";

// Ensure i18n is initialized so renderMarkdown() has its translations.
import { initI18n } from "./i18n.js";

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = (_url) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          app: { welcome: "Welcome" },
          messages: { copy: "Copy", copied: "Copied!" },
          files: { loading: "Loading…" },
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
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
});

describe("renderFileMarkdown", () => {
  test("renders headings", () => {
    const frag = renderFileMarkdown("# Title\n\n## Subtitle");
    container.appendChild(frag);
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("h2")).not.toBeNull();
  });

  test("renders emphasis (bold, italic)", () => {
    const frag = renderFileMarkdown("**bold** and *italic*");
    container.appendChild(frag);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("em")).not.toBeNull();
  });

  test("renders lists", () => {
    const frag = renderFileMarkdown("- item1\n- item2\n");
    container.appendChild(frag);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  test("renders task checkboxes as disabled", () => {
    const frag = renderFileMarkdown("- [x] done\n- [ ] todo\n");
    container.appendChild(frag);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    for (const cb of checkboxes) {
      expect(cb.hasAttribute("disabled")).toBe(true);
    }
  });

  test("renders tables with safe text-align", () => {
    const frag = renderFileMarkdown("| Col1 | Col2 |\n|:------|:-----:|\n| a | b |\n");
    container.appendChild(frag);
    expect(container.querySelector("table")).not.toBeNull();
  });

  test("renders blockquotes", () => {
    const frag = renderFileMarkdown("> quoted text\n");
    container.appendChild(frag);
    expect(container.querySelector("blockquote")).not.toBeNull();
  });

  test("renders code blocks", () => {
    const frag = renderFileMarkdown("```js\nconsole.log(1);\n```\n");
    container.appendChild(frag);
    expect(container.querySelector("pre code")).not.toBeNull();
  });

  test("renders safe links", () => {
    const frag = renderFileMarkdown("[Example](https://example.com)");
    container.appendChild(frag);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com");
  });

  test("renders safe images", () => {
    const frag = renderFileMarkdown("![Alt](https://example.com/img.png)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  test("removes script tags", () => {
    const frag = renderFileMarkdown("# Title\n\n<script>alert('xss')</script>\n");
    container.appendChild(frag);
    expect(container.querySelector("script")).toBeNull();
  });

  test("removes iframe tags", () => {
    const frag = renderFileMarkdown('# Title\n\n<iframe src="https://evil.com"></iframe>\n');
    container.appendChild(frag);
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("removes javascript: protocol links", () => {
    // renderMarkdown might not produce these directly, but test the sanitizer.
    const frag = renderFileMarkdown("[click](javascript:alert(1))");
    container.appendChild(frag);
    const link = container.querySelector("a");
    if (link) {
      // The href should have been stripped or rendered safe.
      const href = link.getAttribute("href");
      expect(href === null || !href.startsWith("javascript:")).toBe(true);
    }
  });

  test("removes unsafe data: URIs from images (non-image types)", () => {
    const frag = renderFileMarkdown("![Alt](data:text/html,<script>alert(1)</script>)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    if (img) {
      const src = img.getAttribute("src");
      expect(src === null || !src.startsWith("data:text/html")).toBe(true);
    }
  });

  test("allows data:image/* in images", () => {
    const frag = renderFileMarkdown("![Alt](data:image/png;base64,iVBORw0KGgo=)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("removes inline event-handler attributes", () => {
    const frag = renderFileMarkdown('# Title\n\n<div onclick="alert(1)">text</div>\n');
    container.appendChild(frag);
    const div = container.querySelector("div");
    if (div) {
      expect(div.hasAttribute("onclick")).toBe(false);
    }
  });

  test("copy button delegation works after mount", () => {
    const frag = renderFileMarkdown("```js\nconsole.log('hello');\n```\n");
    container.appendChild(frag);
    const cleanup = attachCopyButtonDelegation(container);

    const btn = container.querySelector(".copy-btn");
    expect(btn).not.toBeNull();
    // The button should NOT have an inline onclick handler.
    expect(btn.hasAttribute("onclick")).toBe(false);

    cleanup();
  });
});
