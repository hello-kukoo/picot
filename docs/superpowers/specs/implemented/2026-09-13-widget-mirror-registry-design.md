# Widget Mirror Registry Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling session, Q1–Q4);
revised same day after spec review (runtime-keyed panel lifetime,
sticky-expand removal, registry extension-point note, i18n namespace
relocation).
**Date:** 2026-09-13

## Goal

Generalize the rpiv-todo mirror pattern (one-way: extension state → native
GUI panel, no reverse control) so that any pi extension pushing `setWidget`
becomes visible in Picot's main window, and rpiv-todo gains an expand-all
control and a user-facing clear action.

## Background

Today `public/ui/rpiv-todo-mirror.js` is hard-wired in `app.js`: tool
results with `toolName === "todo"` feed `RpivTodoMirrorPanel`;
`setWidget` with `widgetKey === "rpiv-todos"` is an expand trigger; every
other extension's `setWidget` is silently swallowed (`app.js`
`handleExtensionUIRequest`). pi's RPC contract already defines the
UI-agnostic widget surface (`widgetKey` + `widgetLines: string[]` +
`widgetPlacement`), so a generic renderer is alignment with upstream, not
invention. Installed extensions that already push widgets and are currently
invisible: `@narumitw/pi-plan-mode` (`src/presentation.ts`),
`pi-subagents` (`src/tui/fleet-status.ts`; in RPC mode it pushes
`encodeAsyncStatusSnapshotWidget` string lines).

## Grilling decisions

| Branch | Decision |
| --- | --- |
| Clear channel | Natural-language prompt; the LLM calls `todo {action:"clear"}`. No upstream/fork changes to rpiv-todo. |
| Clear timing | Confirm dialog first; if agent idle, send immediately; if streaming, queue with `streamingBehavior: "followUp"` (never steal the running agent's todo tracking mid-run). |
| Expand control | The `+N more` line becomes a bidirectional toggle「Show all N / Collapse」; expansion survives new snapshots (the user may be watching the full list) until toggled back or the session switches. Expansion state lives in the panel, reset by `clear()`. The existing 3s sticky-expand (`is-hover-expanded`, fired by `/todos` notify and `setWidget`) is **removed** — it was a workaround for "the notify shows content the collapsed panel truncates", which the toggle now solves directly; notify/`setWidget` arrivals just refresh content, and `/todos` with a mirrored panel becomes silent (the panel above the composer already shows that state). |
| Session switch | Panels are keyed by Pi **runtime** identity, not session: switching sessions hides panels owned by the now-inactive runtime and restores them when that runtime becomes active again (a background session still running subagents keeps its fleet widget across the round trip). Only rpiv-todo additionally clears and rehydrates from the new session's history — history replay is authoritative when it exists. The runtime is the lifetime unit because Picot switches Pi processes in-place while the TUI never does; "same as the TUI" does not apply. |

## Contract

### Registry module — `public/ui/widget-mirror-registry.js`

- `registerRenderer({ widgetKey, toolNames?, matchesNotify?, replay? , createPanel })`
  — `matchesNotify` and `replay` exist for the rpiv-todo migration only;
  the default text panel uses neither. Do not grow per-renderer hooks
  beyond these without a second consumer.
- Dispatch entries (called from `app.js`, which stays orchestrator):
  - `handleWidgetRequest(request)` — routes `setWidget` by `widgetKey`.
  - `handleToolResult(toolName, result)` — routes tool-result `details`.
  - `handleCommandNotify(message)` — notify de-duplication hooks.
  - `handleRuntimeChange(runtimeId)` — hide panels whose owning runtime
    is no longer active; restore them when it returns. Every panel
    (default text panels included) records the runtime id of its
    `setWidget` pusher. Event attribution rides the existing
    foreground/background routing (`app.js` already separates
    `handleRPCEvent` from `handleBackgroundRPCEvent(sessionFile, event)` —
    background runtimes' events do reach the window, which is what makes
    runtime-keyed ownership observable; map the event's session
    attribution to its runtime, same source the sidebar's live rows
    use).
  - `handleSessionSwitch()` — rpiv-todo only: clear + rehydrate from
    the new session's history.
- Unknown `widgetKey` → lazily create a **default text panel**: title =
  widgetKey, body = `widgetLines` as pre-formatted text; `belowEditor`
  placement inserts after the composer `<form>`, `aboveEditor` before it
  (rpiv-todo's current spot). `widgetLines: undefined` removes the panel.
- Unknown keys never throw; malformed payloads are ignored (same trust
  boundary discipline as `isRpivTodoDetails`).

### rpiv-todo renderer migration (behavior parity + two additions)

- Existing behavior preserved: details validation, `/todos` notify
  suppression (a suppressed notify no longer expands the panel — the
  sticky-expand is gone per the decision above — it is simply not
  rendered), history replay on session switch, clear-on-switch.
- **Expand toggle**: `selectDisplayTasks` caps at 5 rows only while
  collapsed; the toggle swaps `+N more` for the full list and back.
  Expansion state lives in the panel, reset by `clear()`.
- **Clear button**: link-style, in the panel header, visible only when the
  panel has visible tasks. Flow: `showConfirm` → if agent idle, `prompt`;
  if streaming, `prompt` with `streamingBehavior: "followUp"`. Prompt text
  (i18n) instructs the model to call the `todo` tool with
  `{"action":"clear"}`. State converges via the resulting tool result.

### Known costs (accepted)

- Clear leaves a user message + assistant reply in the transcript.
- The clear is LLM-mediated: the model may refuse or paraphrase; the button
  then appears to no-op until the next tool result repaints the panel.

### Future extension points

Interactive/blocking renderers (e.g. the questionnaire card,
`2026-09-13-ask-user-question-rich-renderer-design.md`) are deliberately
**outside** this registry: one-shot lifecycle plus blocking interaction and
ambient renderers are different species. Unify only when a third case
appears.

## i18n

The panel's namespace **relocates** from the historical
`migrated.native.features.rpivTodoMirror` bucket to semantic `todoMirror.*`:
this spec rewrites nearly every render path in `rpiv-todo-mirror.js`
(registry migration, toggle, clear button, sticky-expand removal), so the
existing `textcontent.todos` key moves in the same change instead of
growing a historical prefix into ~8 live keys. Old keys are deleted, not
shimmed — locale files are internal resources with no external consumers.
The remaining `migrated.*` keys (search index, imageLightbox) belong to
files this spec does not touch; they stay put until those files are next
reworked.

New keys under `todoMirror.*` in en/zh/ja/es (plus the relocated
`title.todos`): show-all label, collapse label, clear label, clear
confirm title/body, clear prompt message.

## Verification

- Extend `public/ui/rpiv-todo-mirror.test.js`: sticky-expand removal
  (notify/`setWidget` arrival does not touch expansion state), toggle
  logic, clear-gating, replay, expansion reset on `clear()`, and the
  namespace relocation (old `migrated.*` keys absent, all `t()` call
  sites resolve under `todoMirror.*`).
- New `widget-mirror-registry.test.js`: dispatch by widgetKey, default
  panel create/remove, belowEditor insertion, runtime-keyed
  hide/restore on `handleRuntimeChange` (an inactive runtime's panels
  hidden, restored on return), rpiv-todo rehydration on
  `handleSessionSwitch()`.
- `bun run check`, focused vitest, then `bun run test`.
- `ARCHITECTURE.md` gains a short paragraph on the mirror registry when
  this lands (implementation step, not optional).
