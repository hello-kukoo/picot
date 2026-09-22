# rpiv-ask-user-question Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #2 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — pure file config, no model dependency, landing-capable.

## Goal

A settings section for `npm:@juicesharp/rpiv-ask-user-question`: the
questionnaire overlay's collapse shortcut.

## Research findings (source-verified, v2.10.1)

- Config: `~/.config/rpiv-ask-user-question/config.json` — same
  `@juicesharp/rpiv-config` XDG-aware resolver + legacy fallback as advisor.
- Fields: `collapseKey?: string` (default `"ctrl+]"`, `"off"` disables;
  package notes Latin-American layouts want `ctrl+}` — the doc comment is the
  reason the control must be a free KeyId input, not a fixed list) and
  `guidance?: GuidanceFields` (preserved, not edited).
- Validation: `isValidCollapseKeySpec` + `resolveCollapseKey` in-package
  (invalid → default on read; the GUI validates on write).
- Effect timing: config is loaded per questionnaire render (family pattern —
  same call-site shape as rpiv-todo's fresh reads; verify at implementation).
- Picot integration context: this package's questionnaire UI is the subject of
  the ask-user-question rich-renderer spec (2026-09-13) — GUI settings and
  rich rendering are orthogonal and must not couple.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Scope | Single field (`collapseKey`) + hint. If grilling judges one field too thin for a section, defer this entry until the package grows more knobs rather than padding it. |
| Key input | Same KeyId-input control as rpiv-todo (shared widget, two labels) — build once, use for both. |
| Effect hint | 「立即生效」pending the implementation-time verification of read timing; downgrade to 「新会话生效」 if disproven. |

## Contract

### Host ops — same Rust module as rpiv-todo (shared path helper)

- `get_askuser_config` → `{ collapseKey?: string, effectiveCollapseKey }`.
- `set_askuser_config` → single-key `{ key, value }`, `null` clears;
  preserve-unknowns read-modify-write via `host_config::write_json`
  (proper-lockfile + tmp+rename + `0600`); `require_native_owner` gating,
  landing included.

### Renderer

- Transport-only dependency (landing-capable, fff precedent). Reuses the
  rpiv-todo collapse-key input component; section title
  「Ask User Question」; fixed hint; save-on-change status.

### i18n

`settings.extensionAskUser.*` in en/zh/ja/es (title, collapseKey label, off
sentinel, invalid-key error, hint, saved/saveFailed).

## Verification

- Rust tests (`bun run check:rust`): XDG + legacy fallback (shared helper,
  tested once for both rpiv entries); KeyId accept/reject;
  `guidance`/unknown preserved; 0600; single-key contract.
- Renderer tests: default display, payload shape, invalid-key inline error,
  landing render.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

`guidance` editing, questionnaire rendering behavior (owned by the
2026-09-13 rich-renderer spec), keyboard-layout detection.
