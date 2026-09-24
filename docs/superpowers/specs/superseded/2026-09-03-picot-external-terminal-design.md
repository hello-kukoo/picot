# Picot External Terminal Design

## Status

Draft. Path 2 (self-rendered launcher) chosen by Dr. Lin on 2026-09-03.
Awaiting MVP scope, PATH carryover rules, signing identity, OS priority,
and repo location before implementation begins.

**Update 2026-09-04: Path 1 has shipped.** The embedded xterm.js was
augmented (WebGL / search / unicode11 addons, Settings → General terminal
preferences) as a stopgap; Path 2 remains the chosen design for the
standalone launcher.

## Context

Picot today embeds an xterm.js terminal panel (`public/terminal-*.js`,
xterm.js 6.x + `@xterm/addon-fit` + `@xterm/addon-serialize`) wired to a Rust
`TerminalManager` over the broker. Dr. Lin has signalled dissatisfaction with
the embedded experience; the specific pain point has not yet been named.

Two adjacent requests motivate this design:

1. **Right-click session → open terminal.** A natural extension of the
   existing `sidebar/index.js showSessionContextMenu` (currently single-item).
2. **A standalone terminal app so colleagues do not have to install one.** Dr.
   Lin wants Picot to ship its own launcher rather than rely on the system
   terminal or third-party apps (Terminal.app / Ghostty / iTerm / Warp).

These two requests can be served independently. This spec lays out two
mutually-exclusive paths and records the chosen path.

## Non-goals

- Mirroring the same Pi pane across Picot GUI and a launcher window
  ("Picot GUI ↔ Pi TUI 同步显示同一 pane") — deferred, not in either path.
- Persistent sessions across reboot (out of scope; deferred).
- Replacing the embedded panel in the same release as any new path.

## Goals

- A right-click affordance on every session in the sidebar that opens a
  terminal tied to that session's cwd.
- The launched terminal inherits Picot's runtime PATH so shell-side tools
  match the embedded Pi session.
- Cross-platform (macOS / Windows / Linux) without requiring the user to
  install another terminal.

## Two paths

### Path 1 — Augment the embedded xterm.js (shipped 2026-09-04)

> **Shipped.** Implemented ahead of Path 2 as a stopgap. The concrete steps
> below are the original draft; two details changed in implementation:
> vendoring is the esbuild ESM pipeline (`scripts/build-frontend.js`
> regenerates `public/vendor/xterm.js` — no manual UMD copies), and the
> addons are wired in `public/terminal-tab.js` (`terminal-client.js` is
> protocol-only). Search opens via Cmd/Ctrl+F from a find bar in the panel.

**Idea.** The "external terminal" feeling Dr. Lin wants can come from making
the embedded xterm.js better first: WebGL renderer, search addon, unicode11,
image / ligature support. If that is enough, no separate app is needed.

**Why held in reserve.** Dr. Lin has chosen Path 2 over Path 1, but Path 1
remains a low-cost follow-up if the embedded panel continues to underperform
once the launcher ships.

**Concrete steps (when picked up).**

1. `bun add @xterm/addon-webgl @xterm/addon-search @xterm/addon-unicode11`
2. Re-vendor the addon UMD bundles into `public/vendor/` (same procedure as
   `xterm.js` / `xterm.css`).
3. Extend `terminal-vendor-entry.js` to import the new addons and expose
   them on `globalThis.PicotXterm`.
4. Wire each addon in `public/terminal-client.js`: `loadAddon(webgl)`,
   `loadAddon(search)` (`activate` on Cmd/Ctrl+F), `loadAddon(unicode11)`
   (`Terminal.unicode.activeVersion = "11"`).
5. Add tests for addon lifecycle (mount/unmount, search round-trip, unicode11
   width correctness).
6. Run `bun run check` and the focused vitest for terminal modules.

**Costs.** ~150 lines across 2 files; ~3–5 working days; 3 new npm packages.

**Risks.** `@xterm/addon-webgl` is officially experimental; Windows GPU
drivers occasionally regress WebGL — fallback is the existing DOM renderer.
Make WebGL opt-in behind a preference in `terminal-preferences.js`, default
ON on macOS / Linux, default OFF on Windows until validated.

**Vendor bundle rebuild check (before every merge).** Any PR touching
terminal dependencies or `terminal-vendor-entry.js` must run
`bun run build:extensions && node scripts/build-frontend.js` and then the
vendor contract test (`bun run vitest run public/terminal-tab.test.js`) so
`public/vendor/xterm.js` is proven consistent with the entry. `public/vendor/`
is gitignored, so a clean idempotent rebuild + green contract test is the
no-drift evidence; never hand-edit the bundle.

---

### Path 2 — Standalone launcher app, self-rendered (chosen)

**Idea.** Ship a separate binary (`picot-launcher`) with its own renderer.
Picot spawns it from the right-click menu. No xterm.js, no webview; the
launcher paints the grid itself.

**Why the no-xterm constraint matters.** Dr. Lin has signalled that the
embedded xterm.js experience is unsatisfactory in some way that Path 1
cannot fix. Re-using xterm.js in the launcher would either repeat the same
pain (Path 1's addons do not change the underlying renderer) or bring it
back after Path 2 shipped. The launcher must own its rendering.

**Tech stack (validated 2026-09-03):**

| Layer            | Crate                | Version | License        | Why                                                                                       |
| ---------------- | -------------------- | ------- | -------------- | ----------------------------------------------------------------------------------------- |
| GUI framework    | `egui`               | 0.36    | MIT/Apache-2.0 | immediate mode, native backend via `egui-wgpu`, "works out-of-the-box on Mac and Windows" |
| Native entry     | `eframe`             | 0.36    | MIT/Apache-2.0 | wraps winit + wgpu, single binary                                                         |
| Font shaping     | `cosmic-text`        | 0.19    | MIT            | pure Rust, DirectWrite on Windows / CoreText on macOS / fontconfig on Linux               |
| VT parser + grid | `alacritty_terminal` | 0.26    | Apache-2.0     | upstream `crates.io`, no fork needed; same library tty7 uses                              |
| PTY              | `portable-pty`       | 0.9     | MIT            | already in Picot's tree, ConPTY on Windows                                                |
| CLI parsing      | `clap`               | 4       | MIT/Apache-2.0 | derive macros                                                                             |

No Zig toolchain. No Tauri. No xterm.js. Single native binary.

**Concrete steps.**

1. New repo `picot-launcher/` (separate Cargo workspace, not nested in
   `picot-v3`).
2. `Cargo.toml` pins the six crates above. Pin `alacritty_terminal = "0.26"`
   from `crates.io`; do **not** take the `l0ng-ai/alacritty` fork — it carries
   tty7-specific patches and unverified Windows fixes.
3. Module layout (`src/`):
   - `main.rs` — `eframe::App` wiring, command-line parsing.
   - `cli.rs` — `clap` derive for `--cwd`, `--shell`, `--exec`, `--env`,
     `--title`, `--rows`, `--cols`.
   - `pty.rs` — `portable-pty` master + reader thread + writer. Emits bytes
     to a `crossbeam_channel::Receiver<Vec<u8>>`.
   - `vt.rs` — owns the `alacritty_terminal::Term`. Receives bytes from the
     channel, calls `term.advance(&bytes)`, surfaces a `GridSnapshot`
     (cells + cursor + dirty region) for the renderer.
   - `render.rs` — uses `cosmic-text` to shape grid cells; draws with
     `egui::Painter` (`add_text`). One paint per frame.
   - `input.rs` — keyboard → VT-encoded bytes → `pty.writer`.
   - `selection.rs` — mouse drag → OSC 52 / clipboard on release.
4. CLI contract:

   ```text
   picot-launcher \
     --cwd <path> \
     --shell <path>     # zsh / Git Bash / etc.
     --exec "<cmd>"     # optional: e.g. `pi --session-id <id>`
     --env KEY=VALUE    # repeatable
     --title "<label>"  # window title
     --rows 24 --cols 80
   ```

   Opens a native window titled `--title`, then runs `--shell` (or `--exec`
   if provided) in `--cwd`.

5. Picot host: new Rust module `src-tauri/src/external_terminal.rs` that
   `std::process::Command`-spawns the binary with `PATH` carried over from
   the host. Surface from the broker as
   `open_external_terminal { session_id, cwd, exec?, env? }`.
6. Right-click extension in
   `public/sidebar/index.js showSessionContextMenu`: append a
   `t("sidebar.openExternalTerminal")` menu item that calls the new broker
   command.
7. Tests:
   - Rust unit: `vt` round-trip on a fixed byte stream produces the expected
     `GridSnapshot` (UTF-8 + SGR colors + cursor).
   - Rust unit: `cli` parser produces the expected argv shape.
   - Integration: spawn `sh -c 'printf "hi\n"'`, read bytes, snapshot grid,
     assert cell contents.
   - Picot: sidebar context-menu vitest for the new menu item.

**Costs.**

- Code: ~1500 lines new in `picot-launcher/` (Rust only). ~200 lines touched
  in Picot (broker wiring, sidebar context menu).
- Time: ~3–4 weeks including cross-platform CI and signing/notarization
  plumbing for a second binary.
- Build: new GitHub Actions matrix entry for the launcher on three OSes;
  new release artifact.

**Risks.**

- **Two binaries drift** (PATH contract, version pin, signing certs).
- **Windows font shaping**: cosmic-text on Windows uses DirectWrite; CJK
  fallback chain needs explicit font registration. Validate early on a
  Windows box.
- **Windows DPI / IME / Alt-key quirks** from Alacritty's CHANGELOG (DPI
  change crashes, fullwidth-char edge cases, Alt+Ctrl bindings) will surface
  again. Mitigate with a `win_quirks.rs` module and CI matrix.
- **Coupling to Pi RPC**: launcher `--exec pi --session-id <id>` ties the
  launcher's argv contract to Pi's CLI. If Pi changes argv, both binaries
  update.

**Out of scope for Path 2 (intentionally deferred):**

- scrollback search
- image / Kitty graphics protocol
- ligature shaping
- copy mode
- persistent sessions

These can land after the MVP if Dr. Lin wants them.

## Recommendation

**Path 2.** Dr. Lin has chosen the self-rendered launcher. Path 1 remains a
valid quick-win for the embedded panel; both can ship independently. The
launcher work is sequenced below.

## Open questions for Dr. Lin

1. **MVP scope**: which of the deferred Path 2 features (scrollback search,
   image protocol, ligature, copy mode, persistent sessions) should ship in
   the first release, if any?
2. **PATH carryover**: should the launcher inherit the parent shell's PATH
   (login-shell-aware), the embedded Pi PATH, or the user's bare `$PATH`?
3. **Signing identity**: should the launcher share Picot's CI signing
   identity, or ship unsigned as an internal tool?
4. **OS priority**: which OS lands first when? (Linux support is included
   by default but no colleague is yet on Linux.)
5. **Repo location**: separate repo `picot-launcher/`, or subdirectory of
   `picot-v3/crates/` with its own Cargo workspace?
