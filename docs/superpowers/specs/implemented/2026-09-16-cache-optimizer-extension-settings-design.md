# pi-cache-optimizer Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #10 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — file + env display only, landing-capable.

## Goal

A settings section for `npm:pi-cache-optimizer`: footer stats mode (writable)
plus read-only visibility of the env opt-out switches and the persisted
per-model cache-key repairs.

## Research findings (source-verified, v2.8.10 `index.ts`)

- Config: `~/.pi/agent/pi-cache-optimizer-config.json`.
- **Strict schema**: `{ version: 1|2, footerMode?, promptCacheKey?:
  { omit?: string[] } }` — any unknown top-level key makes the whole file
  unparsable to the package (falls back to defaults). fff-style
  schema-clean single-key writes are mandatory; unknown keys are dropped on
  write, never preserved.
- `footerMode`: `total | session | process` (default `session`); persisted
  config beats `PI_CACHE_OPTIMIZER_FOOTER_MODE` env; env beats default.
- `promptCacheKey.omit[]` is written only by the package's confirmed
  `/cache-optimizer fix` flow with receipt bookkeeping
  (`pi-cache-optimizer-config-receipt.json`) — GUI edits here would
  desynchronize receipts.
- Opt-out env switches (read-only from Picot, fff spec policy):
  `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE`, `…_NO_SKILL_COMPRESSION`,
  `…_NO_OPENAI_CACHE_KEY`, `…_OPENAI_CACHE_KEY`.
- Effect timing: config cached at extension load — changes need Pi restart
  or `/reload`; hint 「重启 Picot 或 /reload 后生效」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Writable surface | `footerMode` only (3-way select). Everything else displays. |
| `promptCacheKey.omit` | Read-only list (model keys) + hint that repairs are made via `/cache-optimizer fix`. |
| Env switches | Read-only status rows with the exact var names, ON/OFF state — the user's shell domain (fff policy), surfaced not written. |
| Version handling | Reads v1/v2; writes v2 (additive, package accepts); preserve `version` when present. |

## Contract

### Host ops — `src-tauri/src/cache_optimizer_config.rs`, control-plane cases in `main.rs`

- `get_cache_optimizer_config` → `{ footerMode, footerModeSource:
  "config" | "env" | "default", omitList: string[], envSwitches:
  Record<string, boolean>, invalid?: { reason } }` — env switches read from
  the host process (fff env rationale; display-only either way).
- `set_cache_optimizer_config` → `{ key: "footerMode", value }` — the ONLY
  writable key; schema-clean rebuild in Rust (version + footerMode +
  preserved `promptCacheKey` block); via `host_config::write_json`
  (proper-lockfile + tmp+rename + `0600`). `require_native_owner` gating,
  landing included.

### Renderer

- Transport-only dependency (landing-capable, fff precedent).
- 3-way footerMode select with source badge (配置 / 环境 / 默认);
  read-only omit list; read-only env switch rows; hint 「重启 Picot 或
  /reload 后生效」.

### i18n

`settings.extensionCacheOptimizer.*` in en/zh/ja/es: title, footerMode
label + 3 modes + descriptions, source badges, omit list title, env section
title, hint, saved/saveFailed.

## Verification

- Rust tests (`bun run check:rust`): v1/v2 read; footerMode source
  precedence; single-key write rebuilds schema-clean (unknown keys dropped,
  promptCacheKey preserved); invalid file → error state (no reset — repairs
  are receipt-bound); 0600.
- Renderer tests: select + source badge, read-only sections, payload shape,
  landing render.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

Triggering fixes/rollbacks (command domain), stats surfaces, models.json
editing (Models page owns that file), writing env vars.
