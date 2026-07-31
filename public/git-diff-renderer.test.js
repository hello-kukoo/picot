// ABOUTME: Verifies Git diff rendering stays bounded and text-safe.
// ABOUTME: Covers aligned rows, line gutters, and explicit raw fallback rendering.

import { describe, expect, it } from "vitest";
import { createGitDiffRenderer } from "./git-diff-renderer.js";
import { setMessages } from "./i18n.js";

setMessages({
  git: {
    diffOriginal: "Original",
    diffModified: "Modified",
    diffEmpty: "No changes to display",
    comparison: { staged: "Staged", changes: "Changes", untracked: "Untracked" },
  },
});

describe("git diff renderer", () => {
  it("renders patch lines with fixed gutters as text", () => {
    const container = document.createElement("div");
    const renderer = createGitDiffRenderer({ patch: "@@ -1 +1 @@\n-old\n+new" });
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
    }).mount(container);

    expect(container.querySelector(".git-diff-toolbar")?.textContent).toContain("src/git-panel.js");
    expect(container.querySelector(".git-diff-comparison")?.textContent).toContain("Changes");
    expect(container.querySelector(".git-diff-column-header")?.textContent).toBe("Original");
  });

  it("keeps a safe fallback when the broker descriptor has no display path", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1 +1 @@\n-old\n+new" }).mount(container);
    expect(container.querySelector(".git-diff-path")?.textContent).toBe("Diff");
  });

  it("renders a localized empty state for an empty patch", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "", comparison: "staged" }).mount(container);
    expect(container.querySelector(".git-diff-empty")?.textContent).toBe("No changes to display");
  });

  it("aligns consecutive replacement blocks with blank cells", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ patch: "@@ -1,2 +1,1 @@\n-a\n-b\n+c" }).mount(container);
    expect(container.querySelectorAll(".git-diff-cell")).toHaveLength(4);
    expect(container.querySelectorAll(".blank")).toHaveLength(1);
  });

  it("renders a broker raw patch side by side when it is not a fallback", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ rawPatch: "@@ -1 +1 @@\n-old\n+new" }).mount(container);
    expect(container.querySelectorAll(".git-diff-column")).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("uses raw fallback for truncated patches", () => {
    const container = document.createElement("div");
    createGitDiffRenderer({ rawPatch: "raw", truncated: true }).mount(container);
    expect(container.querySelector("pre")?.textContent).toBe("raw");
  });
});
