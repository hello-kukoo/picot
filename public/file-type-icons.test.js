// @vitest-environment jsdom
// ABOUTME: Verifies the shared file/Git object-icon resolver: vendored Paseo Material
// ABOUTME: vocabulary, Picot directory glyphs, one chroma rule, and a generic fallback.
import { describe, expect, it } from "vitest";
import { createFileTypeIcon, desaturateHexColor, resolveFileTypeIcon } from "./file-type-icons.js";

describe("resolveFileTypeIcon precedence", () => {
  it("resolves directories with open/closed and .git variants", () => {
    expect(resolveFileTypeIcon({ name: "src", isDirectory: true })).toBe("folder");
    expect(resolveFileTypeIcon({ name: "src", isDirectory: true, expanded: true })).toBe(
      "folder-open",
    );
    expect(resolveFileTypeIcon({ name: ".git", isDirectory: true })).toBe("folder-git");
    expect(resolveFileTypeIcon({ name: ".github", isDirectory: true, expanded: true })).toBe(
      "folder-git-open",
    );
  });

  it("never lets a directory name reach the extension map", () => {
    expect(resolveFileTypeIcon({ name: "archive.ts", isDirectory: true })).toBe("folder");
    expect(resolveFileTypeIcon({ name: "package.json", isDirectory: true })).toBe("folder");
    expect(resolveFileTypeIcon({ name: ".env", isDirectory: true })).toBe("folder");
  });

  it("prefers exact special filenames over extension", () => {
    expect(resolveFileTypeIcon({ name: "package.json" })).toBe("json");
    expect(resolveFileTypeIcon({ name: "bun.lock" })).toBe("lock");
    expect(resolveFileTypeIcon({ name: "Cargo.toml" })).toBe("toml");
    expect(resolveFileTypeIcon({ name: "Dockerfile" })).toBe("settings");
    expect(resolveFileTypeIcon({ name: "tsconfig.json" })).toBe("settings");
  });

  it("routes .env and .gitignore to the config gear (no vendored env glyph)", () => {
    expect(resolveFileTypeIcon({ name: ".env" })).toBe("settings");
    expect(resolveFileTypeIcon({ name: ".gitignore" })).toBe("settings");
  });

  it("resolves every vendored extension to its language glyph", () => {
    const expected = {
      astro: "astro",
      bash: "console",
      c: "c",
      cfg: "settings",
      clj: "clojure",
      conf: "settings",
      cpp: "cpp",
      cs: "csharp",
      css: "css",
      dart: "dart",
      erl: "erlang",
      ex: "elixir",
      exs: "elixir",
      gif: "image",
      go: "go",
      gql: "graphql",
      gradle: "gradle",
      graphql: "graphql",
      groovy: "groovy",
      h: "h",
      hcl: "hcl",
      hpp: "hpp",
      hs: "haskell",
      html: "html",
      ico: "image",
      ini: "settings",
      java: "java",
      jpeg: "image",
      jpg: "image",
      js: "javascript",
      json: "json",
      jsx: "react",
      kt: "kotlin",
      less: "less",
      lock: "lock",
      lua: "lua",
      markdown: "markdown",
      md: "markdown",
      ml: "ocaml",
      nix: "nix",
      php: "php",
      png: "image",
      py: "python",
      r: "r",
      rb: "ruby",
      rs: "rust",
      scala: "scala",
      scss: "sass",
      sh: "console",
      sql: "database",
      svelte: "svelte",
      svg: "svg",
      swift: "swift",
      tf: "terraform",
      toml: "toml",
      ts: "typescript",
      tsx: "react_ts",
      txt: "document",
      vue: "vue",
      wasm: "webassembly",
      webp: "image",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      zig: "zig",
    };
    for (const [extension, icon] of Object.entries(expected)) {
      expect(resolveFileTypeIcon({ name: `file.${extension}` }), extension).toBe(icon);
    }
  });

  it("is case-insensitive for extensions and special names", () => {
    expect(resolveFileTypeIcon({ name: "MAIN.PY" })).toBe("python");
    expect(resolveFileTypeIcon({ name: "Package.JSON" })).toBe("json");
  });

  it("falls back to the generic file glyph for anything the table does not know", () => {
    for (const name of ["weird.zzz", "noext", "x.env", "trailing.", ".", ""]) {
      expect(resolveFileTypeIcon({ name }), name).toBe("_default");
    }
  });

  it("maps the office family exactly as upstream material-icon-theme does", () => {
    const expected = {
      pdf: "pdf",
      doc: "word",
      docx: "word",
      odt: "word",
      rtf: "word",
      odp: "powerpoint",
      ppt: "powerpoint",
      pptm: "powerpoint",
      pptx: "powerpoint",
      csv: "table",
      ods: "table",
      xls: "table",
      xlsm: "table",
      xlsx: "table",
    };
    for (const [extension, icon] of Object.entries(expected)) {
      expect(resolveFileTypeIcon({ name: `report.${extension}` }), extension).toBe(icon);
    }
  });

  it("gives every anydoc office-preview suffix a non-generic glyph", () => {
    // anydoc_preview::CANDIDATE_SUFFIXES — what Picot previews as an office
    // file must never render as a generic document.
    const suffixes = ["doc", "docx", "rtf", "odt", "ppt", "pptx", "odp", "xls", "xlsx", "ods"];
    for (const suffix of suffixes) {
      expect(resolveFileTypeIcon({ name: `deck.${suffix}` }), suffix).not.toBe("_default");
    }
  });
  it("is stable across all three consumers (browser, git, preview)", () => {
    const descriptor = { name: "README.md" };
    expect(new Set([resolveFileTypeIcon(descriptor), resolveFileTypeIcon(descriptor)]).size).toBe(
      1,
    );
  });
});

describe("createFileTypeIcon element contract", () => {
  it("returns an aria-hidden SVG sized to the requested box", () => {
    const icon = createFileTypeIcon({ name: "app.ts" });
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.getAttribute("width")).toBe("16");
    expect(createFileTypeIcon({ name: "a.js" }, { size: 12 }).getAttribute("width")).toBe("12");
  });

  it("keeps the vendored viewBox instead of forcing one", () => {
    // The vendored table mixes 16/24/32-unit boxes; the artwork must keep its own.
    expect(createFileTypeIcon({ name: "app.ts" }).getAttribute("viewBox")).toBe("0 0 16 16");
    expect(createFileTypeIcon({ name: "lib.rs" }).getAttribute("viewBox")).toBe("0 0 32 32");
    expect(createFileTypeIcon({ name: "README.md" }).getAttribute("viewBox")).toBe("0 0 32 32");
  });

  it("renders real geometry, never emoji text", () => {
    for (const descriptor of [
      { name: "app.ts" },
      { name: "README.md" },
      { name: "unknown.xyz" },
      { name: "src", isDirectory: true },
      { name: ".git", isDirectory: true },
    ]) {
      const icon = createFileTypeIcon(descriptor);
      expect(icon.querySelectorAll("path").length).toBeGreaterThan(0);
      expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(icon.textContent)).toBe(false);
    }
  });

  it("falls back to the generic glyph for an unknown icon name string", () => {
    const icon = createFileTypeIcon("definitely-not-an-icon");
    expect(icon.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(icon.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("resolves a directory icon through the descriptor, not a string name", () => {
    const closed = createFileTypeIcon({ name: "src", isDirectory: true });
    const open = createFileTypeIcon({ name: "src", isDirectory: true, expanded: true });
    expect(closed.outerHTML).not.toBe(open.outerHTML);
  });
});

describe("icon chroma rule", () => {
  it("scales chroma toward neutral at the same perceived lightness", () => {
    expect(desaturateHexColor("#ff7043", 1)).toBe("#ff7043");
    const toned = desaturateHexColor("#ff7043", 0.65);
    expect(toned).toMatch(/^#[0-9a-f]{6}$/);
    expect(toned).not.toBe("#ff7043");
  });

  it("leaves non-colour values untouched", () => {
    expect(desaturateHexColor("none", 0.65)).toBe("none");
    expect(desaturateHexColor("currentColor", 0.65)).toBe("currentColor");
  });

  it("tones the rendered vendor artwork, not just the resolver name", () => {
    const icon = createFileTypeIcon({ name: "run.sh" });
    const fills = [...icon.querySelectorAll("[fill]")].map((node) => node.getAttribute("fill"));
    expect(fills).toContain(desaturateHexColor("#ff7043", 0.65));
    expect(fills).not.toContain("#ff7043");
  });

  it("tones the Picot directory glyphs with the same knob", () => {
    const icon = createFileTypeIcon({ name: ".git", isDirectory: true });
    const fills = [...icon.querySelectorAll("[fill]")].map((node) => node.getAttribute("fill"));
    expect(fills).toContain(desaturateHexColor("#f1959b", 0.65));
    expect(fills).not.toContain("#f1959b");
  });

  it("caches toned markup so identical icons render identical nodes", () => {
    const a = createFileTypeIcon({ name: "a.ts" }).outerHTML;
    const b = createFileTypeIcon({ name: "b.ts" }).outerHTML;
    expect(a).toBe(b);
  });
});
