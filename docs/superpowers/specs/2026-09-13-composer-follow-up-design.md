# Composer Follow-up Send Design

**Status:** Approved by Dr. Lin on 2026-09-13 (grilling session, Q1–Q3);
revised same day after spec review (click-time race re-check, requestId
delivery correlation, draft-safe cancel merge, module path, i18n
namespaces).
**Date:** 2026-09-13

## Goal

Add a "delayed send" path to the main-window composer: a dropdown on the
send button whose item queues the message as a pi follow-up (the GUI
equivalent of pi TUI's `alt+enter`), delivered automatically when the
running agent finishes. No keyboard shortcut — button interaction only.

## Background — two queues already exist

- **Local queue** (`messageQueue` / `renderQueuedMessages`): clicking send
  while streaming pushes to a client-side queue; `flushQueue()` sends the
  messages as fresh `prompt`s after `agent_end`. Cancellable per item.
  Protocol forbids immediate `prompt` during streaming without
  `streamingBehavior`, which is why this queue exists.
- **Pi queue** (`renderPiQueue`, read-only today): steering + followUp
  messages living in the Pi process, shown from `queue_update` events.
  Cancelable via the `clear_queue` RPC (clears all, returns the text) —
  not wired to any UI yet.

pi semantics (source-verified): `follow_up` only enqueues;
`followUpQueue.drain()` runs exclusively at a run's natural stop point. A
follow-up enqueued while idle therefore sits until the *next* unrelated run
ends and then executes — an idle trap that drives decision Q2 below.
Extension commands cannot be queued (`follow_up` throws); skill commands
and prompt templates are expanded. `images` is supported.

## Grilling decisions

| Branch | Decision |
| --- | --- |
| Q1 Main button | Unchanged in all states, including the streaming local-queue behavior. The dropdown's 延时发送 is the only new path and targets the pi queue. Two queues coexist. |
| Q2 Idle state | The menu item is disabled while the agent is idle (tooltip: only available while running). No idle-enqueue trap, no degenerate send. |
| Q3 Cancel | The pi queue area gains a「全部取消」button: calls `clear_queue`, merges the returned steering + followUp texts back into the composer input for re-editing. Protocol only supports clear-all — this is the ceiling; no per-item cancel. |

## Contract

### UI — split send button (`public/composer-follow-up-menu.js`, new module per 50-line rule)

- Send button becomes a split control: main area behaves exactly as today;
  a caret opens a dropdown with one item,「延时发送」(follow-up).
- Item enabled only when `state.isStreaming` is true **and** the message is
  not an extension command (`/`-prefixed commands checked against the same
  command registry the composer command menu already reads — skill/template
  commands stay allowed since pi expands them). Disabled otherwise with the
  tooltip explaining why.

### Send path

- Choosing 延时发送 re-checks `state.isStreaming` **at click time**: the
  menu's enabled state can go stale while the dropdown is open (the run
  ends mid-hover). If the agent has gone idle, downgrade to the existing
  immediate-`prompt` path (the main button's behavior) — the user's
  intent is "deliver this message" and there is nothing left to delay.
  Never enqueue a follow-up into an idle agent.
- Otherwise sends `{ type: "follow_up", message, images }` — pending image
  attachments ride along. (`idempotencyKey` is attached automatically by
  `wsClient.send`; tests assert below that layer and must not fabricate
  one.)
- Delivery follows the existing requestId correlation pattern
  (`trackPromptDelivery`): track by requestId, `success: true` → clear
  input + attachments, `success: false` or transport error → existing
  error path with input preserved. Unlike the prompt path there is no
  optimistic user bubble and no `lastSentMessage` bookkeeping — the
  message surfaces through the existing pi queue area (`queue_update` →
  `renderPiQueue`, label `queue.followUp`); pi emits `queue_update`
  immediately on enqueue, before the response arrives.

### Cancel path

- `renderPiQueue` gains a「全部取消」button shown when the pi queue is
  non-empty: sends `{ type: "clear_queue" }`, then merges the returned
  `steering` + `followUp` texts (joined newline-separated) back into the
  composer for re-editing — append after a newline when the input is
  non-empty, replace when empty; never clobber an unsent draft.

## i18n

Keys in en/zh/ja/es, split by namespace: `composer.splitSend.*` for the
menu item「延时发送」and the disabled tooltips (idle /
extension-command); `queue.*` (sibling of the existing
`queue.followUp`/`queue.queued`) for the「全部取消」label — confirm-free,
no extra dialog.

## Verification

- New focused tests: menu enable/disable matrix (idle × streaming ×
  extension-command), click-time race (dropdown open while streaming →
  run ends → click → delivered as immediate `prompt`, not `follow_up`),
  follow_up control message shape (message + images), delivery
  correlation (success clears input / failure preserves it), cancel
  button merges the joined texts into the composer both with an existing
  draft (append) and with empty input (replace).
- `bun run check`, focused vitest, then `bun run test`.

## Out of scope

Steering menu item, `set_steering_mode` / `set_follow_up_mode` exposure,
keyboard shortcut, Quick/Side Chat composer.
