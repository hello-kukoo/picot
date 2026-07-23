# Terminal Font Bundling

## Purpose

Picot ships **FiraCode Nerd Font Mono** for the native Terminal Panel. The
bundled font makes Powerline and Nerd Font glyphs available without relying on a
user-installed font or a network font provider.

This document covers the asset pipeline only. Font use is display-only WebView
behavior: it does not change PTY profiles, terminal identities, broker frames,
or persisted terminal tab metadata.

## Asset contract

- Source: the pinned `FiraCode.zip` release from
  [`ryanoasis/nerd-fonts`](https://github.com/ryanoasis/nerd-fonts/releases).
- Pin: `scripts/terminal-font-version.json` records the release version,
  archive name, SHA-256, selected TTF source filenames, and generated WOFF2
  output filenames.
- Build inputs: `FiraCodeNerdFontMono-Regular.ttf` and
  `FiraCodeNerdFontMono-Bold.ttf` are extracted only into the build cache.
- Distributed files: `FiraCodeNerdFontMono-Regular.woff2`,
  `FiraCodeNerdFontMono-Bold.woff2`, and the upstream `LICENSE`.
- Output: `public/fonts/terminal/`. This generated directory is intentionally
  ignored by Git; it is recreated by the fetch script.
- Integrity: a downloaded archive is SHA-256 verified before extraction. A
  mismatch removes the cached archive and fails the build. Each selected TTF is
  converted to WOFF2 by the pinned `ttf2woff2` build dependency.
- Scope: only the two terminal weights and their license are distributed. The
  release archive, source TTF files, and all unselected font variants are not
  shipped in `public/fonts/terminal/`.

Use the Mono family, never the proportional variant, so every terminal cell has
a consistent width. CJK and emoji remain system-font fallbacks.

## Build and distribution

Run the fetcher directly when updating or repairing the local asset cache:

```sh
bun run fetch:terminal-font
```

`dev`, `prebuild`, Tauri's `beforeDevCommand`, Tauri's
`beforeBuildCommand`, `scripts/build.sh`, and `scripts/release-macos-dmg.sh`
all invoke the fetcher. GitHub Actions caches the verified archive and invalidates
the cache when either resource lockfile changes.

Tauri already maps `../public` to the bundled `public` resource directory.
Therefore the generated WOFF2 font assets are included in macOS `.app`
bundles and DMGs. The Windows local-builder ZIP explicitly includes the same
`public` directory, so it contains the WOFF2 assets as well. No post-bundle
mutation is permitted.

## WebView integration requirements

When Terminal Panel rendering is connected, declare a same-origin `@font-face`
that names the bundled family locally (for example, `Picot Terminal`) and pass
that family to xterm's `fontFamily` option, followed by system monospace
fallbacks. The Tauri CSP explicitly allows `font-src 'self'`; a CDN or other
remote font source is prohibited.

Before the first `FitAddon.fit()` for a new xterm instance, wait for the
requested face with `document.fonts.load()`. Repeat the fit after a font or
font-size preference changes. Otherwise xterm can calculate terminal columns
against a fallback font and mis-size the PTY.

Font size is a display-only preference owned by `terminal-preferences.js`.
The first version uses the bundled family rather than a user-selectable family,
so the font has predictable icon and box-drawing coverage.

## Updating the font

1. Find a Nerd Fonts release and its **official** SHA-256 for `FiraCode.zip`.
2. Update `version`, `sha256`, source `fontFiles`, and generated `outputFiles`
   in `scripts/terminal-font-version.json`.
3. Run `bun run fetch:terminal-font` and confirm it verifies, converts, and
   installs only the expected WOFF2 files under `public/fonts/terminal/`.
4. Run `bun run test` and `bun run check`.
5. Build the target artifact through the normal release/local-build path and
   verify the packaged `public/fonts/terminal/` directory contains both WOFF2
   fonts and `LICENSE`, with no distributed TTF files.

The upstream font license must remain in the generated output. License review
for a new upstream release is required before changing the pin.
