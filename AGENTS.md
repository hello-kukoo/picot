# Picot agent guide

This file contains repository-wide development rules. Product architecture,
feature invariants, transport paths, security boundaries, and module ownership
live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Read first

- Read the applicable `ARCHITECTURE.md` section and its linked design documents
  before changing UI behavior, persistence, workspace I/O, or cross-process
  communication.
- For Quick Chat or Side Chat work, read
  [`docs/superpowers/specs/2026-07-15-quick-and-side-chat-design.md`](docs/superpowers/specs/2026-07-15-quick-and-side-chat-design.md)
  and the temporary-chat architecture section.
- Before changing a browser/server adapter, popup/overlay, or shared-state
  rerender behavior, read and apply [`docs/engineering-lessons.md`](docs/engineering-lessons.md).
- Update `ARCHITECTURE.md` when an implementation materially changes its
  architecture, invariants, lifecycle, security boundary, or validation
  contract. Changes to LAN access, cross-platform paths, or static serving also
  require the corresponding architecture update.

## Agent memory

This repo maintains an agent memory bank at `.memory/MEMORY.md` (gitignored,
local-only). **Read it before starting work** in this repo: it holds decision
logs, lessons from past mistakes, and a topic index under `.memory/topics/`.
Batch notes live in `.memory/notes/`. To record new decisions/lessons after a
work session, use the `update-memory` skill (`.claude/skills/update-memory/SKILL.md`).
Dr. Lin's hand edits there always win over agent merges.

## Pi references

- [RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [JSON mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)

## Toolchain

Use **Bun** exclusively. Never run `npm install` or `npm ci`; they create a
stray `package-lock.json` that conflicts with `bun.lock`.

```bash
bun install --frozen-lockfile
bun run dev
bun run test
bun run check
bun run check:rust
bun run build:extensions
```

Useful focused test form:

```bash
bun run vitest run public/settings-save-status.test.js
```

## Frontend and extension checks

Biome is the JS/TS formatter and linter.

```bash
bun run check       # lint, format, and design check
bun run check:fix   # safe automatic fixes
bun run lint
bun run format
bun run format:fix
```

After editing `.js` or `.ts` under `public/` or `extensions/`, run `bun run check`.
After editing `extensions/embedded-server.ts`, also run `bun run build:extensions`.

## Module discipline

The WebView is vanilla JavaScript with no framework.

- Keep one concern per file; do not add unrelated logic for convenience.
- Keep `app.js` as an orchestrator. Put new feature logic in a dedicated module
  and import it explicitly.
- Extract a feature adding roughly 50 lines or more into its own module.
- Do not mutate shared state as an import side effect.
- Use kebab-case filenames that describe one responsibility.
- For loopback access, filesystem paths, static assets, or locale coverage,
  run the full `bun run test` suite before completion.

## Verification

- After Rust edits, run `bun run check:rust`; do not use `tauri build` or
  `cargo build` merely to verify a fix.
- After frontend or extension edits, run `bun run check`; run the focused test
  first, then the relevant broader suite.
- `bun run test` includes Vitest and Tauri capability validation.
- Do not claim completion with failing tests or undocumented intentional
  warnings.

## Embedded Pi version

The embedded binary is the only Pi runtime Picot launches; do not rely on a
user-installed `pi` from `$PATH`. To upgrade it, follow the verified procedure
in [`ARCHITECTURE.md`](ARCHITECTURE.md#如何读这个仓库): change
`scripts/pi-version.json`, run `bun run fetch:pi`, smoke-test the embedded
binary and `bun run dev`, then commit only the version pin—not
`src-tauri/resources/pi/`.
