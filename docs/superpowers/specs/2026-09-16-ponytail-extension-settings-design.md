# Ponytail Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #4 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — file + env only, landing-capable.

## Goal

A settings section for `npm:@dietrichgebert/ponytail`: default mode and the
two visibility switches.

## Research findings (source-verified, v4.9.0 `hooks/ponytail-config.js`)

- Config resolution for the default mode: `PONYTAIL_DEFAULT_MODE` env >
  config file `defaultMode` > `"full"`. Config dir:
  `$XDG_CONFIG_HOME/ponytail` > `~/.config/ponytail` (macOS/Linux) >
  `%APPDATA%\ponytail` (Windows); file `config.json`.
- Fields: `defaultMode` (runtime levels; `review` is session-only and NOT a
  legal default per the package's own rule), `quietStartup === true`
  (env `PONYTAIL_QUIET_STARTUP`), `hideStatus === true`
  (env `PONYTAIL_HIDE_STATUS`).
- Effect timing: default mode is read at session start; session-level
  `/ponytail <mode>` overrides until changed. Hint: 「新会话默认」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Mode control | Segmented control lite / full / ultra (three runtime levels only; `off` = clear the key → fallback to built-in `full`, so offer 「使用默认」 explicitly if clearing, not an off button). |
| Env shadows | All three keys have env overrides — reuse the fff shadow-badge pattern: env present → control disabled + badge naming the exact var. Host-side env read is accurate for the embedded Pi (child inherits host env; `launch.environment` never sets `PONYTAIL_*`), fff rationale verbatim. |
| Scope | The package also ships skills/hooks whose behavior derives from the mode; no additional knobs exist. Three controls is the complete surface. |

## Contract

### Host ops — `src-tauri/src/ponytail_config.rs`, control-plane cases in `main.rs`

- `get_ponytail_config` → `{ defaultMode?: string, quietStartup?: boolean,
  hideStatus?: boolean, effective: {…}, envShadowed: string[], shadowNames }`
  with env read from the host process (fff precedent).
- `set_ponytail_config` → single-key `{ key, value }`; `defaultMode`
  validated against the runtime levels (reject `review` and unknown values —
  the package would silently fall back); preserve-unknowns; via
  `host_config::write_json` (proper-lockfile + tmp+rename + `0600`);
  BOM-tolerant read (package strips a UTF-8 BOM — the host reader must too).
- Path: `$XDG_CONFIG_HOME/ponytail` > `~/.config/ponytail` (Unix) /
  `%APPDATA%\ponytail` (Windows), file `config.json`.

### Renderer

- Transport-only dependency (landing-capable, fff precedent).
- Mode segmented control + two switches + per-key env badges + hint
  「新会话默认」. Save-on-change status.

### i18n

`settings.extensionPonytail.*` in en/zh/ja/es: title, mode label + 3 level
labels, quietStartup/hideStatus labels, shadow badge, hint, saved/saveFailed.

## Verification

- Rust tests (`bun run check:rust`): XDG/APPDATA dir resolution; env-shadow
  computation for all three keys; `review` rejected; BOM round-trip;
  unknown preserved; 0600.
- Renderer tests: segmented selection, badge disable, single-key payloads,
  landing render.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

Session-mode switching (`/ponytail` command), skill-body filtering behavior,
statusline setup, review mode (session-only by package design).
