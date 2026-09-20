# pi-extension-safety-guard Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #8 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec. **Transport: stays on the bridge** —
the auto-review model picker needs the in-process modelRegistry
(advisor's rationale verbatim). **Landing: available** (Dr. Lin,
2026-09-20): on the landing page the section rides the bridge-service
config runtime
([`2026-09-18-landing-bridge-runtime-design.md`](2026-09-18-landing-bridge-runtime-design.md) —
its host loads picot-config, which dispatches these ops), same config
file and ops as the workspace path, global-only; no per-surface
divergence.

## Goal

A settings section for `npm:@firstpick/pi-extension-safety-guard`: master
switch, seven rule categories, protected-path switches, command preview
context lines, and the auto-review model.

## Research findings (source-verified, v0.2.9 `src/config.mjs`)

- Config: `~/.pi/agent/safety-guard.json`, relocatable via
  `PI_SAFETY_GUARD_CONFIG_FILE` (path badge / read-only when set).
- Schema (package normalizes on read; own writer does merge+patch, tmp+rename
  with 0600 — Picot mirrors, does not bypass):
  - `enabled: boolean` (default true).
  - `categories`: 7 booleans — `git, filesystem, docker, package, system,
    database, secrets` (all default true).
  - `protectedPaths: { write: boolean, edit: boolean }` (default true).
  - `contextLines: { before: number, after: number }` — 0–20, default 3.
  - `autoReview: { enabled: boolean, model: { provider, modelId,
    thinkingLevel } }` (default off; thinking levels from the package's
    supported list).
- Allow stores are separate: global `~/.pi/agent/safety-guard-allow.json` +
    per-project `<cwd>/.pi/safety-guard-allow.json` (self-gitignoring).
- Effect timing: config is read per guard event (the package's own settings
    UI writes take effect immediately) — hint 「立即生效」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Category controls | Seven switches grouped under one 「规则分类」 label, each with its package label (git history / filesystem deletion / …). |
| Auto-review model | Advisor-style model dropdown (live registry) + thinking select from the package's supported levels + enable switch; unset model = disabled regardless of switch. |
| Allow stores | v1: read-only counts (global + current project) with a hint that management happens in-session via the guard dialogs. Editing the allow list from a settings page invites rubber-stamping dangerous grants. At landing: global count only — no current project (the standard global-only degradation). |
| Security posture | This page edits a security control: every write must go through the package's merge+patch validation (assertSafetyGuardConfigPatch equivalent server-side); never write a raw document. |

## Contract

### Bridge ops — added to `extensions/extension-settings.ts`

- `safetyGuard.config.get` → `{ config, configPath, relocatedByEnv, allowCounts }`.
- `safetyGuard.config.set` → `{ key, value }` single-key patch validated
  against the package grammar (nested keys as dotted paths:
  `categories.git`, `contextLines.before`, `autoReview.model.provider`, …);
  merged through the package's merge semantics; atomic write, 0600.

### Renderer

- Master switch; categories group; protected-path pair; two 0–20 steppers;
  auto-review group; allow-store counts (read-only); hint 「立即生效」.

### i18n

`settings.extensionSafetyGuard.*` in en/zh/ja/es (~25 keys: title, group
labels, category labels, contextLines labels, autoReview labels, allow
counts, hint, saved/saveFailed).

## Verification

- Op tests: dotted-path patches; range validation 0–20; category enum;
  relocated-env read-only; merge preserves unknown keys per package
  semantics; 0600.
- Renderer tests: category toggles, stepper bounds, model picker payload,
  allow counts render.
- Landing variant: section renders through the landing config gateway (the
  config-runtime spec's lazy spawn); allow counts show global only.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md line.

## Out of scope

Allow-list editing, rule pattern editing (hardcoded in-package), the guard
dialog UX, auto-review result surfaces.
