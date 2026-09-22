# MCP Settings Page Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling Q1–Q3 + grouping
amendment). Reworked 2026-09-13 after implementation review (P1×2, P2×3,
UI alignment); second pass same day (UI refinements + gateway-reject
handling + command-type validation); follow-up added default first-row
selection on page open and tab switch. Implemented; spec tracks code.
**Date:** 2026-09-13

## Goal

A new **MCP** settings page — three layer tabs (shared-global / pi-global /
project), each a master/detail view — managing MCP servers through the
`pi-mcp-adapter` extension's layered config files. The nav item appears
only when the adapter extension is installed.

## Research findings (source-verified, incl. review round)

- pi has no native MCP support; `pi-mcp-adapter` is the vehicle. Non-exclusive
  layer order (`getConfigSources`, config.ts:450–530):
  1. `~/.config/mcp/mcp.json` (shared-global)
  2. `~/.agents/mcp.json` (shared)
  3. `~/.agents/mcp/mcp.json` (shared)
  4. `<agent dir>/mcp.json` (pi-global)
  5. `<cwd>/.mcp.json` (**shared-project** — team repo file)
  6. `<cwd>/.pi/mcp.json` (pi-project, highest)
- The adapter reads **both** `mcpServers` and the `mcp-servers` key variant
  and writes back under the file's original key (config.ts:1078–1079).
- The adapter parses configs with **JSONC tolerance** — `//`/`/* */`
  comments and trailing commas are legal (parseJsonWithComments).
- Adapter write format: 2-space JSON + trailing newline, atomic tmp+rename
  (writeRawConfigObject, config.ts:1032).
- `/mcp disable/enable` = `writeProjectServerDisabledOverride`
  (config.ts:1059–1116): persists only the `disabled` field into the
  pi-project layer; **enable consults every lower source** (shared-global +
  pi-global + shared-project, each merged with expandImports, plus the
  project file's own `imports` array) to choose between writing
  `disabled: false` and removing the flag; empty results delete the entry;
  no-op changes skip the write entirely.
- Config is re-read on every `session_start`: new session = new config.
- Server entry: `{ command: string | string[], args?, env?, cwd? }` stdio /
  `{ url, headers? }` remote; adapter-only keys `directTools`, `lifecycle`,
  `inheritEnv`, `disabled`. Env/header values use `${VAR}` placeholders —
  opaque text, never interpolated.
- Extensions can provide MCP (read-only sources): pi package manifests,
  runtime registration event, Agent-Plugins / Claude plugin bundles.
- Host configs (Cursor/Claude Code/Codex/…) are compatibility inputs;
  `/mcp setup` adopts them by copying entries into pi-owned files — no
  file-level provenance survives adoption. Runtime `ServerProvenance`
  exists in-process only.

## Decisions

| Branch | Decision |
| --- | --- |
| Page shape (review) | Three tabs — shared-global / pi-global / project — each a master/detail. Tab strip and master/detail reuse the Extensions page classes (`.extensions-page-tab*`, `.pkg-manager-*`); no parallel design system. Add-server button (dashed, Models-page `.models-provider-add` pattern, label「+ 添加MCP」) sits at the bottom of the master list, only on the pi-global and project tabs. |
| Layer visibility (P1-1) | The project group merges `.mcp.json` (low) with `.pi/mcp.json` (high), later-wins; each entry carries its `sourceFile`; editability is **per-entry** (pi-global file and `.pi/mcp.json` only). A same-name `.mcp.json` definition shadowed by `.pi/mcp.json` is not listed separately. |
| Disable semantics (P1-2) | TUI-aligned toggle for any entry; the enable branch's lower-layer check includes shared-global + pi-global + **shared-project**. `expandImports` (host imports declared in pi-owned files) is not expanded — declared limitation, documented in code. |
| Key/format fidelity (P2) | Read accepts `mcpServers` and `mcp-servers`, writes back under the original key (new files use `mcpServers`); JSONC tolerance on read (comments dropped on write-back, matching the adapter); writes use 2-space indent + trailing newline. |
| Source display (review) | Every detail view shows the entry's `sourceFile`. File paths are the honest ceiling: "~/.claude origin" is unknowable post-adoption (no file-level provenance). |
| Effective state (P3) | `effectiveDisabled` computed bridge-side via the full later-wins merge across all four sources; the master row badge and the toggle direction use it. |
| Array command (P2) | Array-form `command` displays joined with spaces; an unmodified field round-trips the original array verbatim (dirty-flag tracking); an edit collapses it to a single string command. |
| Action row (2nd pass) | Save and Delete share one `.mcp-form-actions` row at the form bottom; Delete exists only on edits, never on the add form. |
| Transport types (2nd pass) | An invalid `command` type (e.g. number) is **rejected** at the bridge (`command must be a string or an array of strings`), never silently kept. `null`/`""` clear the transport; clearing the only transport fails the final command-or-url check. |
| Failure feedback (2nd pass) | All gateway calls go through a page-level `call()` wrapper normalizing rejections (timeout / no target / transport failure) to `{ok:false, error}` — the existing status line renders them; no handler can strand as an unhandled rejection. |
| Availability | Nav item hidden unless the adapter package is detected (settings.json `packages`, read by the bridge op). |

## Contract

### Bridge ops — `extensions/mcp-settings.ts`, cases in `picot-config.ts`

- `mcp_list_servers` → `{ installed, groups: { sharedGlobal, piGlobal,
  project }, groupErrors }`. Each group is an array of
  `{ name, entry, sourceFile, editable, ownDisabled, effectiveDisabled }`.
  Malformed files surface as per-group errors; the list never crashes.
- `mcp_save_server { scope: "piGlobal"|"project", name, entry }` — upsert
  into the pi-owned layer only (project scope → `.pi/mcp.json`); name
  `^[\w.-]+$`; transport validation with explicit invalid-type rejection
  (string/array command or url); unknown entry keys and unrelated document
  keys preserved; atomic write. Read-modify-write without a lock —
  single-user settings UI, accepted (ponytail note in code; queue if it
  ever loses an update).
- `mcp_delete_server { scope, name }` — pi-owned scopes only, idempotent.
- `mcp_toggle_server { name, disable }` — adapter-faithful pi-project
  override incl. skip-write guards and empty-entry deletion.

### Page — `public/settings/mcp-page.js`

- Tab strip (`data-mcp-tab`) + master (`.pkg-manager-groups`: rows with
  name, source basename, status dot, disabled badge) + detail
  (`.pkg-manager-detail`).
- Detail: exactly one enable/disable switch (`.pkg-manager-toggle`,
  role=switch) at the top; source path line; read-only raw view for
  non-editable entries; form (type/command/url/args/env/headers) whose
  bottom action row holds Save and (edits only) Delete; `${VAR}`
  placeholders literal. The「新会话生效（或 /reload）」hint
  renders once under the tab strip as the tab description, not per
  detail.
- Selection: after a successful list load, and when switching tabs, if the
  active tab has no valid remembered selection, select its first master row
  automatically. Tabs with no entries retain the empty state.
- Project tab empty state when no workspace is active.

### i18n / CSS

Keys under `settings.mcp.*` in en/zh/ja/es (groups reused as tab labels);
MCP-specific styles limited to form/badges in `settings-config.css`, all
layout inherited from the extensions page classes.

## Verification

- `extensions/mcp-settings.test.ts` (22): shared merge + per-entry
  sourceFile, project two-file merge + per-entry editability,
  effectiveDisabled cross-layer, JSONC, `mcp-servers` variant (read +
  write-back without dual-key), 2-space write format, array-command
  round-trip, invalid command type rejection, toggle matrix
  (flag/remove/false/skip-write, shared-project lower-check),
  malformed-file degradation, adapter detection.
- `public/settings/mcp-page.test.js` (10): default first-row selection on
  load and tab switch, tabs + switching, shared read-only + source path,
  pi-global edit + add (button at master bottom, dashed), project mixed
  editability, array-command passthrough, single switch, action row
  (save+delete; add form has no delete), gateway rejection → error status,
  nav availability.
- `bun run check`, focused vitest, `bun run test`, `bun run
  build:extensions`.
- `ARCHITECTURE.md`: bridge ops line gains the MCP ops (landed with this
  rework).

## Out of scope

`expandImports` in the enable check (declared limitation), exclusive-config
mode (`isExclusiveConfigMode` collapses all layers to pi-global), host-config
adoption UI (`/mcp setup` parity), OAuth/keyring, runtime status badges,
`settings`/`imports`/`claudePlugins` editing, editing shared files.
