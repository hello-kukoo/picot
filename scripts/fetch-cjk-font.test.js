// ABOUTME: Verifies the CJK font lockfile and fetch CLI.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("CJK font distribution", () => {
  test("pins the LXGW WenKai Lite release and its checksum", () => {
    const lock = JSON.parse(read("scripts/cjk-font-version.json"));

    expect(lock.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(lock.sourceFile).toBe("LXGWWenKaiLite-Regular.ttf");
    expect(lock.sha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(lock.sourceUrl).toMatch(/^https:\/\//);
    expect(lock.licenseUrl).toMatch(/^https:\/\//);
    expect(lock.outputFiles).toEqual(["LXGWWenKaiLite-Regular.woff2"]);
    expect(typeof lock.approxBytes).toBe("number");
    expect(lock.sizeCapBytes).toBeGreaterThan(1_000_000);
    expect(lock.licenseUrl).toContain("/v1.522/");
    expect(lock.licenseSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fetch CLI converts the verified TTF to WOFF2 via ttf2woff2", () => {
    const src = read("scripts/fetch-cjk-font.js");

    expect(src).toContain("ttf2woff2");
    expect(src).toContain("woff2");
    expect(src).toContain("sha256");
    expect(src).toContain("approxBytes");
    expect(src).toContain("sizeCapBytes");
    expect(src).toContain("Open Font License");
  });

  test("fetches the CJK font before Tauri dev and distributable builds", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.dev).toContain("fetch:cjk-font");
    expect(pkg.scripts.prebuild).toContain("fetch:cjk-font");

    expect(read("src-tauri/tauri.conf.json")).toContain("fetch:cjk-font");
    expect(read("scripts/build.sh")).toContain("fetch-cjk-font.js");
    expect(read("scripts/release-macos-dmg.sh")).toContain("fetch-cjk-font.js");
    expect(read(".github/workflows/release.yml")).toContain("cjk-font-version.json");
    expect(read(".gitignore")).toContain("public/fonts/cjk/");
    expect(read(".gitignore")).toContain(".cache/cjk-fonts/");
  });

  test("declares the CJK web font and scopes it to content surfaces", () => {
    const css = read("public/style.css");
    const flat = css.replace(/\s+/g, " ");

    // @font-face declaration
    expect(flat).toContain('"Picot CJK"');
    expect(flat).toContain("LXGWWenKaiLite-Regular.woff2");
    expect(flat).toContain("U+3000-303F, U+4E00-9FFF, U+FF00-FFEF");

    // selectors scoped to content surfaces
    expect(flat).toContain(".message.assistant .message-content");
    expect(flat).toContain(".message.user .message-content");
    expect(flat).toContain(".file-markdown-preview");

    // body keeps its own system stack and is NOT given the CJK face
    const bodyBlock = (css.match(/body\s*\{[^}]*font-family[^}]*\}/) || [""])[0];
    expect(bodyBlock).toContain("-apple-system");
    expect(bodyBlock).not.toContain("Picot CJK");

    // Picot CJK is first for CJK; unicode-range makes ASCII fall through to
    // the unchanged system stack. Extract this exact rule to guard ordering.
    const contentBlock = (css.match(
      /\.message\.assistant \.message-content,\s*\.message\.user \.message-content,\s*\.file-markdown-preview\s*\{[^}]*\}/,
    ) || [""])[0];
    expect(contentBlock).toContain('"Picot CJK"');
    expect(contentBlock).toContain(".message.user .message-content");
    expect(contentBlock.indexOf('"Picot CJK"')).toBeLessThan(contentBlock.indexOf("-apple-system"));
    expect(flat).toContain(
      '"Picot CJK", -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue"',
    );
  });
});
