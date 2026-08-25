# Message Toolbar Design

## Status

Product and interaction design confirmed with Dr. Lin on 2026-08-10. This
document defines the per-message action toolbar (copy + timestamp + usage in
this phase) and its extension contract for future actions (fork / delete).

**Implemented** (working tree, uncommitted): the toolbar, per-role visibility
(user hover/focus-gated via `.visible`; assistant always visible), the unified
timestamp/usage styling, and the `formatMessageTime` helper are landed across
`public/ui/message-renderer.js`, `public/app.js`, `public/native/app.js`, and
`public/style.css`. The sections below describe that implementation; fork /
delete remain deferred (see Future Work). The 2026-08-10 confirmation date is
preserved as the original design snapshot.

## Goal

Give every rendered chat message (user prompt and each turn's final assistant
reply) a compact action toolbar underneath the message body that currently
holds the copy button and a timestamp, and that will later host fork and
delete actions without further layout changes.

This phase delivers:

- A timestamp on user messages and on each turn's final assistant message.
- A unified `.message-actions` toolbar that replaces today's standalone copy
  button, shown on hover/focus instead of always-visible.
- The toolbar extension contract (slot ordering, alignment, visibility,
  naming) so that fork / delete can be added in a later spec.

## Scope

### Included

- `formatMessageTime(ms)` — new formatting helper for message timestamps.
- `MessageRenderer.renderUserMessage` / `renderAssistantMessage` signature
  changes to accept a `timestamp` argument.
- `.message-actions` toolbar DOM structure and CSS (hover/focus reveal,
  touch fallback, alignment per role).
- `renderSessionHistory` passes the session-recorded `msg.timestamp` through.
- Real-time paths: user message shows its send-time timestamp immediately;
  assistant toolbar appears after finalize using the finalize timestamp.
- Quick Chat / Side Chat (ephemeral) pass no timestamp and therefore show no
  timestamp; the toolbar still renders (copy + future actions) with no time.

### Excluded (this phase)

- Fork and delete actions (defined as future work in
  [Future Work: fork / delete](#future-work-fork--delete)).
- Message virtualization / lazy toolbar mounting for very long sessions.
- Settings toggle (timestamps are always shown when available).

## Confirmed Product Decisions

| Concern | Decision |
| --- | --- |
| Timestamp granularity | Same calendar day → `HH:MM`. Different day → `MM/DD HH:MM`. No i18n. |
| Timestamp source — history | `msg.timestamp` from the session JSONL (`message.timestamp`, Unix ms). |
| Timestamp source — real-time user | `Date.now()` at send time (the send moment is the timestamp). |
| Timestamp source — real-time assistant | `Date.now()` at finalize (completion moment). Streaming shows no toolbar. |
| Which messages show a timestamp | User messages + each turn's final assistant reply. Tool calls / thinking are folded as process noise and get no toolbar timestamp. |
| Messages with no timestamp | No timestamp rendered. Toolbar still renders (copy + future actions). |
| Toolbar reveal — user | JS-driven show/hide: hovering the bubble or the toolbar toggles a `.visible` class (see `_setupUserToolbarHover`); `:focus-within` also reveals it for keyboard. Hidden by default, shown on enter, hidden again 80 ms after leave. Pure CSS `:hover` was rejected because long user messages fill the row width, so `:hover` on the block never ends. |
| Toolbar reveal — assistant | Always visible (no hover gating); `:focus-within` still applies for keyboard but is a no-op visually since the row is already opaque. |
| Touch devices | User toolbar always visible under `@media (hover: none)` (assistant already is). |
| Toolbar visibility during assistant streaming | Hidden until finalize. |
| Settings toggle | None. Timestamps show whenever available. |
| User toolbar layout | `{timestamp} {copy}` — right-aligned (user block is right-aligned). Phase-1 layout; superseded 2026-08-21 by `{expand} {fork} {edit} {copy} {time}`. |
| Assistant toolbar layout | `{copy} {timestamp} {usage}` — left-aligned. `usage` (cost) moves into the toolbar (today it is a separate inline span). |
| Timestamp hover affordance | `title` attribute with the full `YYYY-MM-DD HH:MM:SS` for exact reference. |
| Error / welcome rows | No toolbar. |

## Background and invariants

### Session JSONL carries per-message timestamps

Each `type: "message"` entry in a Pi session JSONL has two timestamps:

```json
{
  "type": "message",
  "id": "34db2c1f",
  "timestamp": "2026-08-07T07:43:12.310Z",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }],
    "timestamp": 1786088591988
  }
}
```

- Outer `entry.timestamp` — ISO string, when the entry was persisted.
- Inner `message.timestamp` — Unix ms, the message's own timestamp.

Pi's `UserMessage`, `AssistantMessage`, and `ToolResultMessage` (from `pi-ai`)
all carry `timestamp: number` (Unix ms). This is the authoritative source for
message timestamps.

### Picot's data flow already preserves timestamps up to the last hop

| Stage | Behaviour | Timestamp preserved? |
| --- | --- | --- |
| `/api/sessions` (list) | `parseSessionFile` reads only the header (id / timestamp / firstMessage). | Session-level only. |
| `/api/sessions/:dir/:file` (open history) | `serveSessionFile` returns the raw `entries` array verbatim. | Yes, complete. |
| `renderSessionHistory` (`app.js`) | Pushes `entry.message` into a `messages` array; `msg.timestamp` is in hand. | Yes, on the message object. |
| `renderNavigableUserMessage` / `renderAssistantMessage` calls | Currently extract only `content` / `images`; **timestamp is dropped here**. | No — the gap this design closes. |
| `MessageRenderer.renderUserMessage` / `renderAssistantMessage` | No timestamp parameter, no timestamp DOM. | No. |

So timestamps are available end-to-end and only need to be threaded through
the final render call. No backend changes are required.

## Architecture

### `formatMessageTime(ms)`

New module-scope helper, co-located with the message renderer
(`public/ui/message-renderer.js`) because it is message-specific and must not
be confused with the sidebar's relative-time helper `formatSessionTime`.

Signature and contract:

```js
// Same calendar day (local time) → "HH:MM" (24h, zero-padded).
// Different day → "MM/DD HH:MM" (zero-padded month/day, no i18n).
// Invalid / missing input → "" (caller renders no timestamp span).
export function formatMessageTime(timestampMs) { ... }
```

Rules:

- "Same day" is evaluated in the user's **local** timezone, matching how a
  person reads a chat.
- Returns `""` for `null`, `undefined`, `NaN`, or any non-finite number, so
  callers can unconditionally call it and conditionally render.
- Does **not** reuse `formatSessionTime` (sidebar) — that helper produces
  relative labels ("2h ago", weekday names) that are wrong for a chat log,
  where absolute clock times are expected.

### `MessageRenderer` changes

#### `renderUserMessage(message, isHistory = false)`

Add `message.timestamp` handling. `message.timestamp` is the Unix-ms
send-time for real-time messages, or the session-recorded Unix-ms timestamp
for history.

New DOM (replaces today's `div.appendChild(this._createCopyButton())`):

```html
<div class="message user">
  <div class="message-content"> ... </div>
  <div class="message-actions">
    <span class="message-time" title="2026-08-10 14:32:07">14:32</span>
    <button class="message-copy-btn"> ... </button>
  </div>
</div>
```

- Toolbar order: `{time} {copy}`.
- When `formatMessageTime(message.timestamp)` returns `""`, the `.message-time`
  span is omitted (Quick Chat / Side Chat / legacy sessions).

#### `renderAssistantMessage(message, isStreaming = false, isHistory = false, targetContainer = null, suppressToolbar = false)`

Add `message.timestamp` handling. The toolbar is rendered **only when
`!isStreaming && !suppressToolbar`**. During streaming, no `.message-actions`
row exists; the finalize path adds it (see [Real-time assistant finalize](#real-time-assistant-finalize)).

`suppressToolbar` exists because `renderSessionHistory` reuses
`renderAssistantMessage` to render process-detail rows (thinking blocks, tool
calls, and non-final intermediate assistant messages) inside the folded
"Process details" group. Those rows must not carry a toolbar — only the
turn's final answer does. When `suppressToolbar` is `true`, the renderer
omits the entire `.message-actions` row (no copy button, no timestamp, no
usage). See [History rendering — distinguishing answer from process](#history-rendering--distinguishing-answer-from-process).

New DOM (replaces today's inline `<button class="message-copy-btn">` plus the
separate `<span class="message-usage">`):

```html
<div class="message assistant">
  <div class="message-content"> ... </div>
  <div class="message-actions">
    <button class="message-copy-btn"> ... </button>
    <span class="message-time" title="2026-08-10 14:32:45">14:32</span>
    <span class="message-usage">$0.0123</span>   <!-- only when cost > 0 -->
  </div>
</div>
```

- Toolbar order: `{copy} {time} {usage}`.
- `usage` moves from a standalone inline span into the toolbar (decision C/a).
- Time span omitted when `formatMessageTime` returns `""`.
- Usage span omitted when `message.usage?.cost?.total` is absent or `0`, as today.

### Render paths — public and native

`MessageRenderer` is shared by **two** independent render paths, and both must
be updated for the toolbar/timestamp work to be complete:

| Path | Entry point | Real-time user | Real-time assistant finalize | History replay |
| --- | --- | --- | --- | --- |
| `public/app.js` (web / embedded-server WebView) | `renderSessionHistory`, WebSocket streaming events | `renderNavigableUserMessage` send call site | `finalizeStreamingMessage` (to be verified during implementation) | `renderSessionHistory` turn loop |
| `public/native/app.js` (native WebView) | `handleRuntimeEvent`, `renderHistory` | `handleRuntimeEvent` `message_start` for `role === "user"` | `handleRuntimeEvent` `message_end` | `renderHistory` message loop |

Both paths call the same `MessageRenderer.renderUserMessage` /
`renderAssistantMessage` methods. A change to only one path leaves the other
surface without timestamps/toolbars. Each subsection below names the path it
governs, and the changes are required in **both** paths unless stated
otherwise.

### `.message-actions` toolbar and extension contract

The toolbar attaches **only to user messages and each turn's final assistant
answer**. Folded process-detail rows (thinking, tool calls, non-final
intermediate assistant messages rendered inside the "Process details" group)
never receive a toolbar — they are rendered with `suppressToolbar = true`.

The toolbar is an ordered slot list so future actions (fork / delete) slot in
without layout work.

**Slot order (visual left → right):**

| Role | Order |
| --- | --- |
| User | `time`, `copy`, *(future: fork, delete)* |
| Assistant | `copy`, `time`, `usage`, *(future: delete)* |

> **2026-08-21 更新**：user 顺序已被
> [`2026-08-21-info-panel-design.md`](2026-08-21-info-panel-design.md) 取代为
> `expand/collapse → fork → edit → copy → time`（`time` 移至末位，`fork` / `edit` 插在
> `copy` 之前）。下方的追加式扩展 contract（真实 button、aria-label、keyboard focus、
> per-role 可见性）对新增动作仍然有效。

**Contract for adding an action:**

1. Append a `.message-action` element (button) into `.message-actions`.
2. Each action carries an explicit `aria-label` (no icon-only without a label).
3. Actions are plain `<button type="button">` so they participate in keyboard
   focus and the toolbar's `:focus-within` reveal.
4. Per-role visibility (e.g. fork only on user, delete on both) is decided by
   the renderer at build time; CSS never hides a slot by role globally.
5. The `.message-time` and `.message-usage` spans are **not** `.message-action`
   elements; they are static labels and must remain non-interactive.

**Alignment:** the toolbar inherits the message block alignment — right-aligned
for `.message.user` (block is right-aligned), left-aligned for
`.message.assistant`. The toolbar itself is a flex row with a small gap.

### Visibility model

Visibility is **per role** — user toolbars are JS-gated, assistant
toolbars are always visible:

```css
/* User toolbar: hidden by default. A `.visible` class (toggled by
   _setupUserToolbarHover) reveals it; :focus-within covers keyboard. */
.message.user .message-actions { opacity: 0; }
.message.user .message-actions.visible,
.message.user:focus-within .message-actions { opacity: 1; }

/* Assistant toolbar: always visible. */
.message.assistant .message-actions { opacity: 1; }

/* Touch devices have no hover; keep the user toolbar visible too. */
@media (hover: none) {
  .message.user .message-actions { opacity: 1; }
}
```

`_setupUserToolbarHover(contentEl, actionsEl)` attaches `mouseenter` /
`mouseleave` to **both** the bubble (`.message-content`) and the toolbar
(`.message-actions`). An 80 ms grace timer keeps the toolbar visible while the
pointer crosses the gap between bubble and toolbar, then hides it. This is
JS-driven rather than pure CSS `:hover` because a long user message fills the
row width, so `:hover` on the message block never actually ends when the
pointer moves to the empty side — the toolbar would never hide. (A `width:auto`
shrink-to-fit was tried first but fails for messages that wrap to the full row
width; JS scoping the hover to bubble+toolbar is robust for all message
lengths.)

- Transition on `opacity` for a soft reveal on the user toolbar.
- Keyboard users tabbing to the copy button trigger `:focus-within`, which
  reveals the toolbar via the CSS fallback even without the `.visible` class.
- The legacy always-visible copy button styling (`.message-copy-btn { opacity:
  0.45 }`) is removed; visibility is now owned by `.message-actions`.

### `app.js` changes

The changes below apply to **both** render paths. Each is written against
`public/app.js` (the embedded-server WebView path) and mirrored in
`public/native/app.js` (the native WebView path). See
[Render paths — public and native](#render-paths--public-and-native).

#### History rendering — distinguishing answer from process

`renderSessionHistory` splits each turn's final assistant message into
`processBlocks` (thinking + tool calls) and `answerBlocks` (the visible reply)
via `splitFinalAssistantBlocks`. Non-final assistant messages in the turn are
entirely process. These distinctions determine toolbar attachment:

| Render target | `suppressToolbar` | Toolbar? | Timestamp passed |
| --- | --- | --- | --- |
| User message (`renderUserFromMsg`) | n/a (user always gets toolbar) | Yes | `anchor.timestamp` |
| Final assistant `answerBlocks` | `false` (default) | Yes | `messages[finalAssistantIdx].timestamp` |
| Final assistant `processBlocks` | `true` | **No** | — |
| Non-final assistant messages | `true` | **No** | — |

So the three call sites become:

1. `renderUserFromMsg(anchor)` — pass `anchor.timestamp` through to
   `renderNavigableUserMessage`.
2. Final-assistant **answer** render — pass
   `messages[finalAssistantIdx].timestamp`, toolbar on (default).
3. Final-assistant **process** blocks and all non-final assistant messages —
   pass `suppressToolbar = true`, no toolbar. These render into
   `ensureGroup().body` (the folded "Process details" container).

`renderNavigableUserMessage({ content, images, isHistory, timestamp })` adds
a `timestamp` parameter forwarded to `renderUserMessage`.

`public/native/app.js` also has a history-replay loop (`renderHistory`),
which iterates messages and calls `renderUserMessage(message, true)` /
`renderAssistantMessage(message, false, true)` directly. That loop must pass
the recorded `msg.timestamp` through (and, for assistant messages, honour the
answer-vs-process distinction just like `renderSessionHistory`) so native
history messages get timestamps too. The native path is simpler — it has no
turn folding today — but must at minimum forward `message.timestamp` on both
user and assistant renders.

#### Real-time user send

- **`public/app.js`** — at the send call site (where
  `renderNavigableUserMessage` is invoked for a fresh prompt), pass
  `timestamp: Date.now()`. The timestamp appears immediately.
- **`public/native/app.js`** — in `handleRuntimeEvent`, the `message_start`
  case for `event.message.role === "user"` currently calls
  `renderUserMessage(event.message)` with no timestamp. It must pass
  `timestamp: Date.now()` (or forward `event.message.timestamp` when the
  runtime event carries one) so native user messages get a timestamp too.
  Today `messageRenderer.renderUserMessage(event.message)` is the only user
  render in that path; this is the single edit point.

#### Real-time assistant finalize

Assistant messages stream into a placeholder element without a toolbar. On
finalize (the point that converts the streaming element into a settled
assistant message), the renderer attaches the `.message-actions` toolbar
using `Date.now()` as the timestamp, and wires up the copy button.

If the streaming element is rebuilt rather than mutated (implementation
detail to verify), the finalize path instead re-renders with
`isStreaming = false` and `timestamp = Date.now()`.

This finalize step is required in **both** render paths:

- **`public/app.js`** — finalize happens at the existing streaming-to-settled
  transition (the handler that closes out an assistant turn).
- **`public/native/app.js`** — finalize happens in `handleRuntimeEvent`'s
  `message_end` case. Today that case only calls
  `updateStreamingMessage(streamingElement, …)` and then sets
  `streamingElement = null`; it performs **no** toolbar/timestamp attachment.
  The `message_end` handler is therefore the native finalize point and must
  additionally attach `.message-actions` (copy + `timestamp = Date.now()` +
  usage) before clearing `streamingElement`. Without this, native WebView
  assistant messages would never receive a finalized toolbar/timestamp.

### Ephemeral chats (Quick Chat / Side Chat)

`ephemeral-chat-view.js` calls `renderUserMessage` / `renderAssistantMessage`
without a `timestamp`. `formatMessageTime(undefined)` returns `""`, so the
time span is omitted. The toolbar still renders with the copy button (and
future actions). No changes to `ephemeral-chat-view.js` are required for this
phase.

## Visual and interaction design

- **Timestamp** — small (`--font-size-sm`), `--text-dim` colour, tabular
  numerals where supported. Same baseline as the sidebar's `.session-time`.
- **Copy button** — keeps today's icon, `copied` → "✓" feedback animation.
  Now lives inside the toolbar.
- **Usage (cost)** — styling unified with the timestamp: same `--font-size-sm`,
  same `--text-dim` colour, same tabular numerals. No separate opacity. Only
  shown when `cost > 0`.
- **Hover target (user)** — the user message block (bubble + toolbar), sized
  to content so mouse-leave hides the toolbar. The assistant toolbar needs no
  hover target (always visible).
- **No toolbar on**: error rows (`renderError`), welcome screen, system
  messages, folded process-detail groups (thinking / tool calls).

## Accessibility

- Toolbar revealed by `:focus-within` as well as `:hover`, so keyboard users
  see the actions when they tab to them.
- Each action button has an `aria-label` (copy already does via
  `messages.copyMessage`).
- The timestamp is a presentational `<span>`; its full value is exposed via
  `title` for screen-reader users who want the exact time.
- Touch devices (`@media (hover: none)`) keep the toolbar visible so there is
  no hidden interaction.

## Performance

- No virtualization in this phase. The toolbar is a handful of elements per
  message; even at ~1000 messages the overhead is modest because the toolbar
  is static once rendered.
- The hover/focus reveal is pure CSS (`opacity`), so there is no per-message
  JS listener cost.
- If large sessions show measurable jank in practice, a later change can
  defer toolbar construction until intersection; this is explicitly out of
  scope now.

## Future Work: fork / delete

This phase defines the toolbar contract but does **not** implement fork or
delete. The intended semantics, to be confirmed in a follow-up spec:

### Fork (from a user message)

- **Semantics (confirmed):** forking from a message starts a new session that
  **keeps everything up to and including that message**; all later messages
  are discarded in the new session.
- **Open research item:** how Pi's `/fork` command (or session forking RPC)
  works must be investigated before implementation — the fork likely needs to
  branch the session tree at the target entry id (`entry.id` / `parentId`),
  not merely copy messages. The toolbar's fork action will surface this on
  user messages (the natural branch point is a user turn).
- Fork does not discard anything in the **current** session; it opens a new
  one. No destructive confirmation is expected, but this is to be reconfirmed
  once the Pi fork mechanism is understood.

### Delete (a full turn)

- **Semantics (confirmed):** delete removes a **complete turn** — a user
  message together with everything after it up to (but not including) the next
  user message. This matches the turn grouping already computed in
  `renderSessionHistory`.
- Delete is destructive and edits the session file, so it will require a
  confirmation step and a clear error path. Details in a follow-up spec.
- Whether delete is offered on the user message, the assistant message, or
  both (acting on the enclosing turn) is to be decided in that spec; the
  toolbar contract supports placing it on either role.

### Why they are deferred

Both actions need Pi-side / session-file semantics work that is larger than
the toolbar itself. Locking the toolbar contract now means those features add
buttons without touching layout, alignment, or visibility logic.

## Tests

### `formatMessageTime` (unit, TDD-friendly)

- Same-day timestamp → `HH:MM`.
- Different-day timestamp → `MM/DD HH:MM`.
- Invalid inputs (`null`, `undefined`, `NaN`, `"not-a-date"`) → `""`.

### `MessageRenderer` (DOM)

- `renderUserMessage` with a timestamp renders `.message-actions` containing
  `.message-time` then `.message-copy-btn`, in that order.
- `renderUserMessage` without a timestamp renders the toolbar with copy only.
- `renderAssistantMessage` with `isStreaming = true` renders no `.message-actions`.
- `renderAssistantMessage` with `isStreaming = false` renders
  `.message-actions` with copy, time, and (when cost > 0) usage in order.
- `renderAssistantMessage` with `suppressToolbar = true` renders **no**
  `.message-actions` row at all (used for folded process-detail rows).
- Error/welcome rows render no `.message-actions`.

### Hover / focus reveal (CSS-gated, jsdom-light)

- `.message-actions` exists with `opacity: 0` by default and the CSS rules
  reveal it under `:hover` / `:focus-within`. (Visual behaviour is CSS; tests
  assert the DOM class structure and that no inline style forces visibility.)

### History integration

- `renderSessionHistory` (`public/app.js`) passes `msg.timestamp` to the user
  renderer and to the final-assistant answer renderer of each turn.
- `renderSessionHistory` renders process-detail rows (processBlocks,
  non-final assistant messages) with `suppressToolbar = true` so they carry
  no `.message-actions`.
- `renderHistory` (`public/native/app.js`) passes the recorded `msg.timestamp`
  through on both user and assistant renders, mirroring the public path.

### Real-time finalize integration (both render paths)

- The `public/app.js` finalize transition attaches `.message-actions` with
  copy + timestamp (`Date.now()`) + usage to the settled assistant element.
- The `public/native/app.js` `message_end` handler attaches `.message-actions`
  with copy + timestamp (`Date.now()`) + usage before clearing
  `streamingElement`. (Asserted via a harness that drives `handleRuntimeEvent`
  with a synthetic `message_end` event.)
- The `public/native/app.js` `message_start` handler for `role === "user"`
  passes a timestamp so the native user message renders `.message-time`.

### Ephemeral

- `renderUserMessage({ content })` with no timestamp produces a toolbar with
  copy and no `.message-time`.

### Validation commands

- `bun run vitest run public/ui/message-renderer.test.js`
- `bun run check` (biome + design check)
- `bun run test` (full suite)

## Acceptance criteria

- [ ] User and final-assistant messages show a timestamp (`HH:MM` same day,
      `MM/DD HH:MM` otherwise). Hovering the timestamp shows the full time.
- [ ] Tooltips with no timestamp source (Quick/Side Chat, legacy sessions)
      render the toolbar without a time span.
- [ ] Copy button and timestamp share a single `.message-actions` toolbar.
      The **user** toolbar is hover/focus-gated (hidden on mouse-leave); the
      **assistant** toolbar is always visible.
- [ ] Touch devices show the user toolbar persistently (assistant already is).
- [ ] Assistant toolbar's timestamp and usage (cost) share one styling
      (font-size, colour, tabular numerals).
- [ ] Assistant streaming messages show no toolbar; it appears on finalize.
- [ ] `formatMessageTime` is a standalone helper, not reusing
      `formatSessionTime`.
- [ ] Toolbar slot order and alignment match the contract table; adding a
      future action requires only appending a `.message-action` button.
- [ ] **Both render paths** — `public/app.js` (embedded-server WebView) and
      `public/native/app.js` (native WebView) — produce finalized toolbars
      with timestamps on user and final-assistant messages. Native
      `message_start` (user) and `message_end` (assistant finalize) both
      attach timestamps/toolbars.
- [ ] `bun run check` and `bun run test` pass.
