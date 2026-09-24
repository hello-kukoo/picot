# Material Icon Theme — vendored vocabulary source manifest

This directory documents the pinned upstream source for the curated,
trusted-local object-icon vocabulary embedded in
`public/file-type-icons.js`.

## Upstream

- **Project:** vscode-material-icon-theme
- **Author:** Philipp Kief (<https://github.com/PKief>)
- **License:** MIT (see `LICENSE` below)
- **Repository:** <https://github.com/vscode-material-icon-theme/vscode-material-icon-theme>
- **Pinned snapshot:** Paseo `material-icon-theme` **5.32.0**
  (<https://github.com/earendil-works/paseo>, `packages/app/src/components/material-file-icons.ts`)
- **Snapshot date:** 2026-09-23

## What is vendored

Two blocks in `public/file-type-icons.js` are **verbatim copies** of Paseo's
transcription of the upstream theme, so re-copying an icon stays a mechanical
edit and a diff against the pinned snapshot is meaningful:

- `FILE_ICON_SVG` — the 53-icon vocabulary plus the `_default` generic file
  glyph (the `SVG_ICONS` object in Paseo's file).
- `EXTENSION_TO_ICON` — the extension → icon-name map.

### Office additions (same snapshot, Picot-copied)

Paseo's curated table carries no office glyphs. Four more icons are therefore
**verbatim copies from the same pinned upstream 5.32.0 package** (`icons/*.svg`,
regenerate with `npm pack material-icon-theme@5.32.0`), kept in their own
clearly-marked blocks so the two Paseo blocks above still diff cleanly:

- `PICOT_FILE_ICON_SVG` — `pdf`, `word`, `powerpoint`, `table`.
- `PICOT_EXTENSION_TO_ICON` — `pdf`; `doc`/`docx`/`odt`/`rtf` → `word`;
  `ppt`/`pptx`/`pptm`/`odp` → `powerpoint`; `xls`/`xlsx`/`xlsm`/`ods`/`csv` →
  `table`.

The extension choices mirror upstream's own `material-icons.json` exactly.
Upstream has **no Excel-branded glyph** — it maps the whole spreadsheet family
to `table` — and we follow the upstream choice instead of inventing artwork.
`doc`/`docx`/`rtf`/`odt`/`ppt`/`pptx`/`odp`/`xls`/`xlsx`/`ods` are exactly the
suffixes Picot's anydoc office preview recognizes: what Picot previews as an
office file gets an office glyph.

An extension neither table knows still falls back to `_default` — the honest
answer for a glyph we do not own — which is why `*.env` renders as a generic
file while `.env` and `.gitignore` reach the config gear through Picot's own
`SPECIAL_NAMES` table.

Four directory glyphs are **Picot-authored**, not vendored: Paseo's table has
no directory icons (Paseo draws its folders with lucide). They live in
`FOLDER_ICONS` and share the file icons' chroma rule.

Colour: every hex fill in both blocks is scaled to `ICON_CHROMA = 0.65` in
OKLab (perceived lightness held) by the single `desaturateHexColor` knob.
Per-icon colour overrides are not allowed.

No remote URL, emoji fallback, or Material asset is ever used for an action
control.

## Policy

- File/Git object icons use these trusted local definitions only.
- Re-vendoring means re-copying both blocks from the pinned snapshot, then
  running `bun run vitest run public/file-type-icons.test.js`.
- Action controls (maximize, minimize, text-collapse, refresh-cw, etc.)
  remain the separate local monochrome registry in `public/icons.js`
  and never reuse Material artwork.

## LICENSE (upstream MIT)

```text
MIT License

Copyright (c) Philipp Kief and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
