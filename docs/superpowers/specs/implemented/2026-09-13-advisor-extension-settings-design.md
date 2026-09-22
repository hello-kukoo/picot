# Advisor Extension Settings Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling session, Q1–Q3);
revised same day after spec review (i18n namespace, cross-spec parity
with the fff spec). Implemented 2026-09-15; spec tracks code.
**Landing: available** since 2026-09-21 — landing.js passes the config-runtime
gateway proxy into `setupPackageManager`, so the advisor section renders and
saves at landing (global-only; rides
`2026-09-18-landing-bridge-runtime-design.md`).
**Date:** 2026-09-13

## Goal

Render an installed extension's configuration in Settings → Installed
Extensions: a per-extension settings section on the package detail page,
starting with `@juicesharp/rpiv-advisor` (reviewer model + reasoning
effort).

## Background — facts established by research

- Advisor config lives at `~/.config/rpiv-advisor/advisor.json`
  (XDG-aware via `@juicesharp/rpiv-config`). The extension's own save
  (`saveJsonConfig`) is a plain `writeFileSync` with best-effort `0600`
  chmod — **not atomic** (interrupted writes can truncate; some
  filesystems silently ignore the chmod). Picot's set op is deliberately
  stricter: tmp+rename atomic write, best-effort `0600` (host_files
  discipline). Keys: `modelKey` (`"provider/modelId"`; absent = advisor off), `effort`
  (`minimal`…`max`; absent = no reasoning sent), plus `guidance` and
  `disabledForModels` (out of scope, must survive writes — the extension's
  own `saveAdvisorConfig` is read-modify-write and preserves them).
- Advisor's own save is dual-write: module-level in-memory state (immediate
  effect) + config file. **TUI `/advisor` takes effect in the current
  session only because it mutates memory in-process.**
- From the GUI there is no channel into another extension's memory:
  `/advisor`'s pickers are pure pi-tui overlays (`ctx.ui.custom` resolves
  undefined in RPC — dialogs never reach Picot); bridge-side imports of
  `advisor/state.js` would yield a *different module instance*. Therefore
  **file write + next-`session_start` apply is the architectural ceiling**
  for a GUI settings editor. Advisor re-reads the file on every
  `session_start` (`restore.ts`), so Picot's new-session/switch-session
  flow applies it without a Pi process restart.
- Effort levels are model-dependent: `getSupportedThinkingLevels(model)`
  (`@earendil-works/pi-ai`, importable in the bridge process).
- Picot's Settings → Packages detail page is `renderDetail()` in
  `public/settings/package-manager.js` (`#pkg-manager-detail`); the
  sanctioned configuration channel is the picot-bridge
  `/picot-config <json>` command with id-matched notify responses
  (`public/settings/config-gateway.js`).

## Grilling decisions

| Branch | Decision |
| --- | --- |
| Abstraction | Per-package renderer map (`pkgName → renderer`), advisor is the first entry. No generic settings schema — pi extensions have no settings declaration mechanism, so schemas would be hand-written anyway; the map is the extension point. |
| Effect timing | Fixed hint line in the section:「更改将在新会话生效」. The TUI's same-session effect is unattainable from the GUI (see Background); the hint keeps expectations honest. |
| Model/effort coupling | Model dropdown = **composer parity**（Dr. Lin 2026-09-21 决议）：`list_model_catalog` ∩ `available ∩ visible` + `list_scoped_models`，与消息输入框同一个列表（scoped 分组在前、其余 enabled 在后，optgroup 呈现），含「关闭 Advisor」行 (`modelKey` absent)。 Effort dropdown = `getSupportedThinkingLevels(selectedModel)` + an「off（不发送 reasoning）」row. Switching to a model that does not support the stored effort **auto-resets effort to off** with a light notice — mirrors the TUI picker rebuilding its effort list per model, never leaves an illegal model+effort pair on disk. |

## Contract

### Bridge op module — `extensions/extension-settings.ts`

- `advisor.config.get` → `{ modelKey?: string, effort?: string, models }`
  resolved through the same `~/.config/rpiv-advisor/advisor.json` path
  (rpiv-config `configPath`); missing file = off state. `models` rides in
  the same response (one round trip for the renderer): each
  `{ key, name, levels, available }` where `levels` is
  `getSupportedThinkingLevels` ∩ the GradedEffort ordinal — the same
  intersection the TUI's `buildEffortItems` computes, so the GUI can
  never offer an effort the advisor would refuse to rank.
- `advisor.config.set` → read-modify-write preserving unknown keys
  (`guidance`, `disabledForModels`), atomic write (tmp+rename — stricter
  than `saveJsonConfig`'s plain `writeFileSync`), best-effort `0600`
  (same best-effort posture as `saveJsonConfig`). Takes `modelKey` and
  `effort`, each absent = leave unchanged, null/"" = clear; the whole
  visible state is sent on every save-on-change so an illegal
  model+effort pair can never be persisted. Returns the saved config;
  write failure surfaces to the UI without mutating state shown.
- Model catalog + per-model supported levels reuse in-process
  `modelRegistry` / `pi-ai` (bridge lives in the Pi process).
- Registered in `picot-bridge.ts` operations; WebView talks through the
  existing `config-gateway.js` round-trip.

### UI — `public/settings/package-extension-settings.js`

- Exported `renderExtensionSettings(detailEl, pkg)`; called from
  `renderDetail()` after the resources block; no-op for packages without a
  renderer entry.
- Advisor renderer: model dropdown + effort dropdown + hint line; save on
  change with the existing save-status indicator pattern (auto-save,
  like other Settings pages); transient notice for effort auto-reset.
- Off state (absent `modelKey`) renders effort as disabled.

## i18n

Keys under `settings.extensionAdvisor.*` in en/zh/ja/es: section title,
model/effort labels, 关闭 Advisor row, off row, new-session hint,
effort-reset notice, save-failure error.

## Verification

- Op tests: missing file → off; round-trip preserves `guidance` +
  `disabledForModels`; `0600` and atomicity; XDG resolution.
- Renderer tests: off-state rendering, coupling reset on unsupported
  effort, hint line presence, save-on-change status.
- `bun run check`, focused vitest, then `bun run test`.
- `ARCHITECTURE.md`: add the extension-settings ops to the bridge
  description.

## Out of scope

`disabledForModels` and `guidance` editing (preserved but not rendered),
settings sections for other extensions, same-session application.
