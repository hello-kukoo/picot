# pi-fff Extension Settings Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling sessions, Q1 +
amendment session same day); revised same day after spec review (injection
amendment superseded by file-only config; set op partial-key contract;
exact env-var table; minimal-file reset; 0600 parity). Implemented
2026-09-15 on the bridge; migrated same day to host ops per Dr. Lin's
decision (landing configurability); spec tracks code.
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

### Host ops — `src-tauri/src/fff_config.rs`, control-plane cases in `main.rs`

Control ops (`transport.getFffConfig()` → `get_fff_config`,
`transport.setFffConfig(payload)` → `set_fff_config`), gated by the
same `require_native_owner` Desktop+owner check as the pi-package ops —
landing owners included, so fff is configurable **before** any workspace
is opened (advisor cannot: its model catalog needs the bridge's
in-process modelRegistry).

- `get_fff_config` → `{ values, envShadowed: string[] (field names),
  flagShadowed: string[], shadowNames: Record<field, name>,
  invalid?: { reason } }`. Effective chain per field: env > file > schema
  default. Env is read from the **host process** — accurate for the
  embedded Pi because the child inherits the host env and
  `launch.environment` never sets `FFF_*`/`PI_FFF_*`. **Flag detection is
  dropped host-side**: the host constructs the embedded Pi's argv and
  never adds `--fff-*`, while a terminal `pi`'s flags are per-instance
  and unobservable from the host; `flagShadowed` stays in the payload as
  an always-empty array so the renderer shape is stable.
  `shadowNames` quotes the exact var string from the table so the
  renderer's badge never assumes a `PI_FFF_*` pattern; env values that
  fail pi-fff's parse (booleans accept only 1/true/0/false) are not
  shadows — they fall through, matching `getConfigValue`.
- `set_fff_config` → takes a **single changed key** (save-on-change: one
  control, one call) — never a full-form serialization, so an untouched
  default can never solidify into an explicit file key. The file is
  re-read leniently (JSON parse only) and rebuilt schema-clean: only
  known keys with valid values carry over, so unknown or wrong-typed
  junk is dropped (the opposite of advisor's preserve-unknowns) and
  Picot can never write an invalid file; a JSON-parse-broken file is
  never silently overwritten — the explicit reset is the destructive
  path. Writes go through `host_config::write_json` (proper-lockfile +
  tmp+rename + `0600`, 2-space pretty), preserve `$schema` (write it on
  create). `reset: true` on the same op writes the minimal `$schema`-only
  file — reset means full defaults, no third op.
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

- Registered under `@ff-labs/pi-fff`; depends on **transport only**
  (host control ops), so the section renders in the landing settings as
  well. Advisor's entry stays gateway-gated and landing-hidden.
- Flat: mode segmented control, 4 toggles (extensions-page switch
  pattern).
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

- Rust inline tests (`fff_config.rs`): missing file → defaults + no
  shadow; env shadowing computed per field with the exact var names from
  the table (garbage env is not a shadow); malformed/schema-invalid
  files → fff's failure reasons; set drops unknown keys, never
  solidifies untouched defaults, preserves/creates `$schema`; null/empty
  path clears; enum/type validation; parse-broken file demands reset;
  reset writes the `$schema`-only file; writes are 2-space pretty with
  `0600`.
- Renderer tests: transport-only mount (landing scenario), layout
  groups, shadowed-control disabling with the exact env-var badge,
  invalid-state two-click reset writes the `$schema`-only file and
  rebuilds, restart hint presence, failed save/load surfaces errors.
- `bun run check`, `bun run check:rust`, focused vitest, then
  `bun run test`.
- `ARCHITECTURE.md`: fff ops described on the host control plane
  (moved out of the bridge paragraph).

## Out of scope

Editing `/fff-mode` session state (session-scoped by design), shell rc
file writes (`~/.zshrc`/`.bashrc`/`setx`), launch-env injection (the
superseded amendment), `--fff-mode` flag injection,
`/fff-health` / `/fff-rescan` surfacing.
