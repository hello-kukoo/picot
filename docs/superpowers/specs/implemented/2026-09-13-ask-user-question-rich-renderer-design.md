# Ask-User-Question Rich Renderer Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling session, Q1–Q4);
revised same day after spec review (background correction, verbatim
payload echo, overlay layering, request matching, abort teardown, i18n
namespace).
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
| Container | Modal questionnaire card as a dedicated top-level overlay element **above** the `dialog-container` layer — never inside `DialogHandler`'s single slot (`clearCurrentDialog` + `replaceChildren` would evict it). Blocking semantics match dialogs; focus/Esc/respond plumbing reused. Layering matters twice: the abandon-confirm dialog and any fall-through generic dialog render into `dialog-container` underneath the card while the card stays mounted. Not a composer panel — todo-style panels are ambient state, wrong mental model for a blocking question. |
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
   `tool_execution_end` (any outcome), session switch, page reload,
   confirmed abandon, or abort (`wsClient` abort + socket close) —
   whether `tool_execution_end` fires reliably on a mid-tool abort is not
   contractually established in pi, so the abort listener is the belt to
   that suspender.

### Abandon path

Abandon button / Esc → confirm dialog → `respond(id, { cancelled: true })`
on the in-flight request → walker returns `cancelled` envelope → agent sees
DECLINE (identical to TUI Esc).

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
  tool end / session switch / abort.
- Manual: run a 4-question questionnaire with previews and multiSelect in
  `bun run dev`.
- `bun run check`, focused vitest, then `bun run test`.
