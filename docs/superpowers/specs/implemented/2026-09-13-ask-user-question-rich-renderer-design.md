# Ask-User-Question Rich Renderer Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling session, Q1–Q4);
revised same day after spec review (background correction, verbatim
payload echo, overlay layering, request matching, abort teardown, i18n
namespace). Revised 2026-09-22: runtimes survive session switches, so
session switch and background emission now park questionnaire state
(`public/ui/background-questionnaire-store.js`) instead of destroying it —
see "Background and session-switch semantics". Revised again 2026-09-22:
the card renders inline at the chat stream tail instead of a
window-blocking modal overlay — see "Inline stream anchor".
**Date:** 2026-09-13

## Goal

Replace the degraded sequential-dialog experience of
`npm:@juicesharp/rpiv-ask-user-question` in Picot's main window with a
same-screen questionnaire card: all questions rendered at once with real
checkboxes, option descriptions, and markdown previews — parity with the
extension's TUI tabbed overlay.

## Background — what Picot sees today

The extension's RPC fallback (`rpc-fallback.ts`) walks questions one native
dialog at a time:

- Single-select: `select` with `"N. Label — Description"` text lines —
  the description is squeezed into the option line (not dropped, but
  unwrapped and unstyled); previews are folded into the title, truncated
  at 600 chars.
- Multi-select: **degraded to a free-text `input`** — the user types index
  strings like `1,3`.
- Dismissing any dialog cancels the whole questionnaire.

The real gaps the rich renderer fixes: sequential one-question-at-a-time
dialogs, no multi-question review, previews flattened into a text-blob
title, and checkbox semantics lost on multi-select.

Key fact that makes the rich renderer possible: Picot's
`tool_execution_start` event carries the full tool `args` — every question
with `label`/`description`/`preview`/`multiSelect`. The data source does not
depend on the dialog protocol; the protocol is only the **answer return
path** (`extension_ui_response` with `value` or `cancelled: true`;
`dialogs.js` `respond()` already provides the pipe, and the walker parses
the returned option string with `parseIndex`).

## Grilling decisions

| Branch | Decision |
| --- | --- |
| Form | Same-screen questionnaire panel driven by tool `args`; walker dialog requests are answered programmatically in order (cursor tracks question index). Falls back to today's generic dialogs whenever no panel state exists — never worse than status quo. |
| Container | Modal questionnaire card as a dedicated top-level overlay element **above** the `dialog-container` layer — never inside `DialogHandler`'s single slot (`clearCurrentDialog` + `replaceChildren` would evict it). Blocking semantics match dialogs; focus/Esc/respond plumbing reused. Layering matters twice: the abandon-confirm dialog and any fall-through generic dialog render into `dialog-container` underneath the card while the card stays mounted. Not a composer panel — todo-style panels are ambient state, wrong mental model for a blocking question. *Superseded 2026-09-22 (Dr. Lin): the card is now an inline stream element at the tail of `#messages` — see "Inline stream anchor"; the abandon-confirm dialog still renders into `dialog-container` above it.* |
| Scope | Main window only (`app.js` `handleExtensionUIRequest`). Quick/Side Chat have their own DialogHandler + dispatch (`ephemeral-chat-view.js`) and keep current behavior; copy the integration there later if wanted. |
| Abandon | Explicit abandon (button or Esc) asks for confirmation first (copy states "the agent will receive a decline"), then responds `cancelled: true` to the in-flight request — the walker's DECLINE envelope, same as TUI Esc. |

## Contract

### Module — `public/ui/questionnaire-card.js` (standalone, not in WidgetMirrorRegistry)

No `widgetKey`, one-shot lifecycle, blocking interaction — a different
species from the registry's ambient renderers. The registry spec notes a
future "interactive dialog renderer" extension point; unify only when a
third case appears.

### Data flow

1. `handleToolExecutionStart` with `toolName === "ask_user_question"` →
   cache `args.questions`, build card state, show modal card.
2. `handleExtensionUIRequest` `select`/`input` arrivals while a card is
   active → cursor answers programmatically instead of `dialogHandler`:
   - Single-select `select` → respond by echoing
     `request.options[selectedIndex]` **verbatim from the incoming
     payload**. Never reformat from card state: the walker's option line
     is `"N. Label — Description"`, and the sentinel row
     (`"N+1. <localized 'Type something.' label>"`) is resolved inside
     the extension's own locale — unknowable from `args`.
   - `input` after a sentinel selection → respond the card's recorded
     custom text.
   - Multi-select `input` → respond `"1,3"`-style index list from checked
     boxes, or the typed custom answer; empty selection = respond
     `{ value: "" }` explicitly (empty string → the walker's
     `selected: []`; `{ cancelled: true }` would cancel the whole
     questionnaire — note `dialogs.js` `showInput` conflates empty with
     cancel, so the drain path must not reuse it).
   - Request matching is a cursor state machine: at question *i*, expect
     `select` (single) or `input` (multi), then optionally `input` for
     the sentinel follow-up, then advance. Same-method ambiguity is
     resolved by checking the request title contains the question text
     from `args.questions[i]` (the full title embeds extension-locale
     instruction text and cannot be reconstructed byte-for-byte).
   - A request that fits no cursor state → fall through to
     `dialogHandler` (generic dialog; safety net).
3. Local answer state is freely editable per question until **Submit**;
   submission enters answer-drain mode, consuming arriving requests in
   walker order.
4. Teardown (card state destroyed; later requests fall through): on
   `tool_execution_end` (any outcome), page reload, confirmed abandon, or
   abort (`wsClient` abort + socket close) — whether `tool_execution_end`
   fires reliably on a mid-tool abort is not contractually established in
   pi, so the abort listener is the belt to that suspender. Session switch
   no longer destroys the card: it parks it (see below) because the
   runtime survives the switch and keeps waiting on
   `extension_ui_response`.

### Abandon path

Abandon button / Esc → confirm dialog → `respond(id, { cancelled: true })`
on the in-flight request → walker returns `cancelled` envelope → agent sees
DECLINE (identical to TUI Esc).

## Background and session-switch semantics (2026-09-22 revision)

Pi runtimes are not killed when the user switches sessions or workspaces.
Without parking, two flows strand a waiting runtime forever: a
questionnaire emitted by a runtime that is already backgrounded (the
background event path only handled `setWidget`/`notify`), and a visible
card cleared by a session switch before the walker's request arrived.

`public/ui/background-questionnaire-store.js` is a per-session parking lot
keyed by session file with runtime-id fallback:

- Background `tool_execution_start` (`ask_user_question`) parks the tool
  `args.questions` and `toolCallId`.
- Background blocking `extension_ui_request` (`select`/`input`/`confirm`/
  `editor`) queues in arrival order and badges the session via the
  existing sidebar unread dot; no modal ever pops for a non-foreground
  session. Ambient methods (`notify`/`setWidget`/`setStatus`) are not
  parked — they keep their existing background paths.
- Session switch captures the live card via `captureAndClear()` — the
  pending walker request is **not** answered (no `cancelled` on switch);
  answers, cursor, and submit state travel with the captured state.
- The foreground mirror-sync path takes the parked entry once, rebuilds
  the card (`restore()` or `start()` from parked args), and replays the
  queued requests in order; an already-submitted card drains them
  immediately. Entries whose questions were never captured replay through
  `dialogHandler` as generic dialogs — never worse than the status quo.
- `tool_execution_end` arriving for the parked `toolCallId` drops the
  entry (the tool finished elsewhere); abandoning a restored card answers
  `cancelled` as before. Entries are in-memory only — a page reload drops
  them together with the runtime connection, which the abort path owns.

## Inline stream anchor (2026-09-22 second revision)

A window-blocking modal conflicts with Picot's multi-runtime model — the
user reads the stream, scrolls history, or works in another session while
a questionnaire waits. The card now renders as an in-flow element at the
tail of `#messages` (Paseo's pending-permission pattern):

- `.questionnaire-inline` is a plain stream child (role `group`, no
  `aria-modal`, no backdrop); the card spans the 960px message column and
  caps at `min(60vh, 720px)` with internal scroll.
- A `MutationObserver` re-anchors the card to the stream tail whenever
  later nodes (streaming messages, system rows) are appended, so the
  pending question always reads as the newest stream item.
- Esc abandons only when focus is inside the card; page-level Esc
  (composer, stop button) is never hijacked. The abandon button remains.
- Reveal paths (tool start, parked-restore) scroll the stream to the
  card via the scroll owner; re-anchoring does not force scroll.
- `#questionnaire-container` and its fixed-position CSS are gone; the
  card's container is `#messages` itself.

## Hard constraints

- A cancel path must always exist; the card must never strand a pending
  dialog unanswered (agent would block forever).
- Response values must byte-match what the walker's `parseIndex` /
  sentinel logic expects — achieved by echoing request payload lines
  verbatim (see data flow), asserted by tests against the payload
  string, not by string-matching titles.

## i18n

New keys under `questionnaire.*` in en/zh/ja/es: card title, submit,
abandon, abandon-confirm title/body, multi-select hint, custom-answer
placeholder. (Semantic top-level namespace, matching the module name and
the locale file's `dialogs`/`queue`/`tools` convention — not the
`migrated.*` historical bucket, which only holds upstream-ported UI
copy.)

## Verification

- New `public/ui/questionnaire-card.test.js`: cursor sequencing, verbatim
  echo of `request.options[i]` (the sentinel-row fixture must use a
  non-English label to prove the payload, not `args`, is the source),
  response formats (`"1,3"`, custom text), multi-select empty commit
  responds `{ value: "" }` (not cancelled), sentinel input pairing,
  abandon-confirm → cancelled response, fall-through both when no card
  state exists and when a live request fits no cursor state, teardown on
  tool end / session switch / abort, plus capture/restore round trips
  (parking must not answer the pending request; restored cards keep
  answers, cursor, and checkbox state; submitted cards drain replayed
  requests instantly).
- New `public/ui/background-questionnaire-store.test.js`: parking a
  background tool start, queueing only blocking methods, merge with a
  parked active card, drop on the parked tool's end, single-shot take by
  session file or runtime id, and no cross-session handout.
- Manual: run a 4-question questionnaire with previews and multiSelect in
  `bun run dev`; trigger a questionnaire in session A, switch to session B
  (card parks, A badges unread), answer another prompt, return to A and
  finish the parked questionnaire.
- Inline anchor: while a questionnaire is pending, stream more messages
  and confirm the card stays pinned at the tail; press Esc outside the
  card (nothing) and inside it (abandon confirm); resize to verify the
  960px column alignment.
- `bun run check`, focused vitest, then `bun run test`.
