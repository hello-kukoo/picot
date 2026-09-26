// ABOUTME: Catalog of the file-preview editor themes: ids, groups, legacy
// ABOUTME: normalization, light/dark resolution, and their CodeMirror syntax palettes.

import { HighlightStyle } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { tags as t } from "@lezer/highlight";

/** Follow the active Picot palette instead of a named editor theme. */
export const FOLLOW_PICOT = "follow";

/**
 * Every selectable editor theme. Order is the settings menu order: the Picot
 * palette first, then the light pairs, then the dark pairs.
 */
export const PREVIEW_THEME_IDS = [
  FOLLOW_PICOT,
  "one-light",
  "github-light",
  "catppuccin-latte",
  "gruvbox-light",
  "one-dark",
  "github-dark",
  "catppuccin-mocha",
  "gruvbox-dark",
];

/** Settings menu grouping (i18n keys live with the caller). */
export const PREVIEW_THEME_GROUPS = [
  { key: "follow", ids: [FOLLOW_PICOT] },
  { key: "light", ids: ["one-light", "github-light", "catppuccin-latte", "gruvbox-light"] },
  { key: "dark", ids: ["one-dark", "github-dark", "catppuccin-mocha", "gruvbox-dark"] },
];

/**
 * Display names are proper nouns and stay untranslated; `follow` resolves to a
 * localized label at the call site.
 */
export const PREVIEW_THEME_LABELS = {
  "one-light": "One Light",
  "github-light": "GitHub Light",
  "catppuccin-latte": "Catppuccin Latte",
  "gruvbox-light": "Gruvbox Light",
  "one-dark": "One Dark",
  "github-dark": "GitHub Dark",
  "catppuccin-mocha": "Catppuccin Mocha",
  "gruvbox-dark": "Gruvbox Dark",
};

/**
 * Pre-2026-09 preferences stored a light/dark/system mode. Map them onto the
 * closest named theme so an existing reader keeps the palette they had:
 * "light" was GitHub Light tokens, "dark" was One Dark tokens.
 */
const LEGACY_THEME_IDS = {
  system: FOLLOW_PICOT,
  light: "github-light",
  dark: "one-dark",
};

const LIGHT_THEME_IDS = new Set(PREVIEW_THEME_GROUPS[1].ids);
const DARK_THEME_IDS = new Set(PREVIEW_THEME_GROUPS[2].ids);

export function normalizePreviewThemeId(value) {
  if (typeof value === "string") {
    if (PREVIEW_THEME_IDS.includes(value)) return value;
    const legacy = LEGACY_THEME_IDS[value];
    if (legacy) return legacy;
  }
  return FOLLOW_PICOT;
}

/** "follow" | "light" | "dark" — the theme's own side, not the resolved one. */
export function previewThemeKind(id) {
  const normalized = normalizePreviewThemeId(id);
  if (LIGHT_THEME_IDS.has(normalized)) return "light";
  if (DARK_THEME_IDS.has(normalized)) return "dark";
  return "follow";
}

/** The effective side: named themes pin it, `follow` tracks the Picot theme. */
export function resolvePreviewThemeKind(id, picotThemeIsDark) {
  const kind = previewThemeKind(id);
  if (kind === "light") return "light";
  if (kind === "dark") return "dark";
  return picotThemeIsDark ? "dark" : "light";
}

export function previewThemeIsDark(id, picotThemeIsDark) {
  return resolvePreviewThemeKind(id, picotThemeIsDark) === "dark";
}

/**
 * Atom One Light token colors (the package ships One Dark only).
 * Palette: github.com/atom/one-light-syntax.
 */
const oneLightHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#a0a1a7", fontStyle: "italic" },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
    color: "#a626a4",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#50a14f" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], color: "#986801" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#4078f2" },
  { tag: [t.typeName, t.className, t.namespace], color: "#c18401" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#e45649" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#e45649" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#383a42" },
  { tag: t.operator, color: "#0184bc" },
  { tag: t.heading, color: "#4078f2", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#4078f2", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#ca1243" },
]);

/**
 * GitHub Light token colors (github-vscode-theme Light Default palette).
 * Also the migration target for the old forced "light" mode.
 */
export const githubLightHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#6e7781" },
  {
    tag: [
      t.keyword,
      t.modifier,
      t.operatorKeyword,
      t.definitionKeyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operator,
    ],
    color: "#cf222e",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.name)],
    color: "#0550ae",
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#0550ae" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#116329" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#24292f" },
  { tag: t.heading, color: "#0550ae", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#0a3069", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#82071e" },
]);

/** GitHub Dark token colors (github-vscode-theme Dark Default palette). */
const githubDarkHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#8b949e" },
  {
    tag: [
      t.keyword,
      t.modifier,
      t.operatorKeyword,
      t.definitionKeyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operator,
    ],
    color: "#ff7b72",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6ff" },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.name)],
    color: "#79c0ff",
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace], color: "#ffa657" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#79c0ff" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#7ee787" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#c9d1d9" },
  { tag: t.heading, color: "#1f6feb", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#a5d6ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#f85149" },
]);

/** Catppuccin Latte token colors (catppuccin.com style guide). */
const catppuccinLatteHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#8c8fa1", fontStyle: "italic" },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
    color: "#8839ef",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#40a02b" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], color: "#fe640b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#1e66f5" },
  { tag: [t.typeName, t.className, t.namespace], color: "#df8e1d" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#1e66f5" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#d20f39" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#4c4f69" },
  { tag: t.operator, color: "#04a5e5" },
  { tag: t.heading, color: "#1e66f5", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#1e66f5", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#d20f39" },
]);

/** Catppuccin Mocha token colors (catppuccin.com style guide). */
const catppuccinMochaHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#7f849c", fontStyle: "italic" },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
    color: "#cba6f7",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a6e3a1" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], color: "#fab387" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#89b4fa" },
  { tag: [t.typeName, t.className, t.namespace], color: "#f9e2af" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#89b4fa" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#f38ba8" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#cdd6f4" },
  { tag: t.operator, color: "#89dceb" },
  { tag: t.heading, color: "#89b4fa", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#89b4fa", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#f38ba8" },
]);

/** Gruvbox Light token colors (morhetz/gruvbox, medium contrast). */
const gruvboxLightHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#928374", fontStyle: "italic" },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
    color: "#9d0006",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#79740e" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], color: "#8f3f71" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#b57614" },
  { tag: [t.typeName, t.className, t.namespace], color: "#b57614" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#076678" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#427b58" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#3c3836" },
  { tag: t.operator, color: "#af3a03" },
  { tag: t.heading, color: "#076678", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#076678", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#9d0006" },
]);

/** Gruvbox Dark token colors (morhetz/gruvbox, medium contrast). */
const gruvboxDarkHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#928374", fontStyle: "italic" },
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword],
    color: "#fb4934",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#b8bb26" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name)], color: "#d3869b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#fabd2f" },
  { tag: [t.typeName, t.className, t.namespace], color: "#fabd2f" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#83a598" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#8ec07c" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#ebdbb2" },
  { tag: t.operator, color: "#fe8019" },
  { tag: t.heading, color: "#83a598", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#83a598", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#fb4934" },
]);

const NAMED_HIGHLIGHT_STYLES = {
  "one-light": oneLightHighlightStyle,
  "github-light": githubLightHighlightStyle,
  "catppuccin-latte": catppuccinLatteHighlightStyle,
  "gruvbox-light": gruvboxLightHighlightStyle,
  "one-dark": oneDarkHighlightStyle,
  "github-dark": githubDarkHighlightStyle,
  "catppuccin-mocha": catppuccinMochaHighlightStyle,
  "gruvbox-dark": gruvboxDarkHighlightStyle,
};

/**
 * Fill a settings <select> with the catalog: one optgroup per side, so the
 * Picot palette, the light pairs, and the dark pairs stay visually separated.
 * Shared by the Appearance settings page and the landing page so a new theme
 * pair only has to be added to PREVIEW_THEME_GROUPS.
 */
export function renderPreviewThemeOptions({
  select,
  selected,
  t,
  document: doc = globalThis.document,
}) {
  if (!select || !doc) return;
  select.replaceChildren();
  const normalized = normalizePreviewThemeId(selected);
  for (const group of PREVIEW_THEME_GROUPS) {
    const optgroup = doc.createElement("optgroup");
    optgroup.label = t(`settings.preview.themeGroup.${group.key}`);
    for (const id of group.ids) {
      const option = doc.createElement("option");
      option.value = id;
      option.textContent =
        id === FOLLOW_PICOT ? t("settings.preview.themeFollow") : PREVIEW_THEME_LABELS[id];
      option.selected = id === normalized;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
}

/**
 * The syntax palette for a stored preference id. `follow` keeps the historical
 * pairing: GitHub Light tokens on a light Picot theme, One Dark on a dark one.
 */
export function highlightStyleForPreviewTheme(id, picotThemeIsDark) {
  const named = NAMED_HIGHLIGHT_STYLES[normalizePreviewThemeId(id)];
  if (named) return named;
  return picotThemeIsDark ? oneDarkHighlightStyle : githubLightHighlightStyle;
}
