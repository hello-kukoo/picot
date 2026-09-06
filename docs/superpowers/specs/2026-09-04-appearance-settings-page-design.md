# Appearance Settings Page Design

## Status

Implemented on 2026-09-04. Approved by Dr. Lin on 2026-09-04 (grilling
session, Q1–Q10).

## Scope

Introduce a dedicated **Appearance** settings page and consolidate all
look-and-feel settings there:

- **Moved from General**: the Picot theme grid, and the entire Terminal
  section (theme mode, font size, scrollback, smooth scroll, WebGL).
  General retains Language and Agent.
- **New settings**:
  - File preview/editor theme: `system` (follow Picot) / `light` / `dark`.
  - File preview/editor font size: five levels.
  - Main chat window font size: five levels.
- **Reworked**: terminal font size changes from a free number (10–32px) to
  the same five-level control, and moves from per-origin localStorage into
  the global dual-track preference store.

Out of scope: HTML live preview, image and PDF renderers, chat tool cards,
timestamps, composer, git diff views, and global app zoom are untouched.
No live cross-window broadcast (other windows pick settings up on next
load — same as theme today).

## Contract

Preference levels: `small` / `normal` / `medium` / `large` / `xlarge`
(default `normal`; labels 小/正常/中/大/特大, shared i18n keys).

| Key (PREFERENCE_KEYS) | Values | Levels → px | Default |
| --- | --- | --- | --- |
| `ui.theme` | existing | — | existing |
| `ui.chatFontSize` | level | 14/16/18/20/22 | 16 (现状) |
| `ui.previewFontSize` | level | 11/13/15/17/19 | 13 (现状); markdown 预览恒 = code + 1px |
| `ui.terminalFontSize` | level | 12/15/18/22/26 | 15 (现状默认) |
| `ui.previewTheme` | `system`/`light`/`dark` | — | `system` |

Unknown/stale stored values fall back to the default via normalizers.

### Storage — dual-track (same as ui.theme / ui.locale)

- **Cookie cache**: single `picot-appearance` cookie, JSON
  `{chatFontSize, previewFontSize, previewTheme, terminalFontSize}`, read
  synchronously before first paint (no font-size flash), shared across the
  per-port workspace windows.
- **DB truth**: mirrored through the existing broker `preference.*`
  controls via `saveUserRenderPreference` / `reconcileRenderPreferences`
  (four new reconcile entries).

### Migration (one-time, idempotent)

Legacy terminal font size lives in per-origin localStorage
(`picot.terminal.preferences.fontSize`, px). On startup the appearance
module reads the raw value, maps it to the nearest
`ui.terminalFontSize` level (12/15/18/22/26 covers the old 10–32 range),
seeds the cookie, and removes the key from the localStorage payload.
`fontSize` leaves `ALLOWED_KEYS`; `TerminalPreferences` keeps
scrollback/smoothScroll/webgl/themeMode only.

## Preview theme

- Applies **only** to the code/text editor and the markdown preview inside
  the file preview panel.
- `system`: resolved from the active Picot theme's `dark` flag; re-resolved
  live when the user switches Picot theme (same hook that re-applies xterm
  themes).
- `light`: GitHub Light token colors — a hand-written
  `HighlightStyle.define` in `code-editor.js` (uses the already-vendored
  `HighlightStyle` + `tags`; no new dependency). Panel-scoped CSS variable
  overrides supply the light chrome (background, gutters, text, borders).
- `dark`: current behavior (oneDark highlight style, Picot theme chrome).
- Mechanism: `data-preview-theme="light|dark"` on `documentElement` drives
  CSS scope overrides on `.file-preview-panel`; the highlight style swaps
  through a CodeMirror compartment. `createCodeEditor` instances register
  with a module-level current-theme and reconfigure live.

## Runtime application

- Chat font size: CSS variable `--chat-font-size` (default
  `var(--font-size-lg)`) consumed by `.message-content` only.
- Preview font size: CSS variable `--preview-font-size` (default 13px)
  consumed by `.file-code-editor .cm-editor`; markdown preview uses
  `calc(var(--preview-font-size) + 1px)`.
- Terminal font size: resolved level → px feeds the existing
  `TerminalTab` fontSize flow (construction options +
  `applyPreferences({fontSize})` → refit). Other Terminal preferences keep
  their current localStorage flow.
- Inline bootstrap script (after the theme bootstrap, before CSS) reads the
  appearance cookie and sets the CSS variables and
  `data-preview-theme` before first paint.

## i18n

New keys in en/zh/ja/es: Appearance nav label (reuses
`settings.appearance`), preview section title/theme/description, chat font
size label/description, shared five level labels; terminal
`fontSizeDescription` reworded for levels.

## Verification

- Unit tests: level normalizers, per-surface px maps, cookie round-trip,
  legacy px → level migration, preview theme resolution.
- `settings-pages-layout.test.js` updated for the new nav/panel.
- `bun run check` + `bun run test` green.
