---
name: pi-upgrade-impact
description: Use when upstream Pi (the bundled coding-agent / TUI runtime embedded in Picot) releases a new version. Read upstream CHANGELOG and release notes, compare against Picot's pinned version and integration surface (RPC, SessionManager API, extension commands, session events), and produce a structured impact report covering new features, bug fixes, breaking changes, and concrete follow-up work for Picot. Trigger phrases include "pi 升级了", "pi 新版本", "pi release", "check pi impact", "评估 pi 版本", "pi 0.88", "上游 pi", "上游 release notes".
---

# Pi upstream upgrade impact assessment

## When to use

A new version of the upstream Pi runtime (the package embedded by Picot via
`scripts/pi-version.json`) has been released or announced. Run this skill to
produce a decision-ready impact report **before** any pin bump or upgrade
work.

This skill produces **a report only**. It does not modify
`scripts/pi-version.json`, does not run `bun run fetch:pi`, and does not
edit Picot source. See [Pin bump handoff](#pin-bump-handoff) for the
explicit boundary.

Do **not** use this skill for:

- Routine upstream refreshes that have already been evaluated and recorded in
  `scripts/pi-version.json`.
- Pure downstream Picot changes. This skill is upstream-only.
- Bug triage inside Picot that does not touch the embedded Pi runtime.

## Inputs you need

1. The new upstream version string (e.g. `0.88.0`).
2. Confirmation that the local checkout at `~/tmp/PI/pi/` is in sync with
   that version (Dr. Lin will normally say "已经同步" or similar).
3. Picot's currently pinned version in `scripts/pi-version.json`.

If any of these are missing, ask Dr. Lin before proceeding. Do not guess a
version range.

## Workflow

### 1. Confirm the upstream sync state

```bash
cd ~/tmp/PI/pi && git fetch --tags && \
  git describe --tags --always && \
  git tag --list 'v<NEW_VERSION>*' | sort -V
```

If the tag is missing, stop and report that `~/tmp/PI/pi` has not been
synchronized to the new version. Ask Dr. Lin to run the upstream sync first.

### 2. Read the upstream changelog

The canonical changelog lives at
`~/tmp/PI/pi/packages/coding-agent/CHANGELOG.md`. Read it section by
section from the currently pinned version up to the new version, in order.
Use `ctx_execute_file` (context-mode) to slice the file so the raw bytes
stay out of context, or `read` with `offset` / `limit` — the file routinely
exceeds 50 KB.

Always read every section between the two versions; do not skim. Breaking
changes are frequently introduced mid-section, not only in the headline.

If the changelog does not yet exist for the new version, check the release
notes / GitHub release for the same range as a fallback and note that the
changelog is incomplete.

### 3. Establish Picot's integration surface

Run the bundled helper script from the Picot repository root (the one
containing this skill):

```bash
bash .pi/skills/pi-upgrade-impact/pi-integration-surface.sh
```

It greps Picot's live integration surface into a stable list: pinned
version, direct SDK imports, `SessionManager` usage, extension command
registrations, extension `ctx` calls, WebView session events, and extension
event listeners. Exclude `node_modules`, `extensions/dist/`, and
`src-tauri/target/` noise manually if any leaks through.

Record the result list in the report's "Integration surface" section.
Treat the absence of a hit as evidence that Picot does not depend on that
API; do not invent calls.

### 4. Cross-reference breaking changes

Walk every `Breaking Changes` block in the changelog. For each item:

1. Decide whether Picot's surface touches it.
2. If yes, locate the exact call site with `grep`.
3. Classify the impact as `none`, `soft` (behavior change but compatible),
   or `hard` (compile / runtime break requiring code changes).
4. For soft or hard items, name the file and line range that must change.

Also re-read the `### Changed` blocks — those are non-breaking but frequently
signal upstream drift that Picot should track (default model switches,
provider catalog refreshes, default keybindings).

### 5. Surface new features Picot could adopt

For each `New Features` / `### Added` entry, judge fit against Picot's
product shape:

- **Purely upstream UX** (fullscreen transcript, `/bug`, prompt cache
  warming, session sharing) → usually no Picot work; note it under
  "Already available" if Picot inherits it transparently.
- **Backend-only capability** (e.g. new `SessionManager.appendContextEdit`,
  new extension event, new RPC command) → useful as a Picot-internal tool if
  Picot already touches that surface; otherwise skip (YAGNI).
- **Feature that maps onto a known Picot gap** → candidate for follow-up.
  Cite the Picot feature or roadmap item that would benefit.

Do not propose speculative features. If nothing maps, say so.

### 6. Write the report

Write the report to the path Dr. Lin specifies, or to
`docs/superpowers/specs/process-evidence/<YYYY-MM-DD>-pi-<NEW_VERSION>-impact.md`
if no path is given. Use the template below.

## Pin bump handoff

The skill ends at report delivery. The upgrade itself — editing
`scripts/pi-version.json`, running `bun run fetch:pi`, smoke-testing the
embedded binary and `bun run dev` — starts **only** after Dr. Lin reads the
report and explicitly confirms (e.g. "确认升级" / "同步升级内置 Pi").

When Dr. Lin confirms, follow the procedure in `ARCHITECTURE.md`
("Embedded Pi version" section): bump the version pin, run
`bun run fetch:pi`, smoke-test the embedded binary and `bun run dev`, then
commit only the version pin — never `src-tauri/resources/pi/`.

## Report template

```markdown
# Pi <OLD_VERSION> → <NEW_VERSION> upstream impact

**Date:** <YYYY-MM-DD>
**Picot pin before:** <OLD_VERSION>
**Picot pin after:** <NEW> (only if Dr. Lin authorized bumping)

## Sync state

- `~/tmp/PI/pi` at: `<commit>` (describe --tags output)
- Tags seen: <list>
- Local CHANGELOG range read: <OLD_VERSION>..<NEW_VERSION>

## Picot integration surface (as of this report)

List only the APIs / events / commands Picot actually uses, with file + line.
Keep this list short — it is the audit basis for the rest of the report.

## New features

- `<version>`: <feature> — fit: <adopt / observe / skip>, reason in one line.

## Bug fixes relevant to Picot

- `<version>` (#<issue>): <one-line description> — affects Picot? yes/no,
  one-line reason.

## Breaking changes — verdict per item

| Item | Picot touches? | Impact | Action |
|------|----------------|--------|--------|
| `<short name>` | yes (file:line) / no | none / soft / hard | none / describe |

## Recommended follow-up

1. Concrete action with file path and verification command.
2. Or "No Picot code changes required for this version".

## Verification

- `bun run test` — passed / failed / not run (Dr. Lin not yet authorized)
- `bun run check` — passed / failed / not run
- Smoke run of `bun run dev` against the embedded binary — done / skipped

## Risks and open questions

- Anything Dr. Lin should decide before bumping the pin.
```

Keep the report dense. Each row in the breaking-changes table must cite a
file:line or be marked `no`. Each follow-up item must cite a path.

## Reference facts

These have not changed across recent Pi versions and can be reused without
re-checking:

- Picot integrates with Pi through three surfaces only:
  1. **RPC over stdio** from the Rust host (the WebView never talks to pi
     directly). Picot does not parse RPC event payloads except for the
     session events listed in step 3.
  2. **Four extension commands** registered in `extensions/picot-bridge.ts`:
     `picot-capabilities`, `picot-reload-resources`, `picot-navigate-tree`,
     `picot-config`.
  3. **Direct SDK calls** in `extensions/picot-config.ts` against
     `SessionManager` (`open`, `listAll`, `inMemory`, `appendSessionInfo`)
     and `createAgentSession`.

- Pin location: `scripts/pi-version.json` (do **not** commit
  `src-tauri/resources/pi/` — that directory is regenerated by
  `bun run fetch:pi`).

- Local upstream checkout: `~/tmp/PI/pi/` (relative to Picot repo:
  `../PI/pi`). Always confirm with `git describe` before reading CHANGELOG;
  Dr. Lin may run the sync in a different worktree.

## Rules

- Always cite file:line for any claim about Picot's code. Use grep, not
  memory.
- If the changelog is incomplete for a section, say so explicitly; do not
  infer missing entries.
- Do not bump `scripts/pi-version.json` or run `bun run fetch:pi` from this
  skill. Wait for Dr. Lin's explicit confirmation (see
  [Pin bump handoff](#pin-bump-handoff)).
- Do not modify `.memory/MEMORY.md` from this skill. The impact report is
  the deliverable; memory updates go through the `update-memory` skill.
- Do not silently skip the cross-reference. A passing `bun run test` does
  not substitute for a per-API grep.
