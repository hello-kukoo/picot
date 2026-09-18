# pi-vcc Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #5 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — file + env only, landing-capable.

## Goal

A settings section for `npm:@sting8k/pi-vcc`: the four compaction-behavior
booleans.

## Research findings (source-verified, v0.7.2 `src/core/settings.ts`)

- Config: `~/.pi/agent/pi-vcc-config.json`, relocatable via
  `PI_VCC_CONFIG_PATH` (badge-worthy shadow, fff pattern).
- Fields (all boolean, package defaults):
  - `overrideDefaultCompaction: true` — pi-vcc owns `/compact`, `/compact
    <text>`, threshold and overflow; `false` leaves them to pi core.
  - `smartKeepTail: true` — boost keep-tail when keep:1 tail ≤ 5k up to ≤ 25k.
  - `continueAfterThresholdCompact: true` — permission (not guarantee) to
    continue after an automatic compaction.
  - `debug: false` — write `/tmp/pi-vcc-debug.json` snapshots.
- `scaffoldSettings()` fills missing keys preserving existing values; loader
  is spread-over-defaults (unknown keys tolerated — preserve-unknowns).
- Effect timing: settings are loaded per compaction cycle (verify at
  implementation); hint 「下次压缩生效」 with the caveat that an in-flight
  compaction keeps its loaded snapshot.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Control set | Four switches, each with a one-line description (these booleans gate compaction semantics — the descriptions are load-bearing, not decoration). |
| `debug` exposure | Expose, but styled as a diagnostics row (muted) — it writes snapshots to /tmp. |
| Path badge | `PI_VCC_CONFIG_PATH` set → whole section renders read-only with one badge naming the env var (path relocation moves the file out of Picot's write scope entirely). |

## Contract

### Host ops — `src-tauri/src/vcc_config.rs`, control-plane cases in `main.rs`

- `get_vcc_config` → `{ values, configPath, relocatedByEnv: boolean }` —
  `PI_VCC_CONFIG_PATH` read from the host process (fff env rationale).
- `set_vcc_config` → single-key `{ key, value }`, boolean-validated;
  preserve-unknowns; via `host_config::write_json` (proper-lockfile +
  tmp+rename + `0600`); reject with a clear error when the file was
  relocated via env (read-only surface). `require_native_owner` gating,
  landing included.

### Renderer

- Transport-only dependency (landing-capable, fff precedent).
- Four switch rows + descriptions + hint 「下次压缩生效」; relocated-env
  state renders the whole section read-only with one badge.

### i18n

`settings.extensionVcc.*` in en/zh/ja/es: title, 4 labels + descriptions,
relocated badge, hint, saved/saveFailed.

## Verification

- Rust tests (`bun run check:rust`): defaults on missing file; single-key
  writes; env-relocation read-only behavior; unknown preserved; 0600.
- Renderer tests: four toggles reflect stored values, single-key payloads,
  relocated state disables controls, landing render.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

Compaction triggering (`/pi-vcc` command), keep:N overrides, benchmarking,
stats surfaces.
