import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const styleCss = [
  "public/style.css",
  "public/native/header.css",
  "public/native/workspace/file-preview-panel.css",
]
  .map((path) => readFileSync(resolve(path), "utf8"))
  .join("\n");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[2] ?? "";
}

describe("workspace header layout", () => {
  test("keeps left metadata fixed and right file controls scrolling independently", () => {
    expect(ruleBody(".header")).toContain("display: flex");
    expect(ruleBody(".header-left")).toContain("flex: 0 0 auto");
    expect(ruleBody(".header-left")).toContain("min-width: max-content");
    expect(styleCss).toMatch(/\.header-right\s*\{[^}]*justify-content:\s*flex-end/s);
  });

  test("keeps the remote access shortcut in the non-scrolling header left", () => {
    const html = readFileSync(resolve("public/index.html"), "utf8");
    const left = html.match(/<div class="header-left">([\s\S]*?)<div class="header-right">/)?.[1];
    expect(left).toContain('id="remote-access-header-btn"');
  });
});
