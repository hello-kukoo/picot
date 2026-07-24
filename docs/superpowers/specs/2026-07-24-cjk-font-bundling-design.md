# Picot CJK Font Bundling Design

## Status

Proposed. The upstream release pin, source SHA-256, and subset size cap are
locked concretely in `scripts/cjk-font-version.json` via the implementation
plan (verified against the live `lxgw/LxgwWenKai-Lite` release); they are
re-verified and re-filled only when the pinned version changes, mirroring the
terminal-font lock file. This spec fixes the scope, asset contract, build
wiring, and CSS integration.

## Goal

Bundle a GB2312 subset of **LXGW WenKai Lite** (Simplified Chinese, SIL OFL
1.1) as a same-origin WOFF2 web font, and apply it as the CJK fallback on
Picot's **content surfaces** — the main-chat prose (both assistant
replies and user messages) and file-preview Markdown prose. Latin text and
all app chrome continue to use the
existing system font stack. The bundled font is the single source of truth for
CJK rendering on those surfaces; a user-installed font is never required.

This reuses the proven terminal-font asset pipeline
(`scripts/fetch-terminal-font.js` + `scripts/terminal-font-version.json`,
documented in `docs/terminal-font-bundling.md`) as its template.

## Confirmed product decisions

These are the outcomes of the design discussion and are not re-litigated here:

1. **Use the Lite variant, not the full version.** The author publishes
   [LXGW WenKai Lite](https://github.com/lxgw/LxgwWenKai-Lite) specifically so
   developers can embed the font in software. The full version carries the
   entire CJK base plane + Extension A + Hangul and is far larger than needed.
2. **Subset to GB2312 + CJK punctuation, exclude ASCII.** GB2312 (6,763
   ideographs) covers Simplified-Chinese daily use. ASCII is dropped so Latin
   is always served by the system font; this both shrinks the asset and makes
   the "Latin = system" intent structural rather than incidental.
3. **WOFF2 format**, consistent with the terminal font (not WOFF).
4. **Ship Regular weight only for v1.** Markdown `<strong>` uses the browser's
   faux-bold. Real Medium/Bold is deferred.
5. **Scope to content surfaces only** — assistant response body, the user
   message bubble, and Markdown preview body. Not the whole UI, not code
   blocks, not the input box, not the terminal.
6. **CJK fallback via `unicode-range` + font-family ordering:** list
   `"Picot CJK"` before the unchanged system stack so CJK reliably selects the
   bundled face; its `unicode-range` excludes ASCII, so Latin falls through to
   the system stack and an English-only screen never downloads the CJK asset.
7. **Defer LXGW WenKai Mono** (code-block / CodeMirror CJK) to a later phase.

### Why content surfaces, not the whole UI

- LXGW WenKai is a kai (textbook/humanist) face designed for body-text
  reading, not UI labels. At the 12–13 px chrome text sizes its variable
  stroke weight and small serifs hurt legibility versus SF/Inter.
- App chrome (sidebar, header, tabs, buttons, settings) is UI furniture; the
  "Dark Glassmorphism" identity is better served by a neutral system face.
- Both the assistant reply and the user bubble use the kai face for CJK, so
  the whole conversation reads in one consistent written face; the
  user/assistant distinction is carried by bubble background, alignment, and
  chrome — not by switching CJK fonts mid-conversation (which looked
  inconsistent when the user bubble fell back to the system CJK face).

## Non-goals

- Replacing the system font on any app chrome.
- A CJK face inside code blocks or the CodeMirror editor (Phase 2 candidate:
  LXGW WenKai Mono Lite).
- A real Bold/Medium weight (Phase 2 candidate).
- Coverage of Traditional Chinese or rare Hanzi beyond GB2312 (these fall back
  to the system CJK face).
- A user-selectable font preference.
- Any change to the terminal-font pipeline, PTY profiles, or persisted
  terminal metadata.

## License

LXGW WenKai is licensed under SIL Open Font License 1.1 (derived from
Fontworks' Klee One). OFL 1.1 permits embedding and bundling in software and
explicitly permits subsetting and format conversion (to WOFF/WOFF2) for
web-font use, provided the font is not offered as an installable desktop font
and the `OFL.txt` is redistributed. Picot's bundle model (WOFF2 inside the
`.app`, not exposed as an installable font, LICENSE shipped alongside)
satisfies these terms. The bundled license file is mandatory in the generated
output.

## Asset contract

- **Source:** a pinned release of `lxgw/LxgwWenKai-Lite`. Latest at the time
  of writing is `v1.522`; the source TTF is `LXGWWenKaiLite-Regular.ttf`
  (≈13.9 MB). The Mono sibling (`LXGWWenKaiMonoLite-Regular.ttf`) exists but is
  out of scope for v1.
- **Pin file:** `scripts/cjk-font-version.json` records `version`, the source
  archive/TTF URL, the source TTF filename, the source **SHA-256**, the subset
  unicode-set name, and the generated WOFF2 output filename. It mirrors the
  terminal-font lock's pinning discipline (version + SHA-256 + `outputFiles`
  + `_comment`) with CJK-specific fields (`sourceUrl`, `licenseUrl`,
  `subsetSet`, `approxBytes`, `sizeCapBytes`); it is not a field-for-field copy
  of `scripts/terminal-font-version.json`.
- **Subset target:** GB2312 ideograph set (6,763 Hanzi) ∪ CJK Symbols and
  Punctuation (`U+3000`–`U+303F`) ∪ Halfwidth and Fullwidth Forms
  (`U+FF00`–`U+FFEF`). ASCII (`U+0020`–`U+007E`) is excluded.
- **Distributed files:** exactly one WOFF2 (for example
  `LXGWWenKaiLite-Regular.gb2312.woff2`) and the upstream `OFL.txt`. No TTF is
  shipped.
- **Output directory:** `public/fonts/cjk/`. Gitignored (same model as
  `public/fonts/terminal/`); recreated by the fetch script.
- **Source cache:** `.cache/cjk-fonts/`, holding the downloaded source TTF
  between runs. Also gitignored (same model as `.cache/terminal-fonts/`); if
  it is omitted, a ≈13.9 MB source TTF is one `git add -A` away from the
  repository.
- **Integrity:** the downloaded source is SHA-256 verified before subsetting.
  A mismatch removes the cached source and fails the build.
- **Expected size:** on the order of 1–3 MB WOFF2 after subset. The lock file
  records `approxBytes` (the observed size, reference only) and `sizeCapBytes`
  (a sane upper bound). The fetch CLI itself asserts the generated WOFF2 is
  materially smaller than the source TTF, at or under `sizeCapBytes`, and
  above a hardcoded `MIN_WOFF2_BYTES` floor (100,000) that catches a silently
  empty subset; none of this is asserted by the unit suite, which is
  network-free.

## Fetch pipeline (new module)

A new `scripts/fetch-cjk-font.js` mirrors `scripts/fetch-terminal-font.js`:

1. Load `scripts/cjk-font-version.json`; validate its shape (version regex,
   archive/TTF name, 64-hex SHA-256, non-empty output file ending in `.woff2`,
   finite positive `approxBytes`, and positive integer `sizeCapBytes`).
2. If the `.version` marker exists and all output files are present, skip.
3. Download the pinned source into `.cache/cjk-fonts/`; if a cached file's
   SHA-256 does not match the pin, delete it and re-download.
4. Verify SHA-256; on mismatch remove the cached source and fail.
5. Subset + convert the source TTF to WOFF2 for the declared unicode set.
   - **Recommended tool:** `subset-font` (pure JavaScript, Bun-compatible),
     added as a pinned devDependency. It performs subset and WOFF2 conversion in
     one step and keeps the build Bun/Node-only.
   - **Documented alternative for local experiments:** `pyftsubset` (Python
     `fonttools`). Not used by the build, because the project is Bun-only.
   - Before publishing the output, assert its byte size is materially smaller
     than the source TTF, at or under `sizeCapBytes`, and above an absolute
     floor (`MIN_WOFF2_BYTES`, 100,000 — a GB2312 subset is orders of
     magnitude larger, so this catches a silently empty subset); remove
     generated output and fail with the actual source/output/cap/floor sizes
     on violation.
6. Replace `public/fonts/cjk/`, write only the validated WOFF2 + `OFL.txt`, and
   write the `.version` marker.

### Build wiring

- New `package.json` script: `"fetch:cjk-font": "bun run scripts/fetch-cjk-font.js"`.
- Add `&& bun run fetch:cjk-font` to the existing fetch chains in:
  - `package.json` `dev` and `prebuild` (after `fetch:terminal-font`).
  - `src-tauri/tauri.conf.json` `build.beforeDevCommand` and
    `build.beforeBuildCommand` (after `fetch:terminal-font`).
  - `scripts/build.sh` wherever it mirrors the `beforeBuildCommand` chain.
- CI cache invalidation: add `scripts/cjk-font-version.json` to the
  `hashFiles(...)` key in `.github/workflows/release.yml` (currently
  `pi-version.json`, `terminal-font-version.json`).

## Build and distribution

Tauri already maps `../public` to the bundled `public` resource directory, so
`public/fonts/cjk/*.woff2` is included in macOS `.app` bundles, DMGs, and the
Windows local-builder ZIP with no extra bundling step. No post-bundle mutation
is permitted. The Tauri CSP already allows `font-src 'self'`; a CDN or other
remote font source remains prohibited, and no CSP change is required.

End users never run `fetch:cjk-font`. The same hooks that guarantee the
embedded pi binary and the terminal font are present (pre-build hook, Tauri
before-commands, `build.rs` guard pattern) guarantee the CJK asset is present.

## WebView integration

Declare a same-origin `@font-face` in `public/style.css`, adjacent to the
existing terminal `@font-face` blocks:

```css
@font-face {
  font-family: "Picot CJK";
  src: url("./fonts/cjk/LXGWWenKaiLite-Regular.gb2312.woff2") format("woff2");
  unicode-range: U+3000-303F, U+4E00-9FFF, U+FF00-FFEF;
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
```

Add scoped font-family rules for the three content surfaces. The `body` rule is
intentionally **unchanged** so chrome stays on the system font:

```css
.message.assistant .message-content,
.message.user .message-content,
.file-markdown-preview {
  font-family:
    "Picot CJK", -apple-system, BlinkMacSystemFont, "SF Pro Display",
    "SF Pro Text", "Helvetica Neue", sans-serif;
}
```

Notes:

- `Picot CJK` is listed first so the CJK codepoints it declares reliably select
  the bundled face before platform CJK fallback can resolve them.
- Its `unicode-range` excludes ASCII. Therefore Latin skips `Picot CJK` and
  falls through to the system stack, which otherwise mirrors `body` exactly
  (`-apple-system … "SF Pro Display" "SF Pro Text" "Helvetica Neue"`); Latin
  on these surfaces remains pixel-identical to chrome.
- `unicode-range` gates the download: a screen with no CJK codepoints never
  fetches the WOFF2. This is what lets English-locale users pay zero cost.
- `font-display: swap` lets CJK render in the system fallback first and swap
  to wenkai once loaded. Unlike the terminal font, no
  `document.fonts.load()` + re-`fit()` dance is needed — that concern is
  specific to xterm cell measurement.

## Font scope (explicit)

| Surface                                          | Applies wenkai?                     |
| ------------------------------------------------ | ----------------------------------- |
| `.message.assistant .message-content` (prose)    | Yes (CJK fallback)                  |
| `.file-markdown-preview` (Markdown prose)        | Yes (CJK fallback)                  |
| `body`, sidebar, header, tabs, buttons, settings | No (system font)                    |
| `.message.user .message-content` (user bubble)   | Yes (CJK fallback)                  |
| `input`, `textarea` (composer)                   | No                                  |
| `pre` / `code` (chat code blocks)                | No (monospace; system CJK fallback) |
| `.file-code-editor .cm-editor` (CodeMirror)      | No                                  |
| Terminal panel (`Picot Terminal`)                | No                                  |

## Known limitations and trade-offs

- Hanzi outside GB2312 (Traditional, rare Extension-A) fall back to the system
  CJK face. Acceptable for v1; revisit if gaps are felt.
- Markdown bold (`<strong>`, `font-weight: 700`) renders as browser faux-bold
  against the single Regular weight. Faux-bold on kai strokes can look slightly
  muddy at large sizes; a real Medium/Bold weight is Phase 2.
- During streaming, the first CJK glyph in a reply may swap from system
  fallback to wenkai once the font finishes loading (one-time, per session
  cache miss).

## Module boundaries

New files:

- `scripts/cjk-font-version.json` — asset pin.
- `scripts/cjk-subset.js` — pure, I/O-free GB2312 subset collector (exports
  `collectGb2312SubsetChars`); split out so the unit suite can exercise it
  without triggering the CLI's network `main()`.
- `scripts/fetch-cjk-font.js` — fetch/verify/subset/convert/install.
- `scripts/fetch-cjk-font.test.js` — unit tests mirroring
  `scripts/fetch-terminal-font.test.js`.

Changed files:

- `package.json` — `fetch:cjk-font` script; `subset-font` devDependency; add
  `fetch:cjk-font` to `dev` and `prebuild`.
- `src-tauri/tauri.conf.json` — add `fetch:cjk-font` to `beforeDevCommand`
  and `beforeBuildCommand`.
- `scripts/build.sh` — mirror the fetch chain where applicable.
- `.github/workflows/release.yml` — add `scripts/cjk-font-version.json` to the
  embedded-assets cache `hashFiles` key.
- `.gitignore` — add `public/fonts/cjk/` and `.cache/cjk-fonts/`.
- `public/style.css` — one `@font-face` and two scoped `font-family` rules.

## Testing and verification

### Fetch-script unit tests

The unit suite is network-free; it validates only what it can without
downloading or subsetting:

1. `scripts/cjk-font-version.json` pins the expected version, source file,
   source/license URLs, 64-hex SHA-256, `subsetSet: "gb2312"`, the single
   WOFF2 output filename, and both the `approxBytes` reference and the
   `sizeCapBytes` upper bound.
2. `collectGb2312SubsetChars()` returns exactly 6,763 Hanzi — all inside the
   CJK punctuation / Unified Ideographs / Fullwidth ranges — and includes
   representative characters (`一`, `。`).
3. `scripts/fetch-cjk-font.js` wires `subset-font` (with `targetFormat:
   "woff2"`), SHA-256 verification, and the Open Font License check.

The behaviors that need the network and the real subsetting — skip-when-
up-to-date, SHA-256 mismatch removal, the exact output file set, no TTF
shipped, and the subset byte size — are asserted by the fetch CLI under Build
/ CI, not by the unit suite.

### Build / CI

- `bun run fetch:cjk-font` exits 0 from a clean cache.
- The fetch CLI rejects a generated WOFF2 that is not materially smaller than
  the source TTF, exceeds `sizeCapBytes` from the lock file, or falls below
  the `MIN_WOFF2_BYTES` floor; the unit suite remains network-free.
- `bun run test` and `bun run check` pass.
- A packaged bundle's `public/fonts/cjk/` contains the WOFF2 and `OFL.txt` and
  no TTF.

### Manual smoke

- An assistant reply containing a Chinese paragraph renders the Hanzi in
  wenkai and the Latin in the system face, in the same reply.
- A code block inside that reply keeps monospace Latin; any Chinese inside the
  code block falls back to the system CJK face (Mono is deferred).
- An English-only reply does **not** request the CJK WOFF2 in DevTools Network.
- Previewing a `.md` with Chinese: prose renders in wenkai; code blocks are
  unchanged.
- A Hanzi outside GB2312 (for example a rare character) falls back to the
  system CJK face without tofu on both macOS and Windows.

## Acceptance criteria

1. A clean `bun run fetch:cjk-font` installs exactly one WOFF2 and `OFL.txt`
   under `public/fonts/cjk/`, SHA-verified and version-marked.
2. The shipped WOFF2 is a GB2312 + CJK-punctuation subset; no full TTF is
   distributed.
3. Assistant response prose, the user message bubble, and Markdown preview
   prose render CJK in wenkai and Latin in the system font.
4. App chrome, the composer, code blocks, and the terminal are visually
   unchanged (no `font-family` change on `body`); the user bubble's Latin is
   unchanged and only its CJK now resolves to wenkai.
5. English-only content does not trigger a download of the CJK WOFF2.
6. The asset ships inside the `.app` / DMG / Windows ZIP; the CSP is unchanged;
   `bun run test` and `bun run check` pass.

## Open questions and future work

- **Phase 2 — code CJK (LXGW WenKai Mono Lite):** add a second subset and a
  `Picot CJK Mono` `@font-face`, plus explicit monospace stacks on chat
  `pre`/`code` and `.file-code-editor .cm-editor`. This would also let us fix
  the pre-existing inconsistency that chat code blocks currently resolve to
  the browser's UA-default monospace rather than the bundled `Picot Mono Nerd`.
- **Phase 2 — real weight:** ship Medium for `<strong>` instead of faux-bold.
- **Phase 2 — broader coverage:** move to a GB 18030 / Traditional-capable
  source if GB2312 gaps are felt.
- **Implementation-time confirmation:** pin the exact `subset-font` version and
  confirm its option API (unicode input shape, output format string) against
  that version before writing the subset step.
