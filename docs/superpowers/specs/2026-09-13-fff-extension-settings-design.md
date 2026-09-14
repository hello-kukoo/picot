# pi-fff Extension Settings Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling sessions, Q1 +
amendment session same day); revised same day after spec review (injection
amendment superseded by file-only config; set op partial-key contract;
exact env-var table; minimal-file reset; 0600 parity).
**Date:** 2026-09-13

## Goal

Add a dedicated settings renderer for `npm:@ff-labs/pi-fff` in Settings →
Installed Extensions, as the second entry in the package-extension-settings
renderer map (see `2026-09-13-advisor-extension-settings-design.md` for the
shared bridge op module, renderer map, and detail-page mounting).

## Research findings

- Config: `~/.pi/agent/pi-fff.json` (respects `PI_CODING_AGENT_DIR`) —
  global only, project-level impossible by design. Currently absent on
  this machine (all defaults).
- Authoritative schema ships with the package (`pi-fff.schema.json`):
  `additionalProperties: false` — **unknown keys stop the extension from
  loading**. Fields: `mode` (`tools-and-ui` default / `tools-only` /
  `override`), `frecencyDbPath`, `historyDbPath`,
  `enableFsRootScanning` (false), `enableHomeDirScanning` (true),
  `warnOnHomeDirScan` (true), `followSymlinks` (true), `$schema`.
- Read timing (source-verified): `loadConfig()` runs once at extension
  module load (`src/index.ts`). Every field resolves through
  **flag > env > file > default** at startup. `/fff-mode` is a session-scoped
  override and never edits the file.

Exact per-field chain (source-verified; env names are **not** uniform —
only `mode` carries the `PI_FFF_` prefix):

| field | flag | env | default |
| --- | --- | --- | --- |
| `mode` | `fff-mode` | `PI_FFF_MODE` | `tools-and-ui` |
| `frecencyDbPath` | `fff-frecency-db` | `FFF_FRECENCY_DB` | fff-managed |
| `historyDbPath` | `fff-history-db` | `FFF_HISTORY_DB` | fff-managed |
| `enableFsRootScanning` | `fff-enable-root-scan` | `FFF_ENABLE_ROOT_SCAN` | `false` |
| `enableHomeDirScanning` | `fff-enable-home-scan` | `FFF_ENABLE_HOME_SCAN` | `true` |
| `warnOnHomeDirScan` | `fff-warn-home-scan` | `FFF_WARN_HOME_SCAN` | `true` |
| `followSymlinks` | `fff-follow-symlinks` | `FFF_FOLLOW_SYMLINKS` | `true` |

The shadow badge names the env var verbatim — badge strings source from
this table, never from a `PI_FFF_*` naming assumption.

### Consequences that shape the design

- **File edits require a Pi process restart (or `/reload`) to apply** —
  stricter than advisor's per-session_start re-read. Hint must say
  「重启 Picot 后生效」.
- A user-shell `PI_FFF_MODE` (etc.) can silently shadow the file. The
  get op must compute the effective value chain and the renderer must
  disable shadowed controls with a badge naming the overriding env var
  (exact names from the table above).
- A malformed/invalid file **prevents the extension from loading**. The
  renderer must surface this as an error state with a 「重置为默认」
  escape; the set op must validate (enum/type/additionalProperties) so
  Picot can never write an invalid file.

## Grilling decisions

| Branch | Decision |
| --- | --- |
| Field layout | Common fields flat: `mode` as a 3-way segmented control + the 4 booleans as toggles. The two DB paths (`frecencyDbPath`, `historyDbPath`) collapse into an「高级」disclosure group (defaults are managed by fff itself, rarely hand-edited). `$schema` is never rendered, preserved on write, written on file creation. |
| Env management (amendment, superseded by review) | **No env injection at all** — `pi-fff.json` is the single configuration channel for both the embedded Pi and terminal pi. A shadowing shell env is surfaced by the badge and resolved by the user in their own shell. Rejected: launch-env injection (original amendment) — its explicit-mode precondition created a default-solidification bookkeeping trap, and the unconditional variant would freeze the upstream default into the env (Rust hardcoding a foreign package's default). Rejected as before: shell rc writes (redundant with the global json, shadows it for terminal pi, unreachable for Dock-launched Picot, a third mechanism on Windows). |

## Contract

### Bridge ops — added to `extensions/extension-settings.ts`

- `fff.config.get` → `{ values, envShadowed: string[] (field names), invalid?: { reason } }`.
  Effective chain per field: flag (Picot never sets one; surface as
  shadowed if present) > `process.env` > file > schema default.
- `fff.config.set` → takes a **single changed key** (save-on-change: one
  control, one call) — never a full-form serialization, so an untouched
  default can never solidify into an explicit file key. Validates
  against the schema rules (enum, types, `additionalProperties: false` —
  unknown keys are *dropped*, the opposite of advisor's
  preserve-unknowns), read-modify-write, atomic write, `0600` (mirrors
  `advisor.config.set`), preserve `$schema` (write it on create). Only
  known keys are ever written.
- Path fields: empty input clears the key (fall back to fff-managed
  default); no existence validation — fff tolerates its own paths.

### Env handling (supersedes the injection amendment)

- Picot never injects env vars into the embedded Pi's launch — no
  `pi_launch.rs` changes. `pi-fff.json` is the only write channel;
  natural precedence (flag > env > file > default) applies identically to
  the embedded Pi and terminal pi.
- A shell env detected by the get op disables the affected control with
  the badge naming the exact var (see the table above); the user resolves
  shell-level shadows in their own shell. Dock/Finder-launched Picot
  does not inherit interactive shell env, so shadows are rare in
  practice (they require launching Picot from a shell that exports
  `PI_FFF_*`/`FFF_*`).
- Shell rc files (`~/.zshrc`/`.bashrc`/Windows `setx`) remain out of
  scope; the json already covers the user's terminal `pi` (same agent
  dir).

### Renderer — entry in `public/settings/package-extension-settings.js`

- Registered under `@ff-labs/pi-fff`.
- Flat: mode segmented control, 4 toggles (existing `toggles.js`).
-「高级」disclosure: the two path text inputs.
- Save on change with the standard save-status indicator.
- Shadowed field → control disabled + badge with the env var name.
- Invalid file → read-only error state +「重置为默认」button. Reset
  writes a minimal valid file containing only `$schema` — for both
  JSON-parse and schema-validation failures alike: reset means full
  defaults, not partial preservation (there are no "edited-good keys"
  worth keeping across an invalid boundary).
- Fixed hint:「重启 Picot 后生效」.

## i18n

Keys under `settings.extensionFff.*` in en/zh/ja/es: section title, mode
labels + one-line descriptions per mode, advanced group label,
reset-to-default label/confirm, restart hint, env-shadow badge,
invalid-config error.

## Verification

- Op tests: missing file → defaults + no shadow; env shadowing computed
  per field with the exact var names from the table; flag shadow
  surfaced when present; malformed file → invalid reason; set validates
  and drops unknown keys; partial set (toggle a boolean on a file
  without `mode` → the saved file still has no `mode` key); `$schema`
  preserved/created; atomic write with `0600`.
- Renderer tests: layout groups, shadowed-control disabling with the
  exact env-var badge, invalid-state reset button writes the
  `$schema`-only file, restart hint presence.
- `bun run check`, focused vitest, then `bun run test`.
- `ARCHITECTURE.md`: extend the extension-settings ops line with fff.

## Out of scope

Editing `/fff-mode` session state (session-scoped by design), shell rc
file writes (`~/.zshrc`/`.bashrc`/`setx`), launch-env injection (the
superseded amendment), `--fff-mode` flag injection,
`/fff-health` / `/fff-rescan` surfacing.
