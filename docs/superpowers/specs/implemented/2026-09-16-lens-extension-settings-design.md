# pi-lens Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #11 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec, **transport on the fff host-op
precedent** — file + env display only, landing-capable with a cwd parameter
for the project layer.

## Goal

A settings section for `npm:pi-lens`: the runtime toggles and analyzer
switches from the package's declarative flag registry — the subset a GUI
user actually flips.

## Research findings (source-verified, v4.1.6 `docs/settings.md` + `docs/configuration.md`)

- Config is **layered**: global `~/.pi-lens/config.json` (relocatable via
  `PI_LENS_CONFIG_PATH`) and project `.pi-lens.json` (repo root; nearest
  wins per-field; only three project-scoped mutation keys). One declarative
  registry drives both CLI flags and config keys.
- Precedence per toggle (five tiers on the package side): env (only
  `PI_LENS_NO_CONTEXT_INJECTION` today) > CLI flag > nearest project file >
  global file > default. `--no-*` flags are one-way (can disable, never
  re-enable). **Host-side consequence** (fff precedent, see Contract): the
  flag tier is unobservable from the host and Picot never sets lens flags —
  the effective precedence the GUI computes is env > project > global >
  default, with the flag tier documented as dropped.
- The full flag registry (30+ entries): `lens.enabled`, `lsp.enabled`,
  `format.enabled`/`format.mode`, `autofix.enabled`, `tests.enabled`,
  `delta.enabled`, `guard.enabled`/`guard.sharedCheckout`,
  `readGuard.enabled`, `contextInjection.enabled`, `turnSummary.enabled`,
  `actionableWarnings.*` (4 keys), `ui.compactToolLine`, `tools.lazy`,
  analyzers `knip|jscpd|madge|gitleaks|govulncheck|deadCode|complexity`.
  `enabled`, plus non-toggle keys `ignore: string[]`, `maxProjectFiles`
  (default 8000), `rules.high-complexity.threshold` (default 25).
- Rich-but-advanced keys NOT in v1: `lsp.servers`/`serverOverrides`/
  `warmFiles`/`disabledServers`, `tools.<name>.enabled` tree.
- `$schema` key exists (`pi-lens-config-v1.json`) — preserve on write (fff
  parity).
- Effect timing: toggles are consulted at session start (env strictly at
  process start); hint 「新会话生效（环境变量需重启）」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Layer scope | v1 edits **global only**. A project `.pi-lens.json` present in the host op's `cwd` → per-field badge 「项目覆盖」 + effective value display (project wins per-field). Project editing out. |
| Field curation | Groups: ① 运行时总开关 ② 反馈链 (lsp/format/autofix/tests/delta) ③ 防护 (guard×2/readGuard/contextInjection) ④ 报告 (turnSummary/actionableWarnings×4/ui.compactToolLine) ⑤ 分析器 (7 switches + tools.lazy) ⑥ 高级 (ignore list + maxProjectFiles + complexity threshold, disclosure). |
| Toggle display | Effective-value switch with source badge (env/project/global/default — the flag tier is dropped host-side, see Research) — the registry makes the provenance computable in one pass; a switch the user cannot flip (env/project shadow) renders disabled, fff pattern. |
| `--no-*` one-way rule | UI never writes a "re-enable" that a session flag would override — shadow badge carries that truth; hint line explains it. Flag shadows themselves are not computed host-side (fff flag-detection rationale verbatim: the host constructs the embedded Pi's argv and never adds `--no-lsp` etc., while a terminal pi's flags are per-instance and unobservable). |
| Landing behavior | The host op takes an optional `cwd`; on landing the project layer is not consulted and the renderer shows the 「进入工作区后可见项目覆盖」 hint; global editing stays fully functional. |
| Unknown keys | Preserve-unknowns (advisor semantics): the schema is far larger than v1's curation; Picot must never rebuild schema-clean and drop an advanced key the user hand-wrote. Single-key writes only. |

## Contract

### Host ops — `src-tauri/src/lens_config.rs`, control-plane cases in `main.rs`

- `get_lens_config({ cwd? })` → `{ values, effective, sources:
  Record<key, "env" | "project" | "global" | "default">, projectFile?:
  string | null, configPath, relocatedByEnv }` for the curated key set only.
  Env (`PI_LENS_*`) read from the host process (fff rationale);
  `PI_LENS_CONFIG_PATH` relocation surfaces as a badge; `cwd` absent
  (landing) → project tier not consulted, `projectFile: null`.
- `set_lens_config` → `{ key, value }` single-key over the global file;
  enum/range validation per the registry; preserve-unknowns + `$schema`;
  via `host_config::write_json` (proper-lockfile + tmp+rename + `0600`).
  `require_native_owner` gating, landing included.

### Renderer

- Transport-only dependency — landing renders the global toggles plus the
  「进入工作区后可见项目覆盖」 hint (fff precedent for the transport).
- Grouped switch sections with source badges; advanced disclosure for
  ignore/maxProjectFiles/threshold (ignore = one-line-per-entry list editor,
  floor/ceiling on numbers); hint 「新会话生效（环境变量需重启）」.

### i18n

`settings.extensionLens.*` in en/zh/ja/es (~40 keys: group titles, ~25
toggle labels, badge texts, advanced labels, hint, saved/saveFailed).

## Verification

- Rust tests (`bun run check:rust`): precedence computation across the four
  host-visible tiers; project-badge detection with `cwd`; single-key writes
  preserve unknown keys + `$schema`; enum and range rejects; relocated env
  read-only; `cwd: None` landing path; 0600.
- Renderer tests: grouped toggles reflect effective values with badges;
  shadowed controls disabled; advanced editor validation; landing hint.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  host-op paragraph.

## Out of scope

LSP server registration/overrides, per-tool enable tree, project-file
editing, rule authoring (ast-grep/tree-sitter catalogs), MCP server
configuration.
