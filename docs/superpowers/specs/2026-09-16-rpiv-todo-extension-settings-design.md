# rpiv-todo Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #1 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md).
Renderer map and detail-page mounting are defined by
[`2026-09-13-advisor-extension-settings-design.md`](2026-09-13-advisor-extension-settings-design.md);
**transport follows the fff host-op precedent**
([`2026-09-13-fff-extension-settings-design.md`](2026-09-13-fff-extension-settings-design.md),
migrated to host control ops for landing configurability): this package is
pure file config with no model dependency, so it lands on the host plane
and renders on the landing page.

## Goal

A settings section for `npm:@juicesharp/rpiv-todo` in Settings → Installed
Extensions: overlay line budget and collapse shortcut.

## Research findings (source-verified, v2.10.1)

- Config: `~/.config/rpiv-todo/config.json` via the nested
  `@juicesharp/rpiv-config` — **XDG_CONFIG_HOME-aware with legacy
  `~/.config` fallback** (same resolver family as advisor; the config op must
  reuse the advisor XDG-fixed path helper, not hardcode `HOME/.config`).
- Fields:
  - `maxWidgetLines?: number` — content-row budget; `< 3` or non-number falls
    back to default **12**; no ceiling (`getMaxWidgetLines()`).
  - `collapseKey?: string` — pi-tui KeyId grammar (`ctrl+shift+t` default,
    `"off"` disables); invalid specs fall back to default, so validation
    exists in-package (`isValidCollapseKeySpec`, exported for tests).
  - `guidance?: GuidanceFields` — preserved on write, not edited (advisor parity).
- **Effect timing: immediate.** `loadConfig()` runs on every call
  ("read fresh on every call (per-render — no `/reload`)" — package comment).
  The only Picot-editable extension so far where GUI edits apply live.
- Picot already renders this package's overlay via
  `public/ui/rpiv-todo-mirror.js` (widget-mirror registry); the line budget
  directly shapes the mirrored widget.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| `maxWidgetLines` control | Number stepper, floor 3, no ceiling; empty input clears the key (default 12 shown as placeholder). |
| `collapseKey` control | Text input + validation against the KeyId grammar ported from the package (`isValidCollapseKeySpec` — ported once into the shared Rust helper for both rpiv entries); `"off"` allowed; invalid input rejected inline, never silently defaulted on write. |
| Mirror coupling | None in this spec — the mirror reads the same file on its own render cadence; no cross-notifications. |

## Contract

### Host ops — Rust module with the shared rpiv path helper

Host control ops on the fff pattern (`get_fff_config`/`set_fff_config`):
transport methods gated by the same `require_native_owner` Desktop+owner
check, landing owners included — **configurable before any workspace is
opened**. No bridge op, no `extension-settings.ts` entry.

- `get_todo_config` → `{ values: { maxWidgetLines?, collapseKey? },
  effective: { maxWidgetLines, collapseKey } }` so the renderer can show
  defaults honestly.
- `set_todo_config` → single-key save-on-change (`{ key, value }`, `null`
  clears), read-modify-write preserving `guidance` and unknown keys (rpiv
  family tolerates unknown keys), written via `host_config::write_json`
  (proper-lockfile + tmp+rename + `0600`, 2-space pretty).

Path: the rpiv-config XDG-aware resolver ported **once** into a shared
Rust helper (absolute `XDG_CONFIG_HOME` with `~` expansion > `~/.config`
legacy), reused verbatim by the ask-user-question entry — never the plain
`HOME/.config` assumption (the advisor review's XDG finding, fixed at the
foundation this time).

### Renderer

- Transport-only dependency — the section renders in landing settings too
  (fff precedent; advisor's gateway-gated entry stays landing-hidden).
- Section: line-budget stepper + collapse-key input + fixed hint
  「立即生效」. Save on change with the standard save-status indicator;
  invalid collapseKey rejected before send with an inline error.

### i18n

`settings.extensionTodo.*` in en/zh/ja/es: title, lineBudget label,
collapseKey label, off sentinel, invalid-key error, immediate hint,
saved/saveFailed.

## Verification

- Rust tests (`bun run check:rust`): XDG resolution + legacy fallback;
  `< 3` floor on write; KeyId grammar accept/reject matrix; unknown keys +
  `guidance` preserved; 0600.
- Renderer tests: defaults display, single-key payloads, invalid-key inline
  rejection, hint presence, and landing render (transport-only mount).
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph gains one clause.

## Out of scope

`guidance` editing, overlay theming, mirror-side behavior changes, per-list
budgets (package has none).
