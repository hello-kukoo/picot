# Picot Release Notes

Version 0.3.6 · Embedded Pi 0.84.0 · Branch `private/features-v3`
Range: `b1490918` (2026-07-21) → `872872d` (HEAD)

## 2026-07-21 — b1490918 (baseline)

New Features

- File preview/editor panel (CodeMirror + PDF.js): Markdown, image, PDF preview and text editing; workspace-scoped tabs
- Side Chat / Quick Chat ephemeral chat: independent Pi process, tool isolation, model selection, cost/token stats
- i18n engine: instant zh/en switching across all UI
- Sidebar rebuild: RECENT / PINNED / PROJECTS / ARCHIVED sections, workspace & session pinning, draggable resizer
- Chat history navigator with turn index and preview cards
- Workspace quick-info card: on-demand Git metadata, 30s cache
- RPC command policy manifest (`picot-core-commands.json`)
- Local build scripts (`scripts/build.sh`, `build-frontend.js`); Husky pre-commit hooks; `ARCHITECTURE.md`

Fixed

- XSS vulnerability; file tab state restore robustness

## 2026-07-21

New Features

- Windows `HOME` env fallback for embedded server + path diagnostics
- `parseEphemeralEnv` extracted to standalone module; new RPC commands

Fixed

- CORS policy tightened on `/api/super-agent/projects`
- File browser load timing on cross-workspace session switch
- Type errors; `tsconfig.json` strict type checking
- Removed legacy chat history nav; conv-nav tooltip positioning

## 2026-07-22

New Features

- Network access control and path safety for embedded server
- Sidebar collapse state refactor: unified section chevron icons + tests

Fixed

- Pinned workspace "New chat" button passing path instead of workspace object

## 2026-07-24

New Features

- Integrated terminal panel: native PTY session management, xterm.js
- CJK font bundling; chat message bubble covered; embedded Pi → 0.82.0
- One Dark syntax highlight theme for code editor; improved default open mode
- Unified event naming; `agent_settled` fallback and `queue_update` display

Fixed

- Multiple edge cases in terminal panel and file browser
- File preview tab switch not updating tab-bar highlight

## 2026-07-25

New Features

- Skills settings page: browse and enable/disable skills
- `@` file-mention autocomplete in composer

## 2026-07-26

New Features

- Workspace Focus mode; safe archive deletion
- vitest code coverage support
- Markdown image container width constraint

Fixed

- File / Side Chat tab switch and workspace switch panel behavior
