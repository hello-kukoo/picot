# pi-plan-mode Extension Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #7 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec. **Transport: stays on the bridge** —
the implementation-model picker needs the in-process modelRegistry
(advisor's rationale verbatim). **Landing: available** (Dr. Lin,
2026-09-20): on the landing page the section rides the bridge-service
config runtime
([`2026-09-18-landing-bridge-runtime-design.md`](2026-09-18-landing-bridge-runtime-design.md) —
its host loads picot-config, which dispatches these ops), same config
file and ops as the workspace path, global-only; no per-surface
divergence.

## Goal

A settings section for `npm:@narumitw/pi-plan-mode`: plan thinking level,
implementation model/thinking, plan retention, export path, safe
subcommands, and the toggle shortcut.

## Research findings (source-verified, v0.58.0 `src/settings.ts`)

- Config: `~/.pi/agent/pi-plan-mode.json` (legacy `plan-mode.json` migrated
  by the package; 64 KiB size cap; per-path serialized mutation queues).
- Fields (`PlanModeSettings`):
  - `thinkingLevel`: `inherit | off | minimal | low | medium | high | xhigh
    | max` (plan-phase thinking).
  - `defaultPlanTools?: string[]` — default plan toolset beyond the built-ins
    (read/edit/bash/grep/find/ls…).
  - `implementationPlanRetention?`: `clear-on-start | clear-after-first-run |
    keep`.
  - `defaultImplementationModel?` — implementation-model override identifier
    (has pending-model semantics in-package).
  - `defaultImplementationThinkingLevel?`: `off…max` (no `inherit`).
  - `defaultPlanExportPath?`: default `PLAN.md`.
  - `safeSubcommands?: { [command: string]: string[] | undefined }` — e.g.
    safe `git`/`gh` subcommands allowed in plan mode.
  - `toggleShortcut?: KeyId` — pi-tui key grammar; package exports the
    MODIFIERS/BASE_KEYS grammar for validation.
- Patch semantics in-package: `null` clears a key, absent leaves unchanged
  (`PlanModeSettingsPatch`) — mirror exactly.
- Effect timing: settings load at session start / settings-menu use — hint
  「新会话生效」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Thinking selects | Two selects (plan: 8 levels incl. `inherit`; implementation: 7 levels); reuse the advisor effort-select widget shape. |
| Implementation model | Model dropdown = **composer parity**（Dr. Lin 2026-09-21 决议）：`list_model_catalog` ∩ `available ∩ visible` + `list_scoped_models`，与消息输入框同一个列表（scoped 分组在前、其余 enabled 在后），外加「跟随计划模型」清除行 (`null`)；存储值不在列表内时按 raw key 兜底显示（advisor stale-model 模式）。 |
| `safeSubcommands` | v1: read-only summary (count per command) + 「高级」 raw JSON editor with schema-light validation (`Record<string, string[]>`); a chip editor is polish for later. |
| `defaultPlanTools` | Same treatment: read-only summary + advanced JSON list editor. |
| Shortcut input | Shared KeyId input (rpiv-todo component), validated against the package grammar. |
| Retention / export path | 3-way select; text input (relative path, package default placeholder `PLAN.md`). |

## Contract

### Bridge ops — added to `extensions/extension-settings.ts`

- `planMode.config.get` → `{ settings: Record | null, models, invalid? }`.
  文件缺失即包的 missing 结果（`settings: {}`）；读不出来（解析失败、根不是
  对象、IO 失败）返回 `settings: null` + `invalid.reason`，绝不降级成
  「空配置」——否则页面会展示默认值，而紧随其后的 set 会把用户文件整份覆盖。
- `planMode.config.set` → `{ key, value | null }` 单键 patch，或
  `{ entries: [{ key, value }, …] }` 批量；mirror
  `PlanModeSettingsPatch`；per-key validation (enums, KeyId grammar,
  `Record<string, string[]>` for safeSubcommands)；preserve-unknowns；
  invalid 文件拒绝写入（`cannot write onto an invalid file`）；批量在同一份
  文档上依次应用、只写一次；atomic write, 0600。

### Renderer

- Sections: 计划 thinking + retention + export path / 实现 model + thinking /
  工具与安全 defaultPlanTools + safeSubcommands (advanced) / 快捷键.
  Save-on-change per control.

### i18n

`settings.extensionPlanMode.*` in en/zh/ja/es (~20 keys: titles, labels,
enum labels, invalid errors, hint, saved/saveFailed).

## Verification

- Op tests (`extensions/extension-settings.test.ts`): missing file reads as
  `{}`；invalid 文件 → `settings: null` + reason 且 set 拒绝；enum rejects；
  patch-null clears；safeSubcommands shape validation；entries 批量一次落盘
  且中途失败不写文件；0600。
  KeyId grammar 校验与 legacy 文件共存（包自迁移，op 不与之争）仍靠 host 侧
  行为与手工验证覆盖。
- Renderer tests: selects reflect stored values; model picker payload; JSON
  editor rejects malformed input client-side.
- Landing variant: section renders through the landing config gateway (the
  config-runtime spec's lazy spawn) and writes the same global file.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md line.

## Out of scope

Plan-mode workflow UI, plan export actions, session-scoped overrides, the
fresh-handoff coordinator.
