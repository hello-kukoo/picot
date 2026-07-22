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
  archive name, SHA-256, and selected filenames.
- Included files: `FiraCodeNerdFontMono-Regular.ttf`,
  `FiraCodeNerdFontMono-Bold.ttf`, and the upstream `LICENSE`.
- Output: `public/fonts/terminal/`. This generated directory is intentionally
  ignored by Git; it is recreated by the fetch script.
- Integrity: a downloaded archive is SHA-256 verified before extraction. A
  mismatch removes the cached archive and fails the build.
- Scope: only the two terminal weights and their license are copied. The
  release archive itself and all unselected font variants are not distributed.

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
Therefore the generated font assets are included in macOS `.app` bundles and
DMGs. The Windows local-builder ZIP explicitly includes the same `public`
directory, so it contains the assets as well. No post-bundle mutation is
permitted.

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
2. Update `version` and `sha256` in `scripts/terminal-font-version.json`.
3. Run `bun run fetch:terminal-font` and confirm it verifies and installs the
   expected files under `public/fonts/terminal/`.
4. Run `bun run test` and `bun run check`.
5. Build the target artifact through the normal release/local-build path and
   verify the packaged `public/fonts/terminal/` directory contains both fonts
   and `LICENSE`.

The upstream font license must remain in the generated output. License review
for a new upstream release is required before changing the pin.
