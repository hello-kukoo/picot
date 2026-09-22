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
- **Known-subtree validation, unknown keys tolerated**（2026-09-21 复核 pi-goal
  0.54.8 `src/settings.ts` + `docs/settings.md`，修正原先「全文档严格校验」的
  错误结论）：`normalizeGoalSettings` 只校验 `rpc` / `continuationLimits`
  两棵子树；**未知/已下线的键（`toolVisibility`、`experimental`…）一律忽略**，
  且保存时 `{...raw, rpc, continuationLimits}` 原样保留。Consequence: 主机 op
  只对这两棵子树做类型校验（类型错误 → 只读错误态），未知键必须容忍并在写入时
  保留；`experimental.goals === true` 是**旧设置警告**（包会照常加载文件），
  不是错误。
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
