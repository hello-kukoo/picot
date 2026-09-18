# pi-goal Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #6 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — pure file config, landing-capable.

## Goal

A settings section for `npm:@narumitw/pi-goal`: RPC channel toggle and the
two continuation limits.

## Research findings (source-verified, v0.54.5 `src/settings.ts`)

- Config: `~/.pi/agent/pi-goal.json`.
- Fields:
  - `rpc.enabled: boolean` (default `false`).
  - `continuationLimits.automaticTurns: number | null` (default `25`).
  - `continuationLimits.noProgressTurns: number | null` (default `3`).
    `null` = unlimited; values must be safe integers `> 0`.
- **Strict whole-file normalization**: `normalizeGoalSettings` returns
  `undefined` on ANY invalid key/type — one bad field makes the package fall
  back to defaults wholesale. Consequence: the host op must validate every
  write against the package grammar and refuse (not silently default) on
  conflict, and single-key writes must re-validate the ENTIRE merged
  document before saving (a pre-existing invalid file must surface as an
  error state, never be "fixed" by partial writes).
- Writes: package does mkdir + writeFileSync + rename (its own atomic path).
- Effect timing: limits are read when a goal run starts; rpc.enabled gates
  RPC registration at load — hint 「新目标生效；RPC 开关需重启」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Limit controls | Number stepper + 「无限制」 checkbox (writes `null`); steppers floor at 1. |
| Invalid pre-existing file | Read-only error state showing the package's invalid reason + 「重置为默认」 escape (reset = defaults document `{ rpc: { enabled: false }, continuationLimits: { automaticTurns: 25, noProgressTurns: 3 } }` — safe here because the schema is fully known and tiny). |
| rpc.enabled | Expose with a one-line description of what the RPC channel is for; default-off shown honestly. |

## Contract

### Host ops — `src-tauri/src/goal_config.rs`, control-plane cases in `main.rs`

- `get_goal_config` → `{ settings, invalid?: { reason } }` (normalized
  effective values + raw doc for preservation).
- `set_goal_config` → single-key `{ key, value }` where key is one of
  `rpc.enabled`, `continuationLimits.automaticTurns`,
  `continuationLimits.noProgressTurns`; **merged-document validation
  before every write** (package grammar — the strict whole-file
  normalization lives in Rust); `reset: true` writes the defaults
  document; via `host_config::write_json` (proper-lockfile + tmp+rename +
  `0600`). `require_native_owner` gating, landing included.

### Renderer

- Transport-only dependency (landing-capable, fff precedent).
- RPC switch + two steppers with unlimited checkboxes + hint; invalid-file
  error state with two-click reset (fff pattern).

### i18n

`settings.extensionGoal.*` in en/zh/ja/es: title, rpc label + description,
two limit labels + unlimited, hint, invalid-config error, reset labels,
saved/saveFailed.

## Verification

- Rust tests (`bun run check:rust`): defaults; single-key writes; `null`
  limit; whole-file re-validation (pre-existing invalid → set refuses with
  reason); reset writes defaults; 0600.
- Renderer tests: stepper + unlimited interplay, payloads, invalid state,
  landing render.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

Goal lifecycle UI (wait/blocked decisions), markers, accounting, per-goal
overrides.
