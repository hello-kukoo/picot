// ABOUTME: Verifies Git diff rendering stays bounded and text-safe.
// ABOUTME: Covers aligned rows, line gutters, and explicit raw fallback rendering.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitDiffRenderer } from "./git-diff-renderer.js";
import { setMessages } from "./i18n.js";

setMessages({
  git: {
    diffOriginal: "Original",
    diffModified: "Modified",
    unifiedDiff: "Unified diff",
    diffEmpty: "No changes to display",
    fallback: { binary: "Binary file", rename: "Renamed only", copy: "Copied only" },
    comparison: { staged: "Staged", changes: "Changes", commit: "Commit", untracked: "Untracked" },
    comparisonHint: "Baseline: {kind}",
  },
});

describe("git diff renderer", () => {
  it("renders patch lines with fixed gutters as text", () => {
    const container = document.createElement("div");
    const renderer = createGitDiffRenderer({ patch: "@@ -1 +1 @@\n-old\n+new", unified: false });
    renderer.mount(container);
    expect(container.querySelectorAll(".git-diff-cell")).toHaveLength(2);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(2);
    expect(container.textContent).toContain("old");
    expect(container.textContent).toContain("new");
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders a diff toolbar with the file path and localized comparison label", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({
      displayPath: "src/git-panel.js",
      comparison: "changes",
      rawPatch: "@@ -1 +1 @@\n-old\n+new",
      unified: false,
    }).mount(container);

    expect(container.querySelector(".git-diff-toolbar")?.textContent).toContain("src/git-panel.js");
    expect(container.querySelector(".git-diff-comparison")?.textContent).toContain("Changes");
    expect(container.querySelector(".git-diff-column-header")?.textContent).toBe("Original");
  });

  it("renders unified rows with hunk, line numbers and syntax-highlighted text", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({
      displayPath: "sample.js",
      patch: "@@ -1,2 +1,2 @@\n const answer = 1;\n-const oldValue = 2;\n+const newValue = 3;",
    }).mount(container);
    expect(container.querySelector(".git-diff-hunk")?.textContent).toBe("@@ -1,2 +1,2 @@");
    const lines = [...container.querySelectorAll(".git-diff-unified-line")];
    expect(lines.map((line) => line.dataset.kind)).toEqual(["unchanged", "removed", "added"]);
    expect(lines.map((line) => line.querySelector(".git-diff-line-number")?.textContent)).toEqual([
      "1",
      "2",
      "2",
    ]);
    expect(container.querySelector(".git-diff-source span")).not.toBeNull();
  });

  it("renders unified diff rows by line with +/- markers by default", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1,2 +1,2 @@\n same\n-old\n+new" }).mount(container);
    const lines = [...container.querySelectorAll(".git-diff-unified-line")];
    expect(lines.map((line) => line.dataset.kind)).toEqual(["unchanged", "removed", "added"]);
    expect(lines.map((line) => line.querySelector(".git-diff-sign")?.textContent)).toEqual([
      " ",
      "-",
      "+",
    ]);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(0);
    expect(container.querySelector(".git-diff-hunk")?.textContent).toBe("@@ -1,2 +1,2 @@");
  });

  it("keeps side-by-side layout selectable", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1 +1 @@\n-old\n+new", unified: false }).mount(container);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(2);
    expect(container.querySelectorAll(".git-diff-unified-line")).toHaveLength(0);
  });

  it("keeps a safe fallback when the broker descriptor has no display path", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1 +1 @@\n-old\n+new", unified: false }).mount(container);
    expect(container.querySelector(".git-diff-path")?.textContent).toBe("Diff");
  });

  it("renders a localized empty state for an empty patch", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "", comparison: "staged" }).mount(container);
    expect(container.querySelector(".git-diff-empty")?.textContent).toBe("No changes to display");
  });

  it("aligns consecutive replacement blocks with blank cells", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1,2 +1,1 @@\n-a\n-b\n+c", unified: false }).mount(
      container,
    );
    expect(container.querySelectorAll(".git-diff-cell")).toHaveLength(4);
    expect(container.querySelectorAll(".blank")).toHaveLength(1);
  });

  it("renders a broker raw patch side by side when it is not a fallback", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ rawPatch: "@@ -1 +1 @@\n-old\n+new", unified: false }).mount(container);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("uses raw fallback for truncated patches", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ rawPatch: "raw", truncated: true }).mount(container);
    expect(container.querySelector("pre")?.textContent).toBe("raw");
  });

  it("localizes rename, copy, and binary fallback reasons", () => {
    for (const [fallbackReason, text] of [
      ["rename", "Renamed only"],
      ["copy", "Copied only"],
      ["binary", "Binary file"],
    ]) {
      const container = document.createElement("div");
      createGitDiffRenderer({ fallbackReason, rawPatch: "" }).mount(container);
      expect(container.querySelector(".git-diff-fallback-reason")?.textContent).toBe(text);
      expect(container.querySelector(".git-diff-empty")).toBeNull();
    }
  });

  it("uses shared logical grid rows when line wrapping is enabled", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({
      patch: "@@ -1,2 +1,2 @@\n-a very long original line\n-b\n+a very long updated line\n+c",
      unified: false,
      wrapLines: true,
    }).mount(container);

    const rows = container.querySelectorAll(".git-diff-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll(".git-diff-cell")).toHaveLength(2);
    }
    expect(container.querySelector(".git-diff-columns")?.classList.contains("wrap-lines")).toBe(
      true,
    );
  });

  it("follows the source editor's theme, font family and font size", () => {
    const css = readFileSync(join(process.cwd(), "public", "style.css"), "utf8");
    /** Whitespace-free text, so assertions survive the formatter's line breaks. */
    const flat = (text) => text.replace(/\s+/g, "");
    /** Declaration body of the first rule whose selector matches exactly. */
    const ruleBody = (selector) => {
      const start = css.indexOf(`${selector} {`);
      return start < 0 ? "" : flat(css.slice(start, css.indexOf("}", start)));
    };
    const has = (selector, declaration) => expect(ruleBody(selector)).toContain(flat(declaration));

    // Same face + size as CodeMirror, and the same chrome palette the editor
    // uses (Picot defaults, overridden by a named preview theme on <html>).
    for (const selector of [".git-diff-columns", ".git-diff-fallback pre"]) {
      has(selector, "font-family: var(--editor-font-family)");
      has(selector, "font-size: var(--preview-font-size, 13px)");
    }
    has(".git-diff-columns", "background: var(--editor-bg)");
    has(".git-diff-columns", "color: var(--editor-fg)");
    has(".git-diff-gutter", "color: var(--editor-gutter-fg)");
    has(".git-diff-cell.blank", "var(--editor-active-line)");
  });

  it("explains the comparison badge without changing its label", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({
      patch: "@@ -1 +1 @@\n-old\n+new",
      displayPath: "a.js",
      comparison: "commit",
    }).mount(container);

    const badge = container.querySelector(".git-diff-comparison");
    // The visible word stays the comparison kind; the pill is a label, not a
    // control, so the explanation rides a tooltip instead of new chrome.
    expect(badge.textContent).toBe("Commit");
    expect(badge.getAttribute("title")).toBe("Baseline: Commit");
    expect(badge.getAttribute("aria-label")).toBe("Baseline: Commit");
  });

  it("keeps the two independent columns when line wrapping is disabled", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({
      patch: "@@ -1 +1 @@\n-old\n+new",
      unified: false,
      wrapLines: false,
    }).mount(container);
    expect(container.querySelectorAll(".git-diff-row")).toHaveLength(0);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(2);
  });
});
