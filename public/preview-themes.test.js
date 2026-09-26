// @vitest-environment jsdom
// ABOUTME: Pins the preview theme catalog: ids and groups, legacy migration,
// ABOUTME: light/dark resolution, syntax palette selection, and the settings menu.

import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { describe, expect, it } from "vitest";
import {
  FOLLOW_PICOT,
  githubLightHighlightStyle,
  highlightStyleForPreviewTheme,
  normalizePreviewThemeId,
  PREVIEW_THEME_GROUPS,
  PREVIEW_THEME_IDS,
  PREVIEW_THEME_LABELS,
  previewThemeIsDark,
  previewThemeKind,
  renderPreviewThemeOptions,
  resolvePreviewThemeKind,
} from "./preview-themes.js";

describe("preview theme catalog", () => {
  it("offers the Picot palette plus four light/dark pairs", () => {
    expect(PREVIEW_THEME_IDS).toEqual([
      "follow",
      "one-light",
      "github-light",
      "catppuccin-latte",
      "gruvbox-light",
      "one-dark",
      "github-dark",
      "catppuccin-mocha",
      "gruvbox-dark",
    ]);
    expect(PREVIEW_THEME_GROUPS.map((group) => group.key)).toEqual(["follow", "light", "dark"]);
    const flat = PREVIEW_THEME_GROUPS.flatMap((group) => group.ids);
    expect(flat).toEqual(PREVIEW_THEME_IDS);
    // Every named theme carries a display label; follow resolves via i18n.
    for (const id of PREVIEW_THEME_IDS.filter((id) => id !== FOLLOW_PICOT)) {
      expect(PREVIEW_THEME_LABELS[id]).toBeTruthy();
    }
  });

  it("migrates the pre-2026-09 light/dark/system modes onto the palette they rendered with", () => {
    expect(normalizePreviewThemeId("system")).toBe(FOLLOW_PICOT);
    expect(normalizePreviewThemeId("light")).toBe("github-light");
    expect(normalizePreviewThemeId("dark")).toBe("one-dark");
    expect(normalizePreviewThemeId("sepia")).toBe(FOLLOW_PICOT);
    expect(normalizePreviewThemeId(undefined)).toBe(FOLLOW_PICOT);
    expect(normalizePreviewThemeId(7)).toBe(FOLLOW_PICOT);
  });

  it("resolves each theme's side, with follow tracking the Picot theme", () => {
    expect(previewThemeKind("gruvbox-light")).toBe("light");
    expect(previewThemeKind("gruvbox-dark")).toBe("dark");
    expect(previewThemeKind("follow")).toBe("follow");
    // Named themes pin their side regardless of the Picot theme.
    expect(resolvePreviewThemeKind("one-light", true)).toBe("light");
    expect(resolvePreviewThemeKind("one-dark", false)).toBe("dark");
    expect(resolvePreviewThemeKind("follow", true)).toBe("dark");
    expect(resolvePreviewThemeKind("follow", false)).toBe("light");
    expect(previewThemeIsDark("github-dark", false)).toBe(true);
    expect(previewThemeIsDark("github-light", true)).toBe(false);
  });

  it("selects a syntax palette per theme, keeping the historical follow pairing", () => {
    expect(highlightStyleForPreviewTheme("one-dark", false)).toBe(oneDarkHighlightStyle);
    expect(highlightStyleForPreviewTheme("github-light", true)).toBe(githubLightHighlightStyle);
    // Follow keeps what the app rendered before named themes existed.
    expect(highlightStyleForPreviewTheme("follow", true)).toBe(oneDarkHighlightStyle);
    expect(highlightStyleForPreviewTheme("follow", false)).toBe(githubLightHighlightStyle);
    // Legacy ids resolve to the same palettes.
    expect(highlightStyleForPreviewTheme("dark", false)).toBe(oneDarkHighlightStyle);
    // Every named theme has a distinct palette object.
    const styles = new Set(
      PREVIEW_THEME_IDS.filter((id) => id !== FOLLOW_PICOT).map((id) =>
        highlightStyleForPreviewTheme(id, false),
      ),
    );
    expect(styles.size).toBe(8);
  });
});

describe("preview theme settings menu", () => {
  function build(selected) {
    const select = document.createElement("select");
    document.body.replaceChildren(select);
    const t = (key) => `t:${key}`;
    renderPreviewThemeOptions({ select, selected, t });
    return select;
  }

  it("renders one optgroup per side with proper-noun labels and the selection applied", () => {
    const select = build("catppuccin-latte");
    const groups = [...select.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual([
      "t:settings.preview.themeGroup.follow",
      "t:settings.preview.themeGroup.light",
      "t:settings.preview.themeGroup.dark",
    ]);
    expect(groups[1].querySelectorAll("option")).toHaveLength(4);
    expect(select.value).toBe("catppuccin-latte");
    const options = [...select.querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(PREVIEW_THEME_IDS);
    expect(options[0].textContent).toBe("t:settings.preview.themeFollow");
    expect(options[1].textContent).toBe("One Light");
    expect(options[8].textContent).toBe("Gruvbox Dark");
  });

  it("selects follow for legacy or unknown stored values", () => {
    expect(build("system").value).toBe("follow");
    expect(build(undefined).value).toBe("follow");
  });
});
