# Chat Window Turn IA, History Fold, Scroll Ownership & Type Scale Design

**Status:** Implemented 2026-09-19 (P1–P5, per the 2026-09-19 goal; D1/D2/D3/D5 taken
at their recommended options, D4 as decided 2026-09-16).
**Date:** 2026-09-16
**Provenance:** borrow-list items #1, #2, #4, #5 from the PiChamber study
(`.memory/notes/pichamber-ui-and-remote-study.md`). PiChamber is Electron + React; only its
**information architecture and behaviour** are borrowed here. No React pattern, no runtime
abstraction, no code port is proposed.

## Goal

Make a long agent turn readable and a long session affordable, in the existing vanilla
WebView, by giving the main chat **one turn model** that both the live stream and history
rendering use.

Five workstreams, deliberately ordered by risk (each is independently shippable):

| Phase | Work | Type |
| --- | --- | --- |
| P1 | Turn as the rendering unit; unified live/history shape; status header | structural |
| P2 | History fold gate for old settled turns | structural |
| P3 | Scroll ownership (self-initiated vs user-initiated scrolling) | behaviour fix |
| P4 | Semantic type roles in the token layer | token layer |
| P5 | Conversation navigator rail: registry-sourced turn list, windowed ticks, coalesced spy | interaction fix |

## Non-goals (what is deliberately not taken from PiChamber)

- Its **palette**. PiChamber's warm OKLCH theme is a visual identity decision, not an
  improvement over Picot's six existing themes. P4 adopts the token *structure* only, and
  **no themes are added** (D4, decided 2026-09-16 — see "P4 — No new themes").
- PiChamber's **prompt navigator rail** (722 lines for one tick tape). P5 changes only Picot's
  existing conversation navigator rail; it does not add PiChamber's surface or interaction model.
- Its **mount budgets** (40 activities per rail, 31 response records). Picot builds the live
  DOM as events arrive, so these only pay off for history mounts; deferred until measured (P2.3).
- Any React-specific machinery (memo comparators, WeakMap caches, topic-scoped stores).

## Current state — the real defect

**Live and history render the same concept two different ways.**

- `renderSessionHistory()` (`public/app.js`) is already turn-based: it splits entries into
  turns, picks the turn's final assistant (`assistantHasText`), splits its content with
  `splitFinalAssistantBlocks()` (`processBlocks` = everything up to the last non-text block,
  `answerBlocks` = trailing text), and renders a `createProcessDetailsGroup()` **before** the
  final answer. This is, structurally, PiChamber's turn layout minus the status header.
- The live path has **no turn model at all**: `handleMessageStart` creates one
  `.message.assistant.streaming` element per assistant message; thinking is prepended
  *inside* `.message-content` (`updateStreamingThinking`); tool cards are appended to
  `messagesElement` directly by `ToolCardRenderer` (constructed with `messagesElement`).
- At `agent_end`, `collapseCompletedTurn()` (`public/app.js`) repairs the live DOM by
  surgery: it takes every child after the last `.user` element, moves `.tool-card`s and
  `.thinking-block`s into a new process group inserted before the first moved node, and
  deletes assistant shells that became empty.

Consequences of the surgery, all verifiable in the current code:

1. **Chronology is flattened.** Folded nodes are all moved into one group; interleaving of
   text and tools inside a turn cannot survive.
2. **It is positional, not identified.** The turn is "everything after the last `.user`
   element". A transcript whose current turn has no user bubble (assistant-only history,
   resumed mid-turn, remote/terminal-started session) makes `lastUserIdx === -1` and the
   whole transcript tail is swept into one group.
3. **Turn identity is thrown away.** Rust already forwards the authoritative `turnId`:
   `runtime_event_frame()` in `src-tauri/src/host_server.rs` copies `event.turnId` to the
   frame top level (and `sequence` was already used). The WebView never reads it —
   `runtimeEvent` handling in `public/app.js` spreads only `__target` and `__sequence`.
4. **Duration is unrecorded.** `agent_start` / `agent_end` are handled for streaming flags
   only (`state.setStreaming`); no start/end timestamps exist, so no "Worked for 12s" is
   possible today.
5. **Scroll ownership is unmodelled.** `MessageRenderer` keeps a single `isNearBottom`
   boolean recomputed in a `scroll` listener with a 100px threshold, and calls
   `scrollToBottom()` (rAF) from every `renderUserMessage` / `renderAssistantMessage` /
   `updateStreaming*` / `createToolCard`. `.messages` also carries `scroll-behavior: smooth`
   (`public/style.css`). Nothing distinguishes a scroll the page caused from a scroll the
   user caused, so smooth-scroll events and markdown re-layout can both re-arm auto-follow
   while the user is reading history.
6. **Two history costs are unbounded.** `renderSessionHistory()` mounts every turn of the
   session in one synchronous pass, and each settled turn mounts all of its folded activity
   (just hidden by CSS).
7. **Type is unowned.** `public/style-theme.css` defines a 6-step px scale
   (`--font-size-sm…2xl`) and `public/style.css` uses it 264 times; ~35 declarations use
   literal px/rem. Code blocks set only `font-family`, so preformatted text inherits the
   chat font size (`.message-content { font-size: var(--chat-font-size, …) }`) — there is no
   code/meta role, and no way for the Appearance font-level preference
   (`CHAT_FONT_SIZE_PX` in `public/appearance-preferences.js`) to scale roles coherently.

---

## P1 — Turn as the unit

### Contract

**P1.1 New module `public/ui/turn-model.js` (pure, no DOM).** The single owner of turn
classification and labelling, unit-testable:

```text
classifyTurnSegments(assistantSegments) -> { railSegments, answerSegment }
  // assistantSegments: [{ hasText, hasToolCall }] in arrival order
  // answerSegment = the last segment with text AND no tool call after it;
  // every other segment is a rail segment. Reproduces splitFinalAssistantBlocks()
  // semantics for the live path.
resolveTurnDurationMs({ startedAt, completedAt }) -> number | null
formatTurnDuration(ms) -> string          // "12s" / "1m 04s"
summarizeTurnRail(stepCount, toolCallCount) -> string   // delegates to summarizeProcessGroup()
```

`classifyTurnSegments` must agree with `splitFinalAssistantBlocks()` on finalized content —
this equivalence is the test that keeps live and history honest.

**P1.2 New module `public/ui/turn.js` (DOM owner).** One element per turn,
`<section class="turn" data-turn-id="…">` containing, in order:

| Slot | Class | Content |
| --- | --- | --- |
| user | existing `.message.user` (unchanged) | the prompt |
| status | `.turn-status` | live: working indicator + model + elapsed; settled: `Worked for 12s` |
| rail | `.turn-rail` | thinking + tool cards, arrival order, collapsed/expanded |
| answer | `.turn-answer` | the final assistant text |

The module exposes `status.setLive/setSettled`, `rail.host` (a container to append into),
`rail.setLabel`, `rail.setDisclosure`, `answer.host`.

**P1.3 Live path routes into the turn.** `MessageRenderer` gains an opt-in
`{ turns: true }` option (main window only — Quick/Side Chat keep flat rendering, matching
the "main window first, ephemeral dispatch isolated" precedent):

- `handleAgentStart` opens a turn via `turn.js` and records `startedAt` in `app/state.js`.
  Direct sends already render an optimistic user bubble before `agent_start`: keep one pending
  user-element reference keyed by the current runtime/session. `openTurn()` may move that element
  into the turn only when its key matches the event target; otherwise it creates an
  assistant-origin turn. Clear the pending reference on session switch, reconnect reset, agent end,
  and after it is claimed, so a stale optimistic bubble can never cross sessions.
  A **user echo from Pi** (`message_start` role `user`) claims into the open turn the same way
  when that turn has no user row yet. This matters for sends that render no optimistic bubble:
  a steer (steering spec) emits `agent_start` *before* the echoed user message, so appending the
  echo flat would render the prompt **below the answer it steered**.
  **History rendering must claim the bubble too.** The turn section is built rail → answer, so a
  user element simply appended into it lands below its own answer — every replayed turn reads
  assistant-first, user-last. Both the live and the history renderers therefore place the user
  row through the same user-slot seam, and the turn's child order is always
  `user → (status) → rail → answer`.
- Assistant text renders into `turn.answer.host` while it is the only content; on the next
  `tool_execution_start` within the same turn the open text segment is **demoted** into the
  rail (one element move, at most once per segment) — that is the live expression of
  `classifyTurnSegments`. `handleMessageStart` opens a new segment for each assistant message.
- Thinking (live and finalized) renders **into the rail**, never inside `.message-content`.
  `updateStreamingThinking`'s `contentDiv.prepend(thinkingDiv)` is removed.
- Tool cards land in the rail. `ToolCardRenderer.createToolCard()` gains the same optional
  `targetContainer` parameter its history sibling `createHistoryCard()` already has;
  `app.js` passes `turn.rail.host`. No change to `updateToolCard` /
  `finalizeToolCard` / `addHistoryResult` (they resolve the card from `this.toolCards`).

**P1.4 Turn identity is optional runtime correlation.** In the `runtimeEvent` listener, forward
`turnId: frame.turnId ?? frame.event?.turnId` alongside `__target` / `__sequence`. When present,
stamp it as `data-turn-id`; when absent, `turn.js` allocates a local display id. Neither id may
reach abort, a control frame, or an authorization decision: the native event pump remains the
owner of turn-bound abort correlation.

**P1.5 Status header.** Live: a working indicator plus the model name and elapsed time, using
one 1s interval that exists only while a turn is live (never a per-render timer). Settled:
`Worked for 12s`. Row height is fixed so phase text changes cannot reflow the transcript. The turn
status renders its own indicator; it does not move shared `#typing-indicator`, which remains the
fallback for non-turn paths (auto-retry, abort/reconnect recovery, and ephemeral chats).

### Deletions

- `collapseCompletedTurn()` — deleted outright. Its whole job (fold the finished turn) is now
  what rendering into the turn does from the start.
- `updateStreamingThinking()`'s in-content thinking insertion path — replaced by rail hosting.
- `handleAgentSettled()` keeps only its streaming-flag reconciliation; the fold call goes.

### i18n

`messages.*` in en/zh/ja/es: `turnWorking` (Agent working), `turnWorkedFor` ({duration}),
`turnRailLoadEarlier`, plus reused `messages.processDetails*` for the rail label.

### Verification

- `turn-model.test.js`: `classifyTurnSegments` matrix (text-only / tool-only / text-tool-text /
  tool-text / text-tool), **plus an equivalence test against `splitFinalAssistantBlocks()`**
  on the same finalized blocks; duration formatting and null-input cases.
- Behaviour test: a scripted live sequence (optimistic user → agent_start → text → tool_start →
  text → tool_end → message_end → agent_end) and equivalent persisted entries produce the same
  normalized turn projection: user text, rail item kinds and order, final answer text, and entry
  anchors. Test live/history DOM details separately; they need not have identical transient classes
  or tool status markup.
- Manual e2e (no framework covers this): abort mid-turn, reconnect with `agent_end` missed,
  session switch mid-stream, two windows on one session, Quick/Side Chat unchanged.
- `bun run check`, focused vitest, then `bun run test`.

---

## P2 — History fold gate

### Contract

- `renderSessionHistory()` gains a mount gate: the newest **2** settled turns render in full;
  all older turns are represented by **one** centred batch control with the remaining count.
  `Load older history` reveals the next **2** turns immediately **after** that control. `Load all
  history` remains available but mounts in cancellable rAF/idle batches at the control's position
  instead of synchronously mounting the whole session. Constants live in `turn-model.js`.
  *2026-09-24 revision (Dr. Lin):* the control is the transcript's **first element** and stays
  there — revealed batches insert below it. Inserting above it buried the control under the turns
  it had just revealed, so a reader who scrolled up to read them had to scroll back down to load
  more. The control never moves, so no scroll compensation is applied (a reveal only runs while
  the control is on screen: auto-reveal margin or a click).
- Folding **only affects mounting** — the session log, the Info tree, fork/edit entry ids, and
  the file-chips rows are untouched.
- Revealing keeps the viewport anchored by construction: the control does not move when a batch
  lands below it, so the reader's position is never fought. (`anchorHistoryToBottom()` with its
  `preserveScrollTarget` behaviour remains the precedent for the auto-scroll path.)
- **Search interacts with the gate, explicitly.** `renderSessionHistory({ searchQuery })`
  currently calls `messageRenderer.highlightSearchQuery(searchQuery)` after rendering. A
  hidden turn must still be searchable: when `searchQuery` is present, unmount the gate
  (mount all turns) before highlighting, then re-apply the gate only on the next render
  without a query. Without this rule, session search silently stops finding old matches.
- Revealing is render-local state, not persisted, and resets on session switch (same
  lifetime as the existing process-group disclosure).
- **The rail must not lose turns to the gate.** The conversation navigator rail currently
  derives its turn list by walking the DOM, so folding would silently shrink its tick list to
  the mounted subset. P5.1 replaces that source with the turn registry; **P5 therefore lands
  before P2.**

### Not in P2 (deferred)

Rail mount budget per turn and per-turn response pagination (P2.3 in the PiChamber list).
Rationale: the live DOM is already built incrementally, so these only help history mounts;
add them only against a measured threshold (`scripts/perf` tooling exists).

### i18n

`messages.loadOlderHistory`, `messages.loadAllHistory` in en/zh/ja/es.

### Verification

- Focused test: given N turns, the gate mounts the last 2 plus one batch control; `Load older
  history` mounts the next 2 in order; `Load all history` mounts cancellable batches without
  moving the viewport; and a `searchQuery` render mounts all turns before highlighting.
- Manual e2e: search-in-session finds a match inside an old folded turn; fork/edit from a
  revealed turn still resolves the right entry id; scroll anchor does not jump on reveal.

---

## P3 — Scroll ownership

### Contract

New module `public/session/scroll-ownership.js` owning the question "did we scroll, or did the
user scroll?" — the shared root cause the current 100px boolean cannot express:

```text
createScrollOwner({ container, thresholdPx = 100, tolerancePx = 2, ttlMs = 600 })
  noteProgrammatic(target)   // called immediately BEFORE any page-initiated scroll
  isUserScrollEvent()        // true only for input-initiated scrolls
  isFollowing()              // should new content follow the bottom?
  onUserIntent(fn)           // wheel / touchstart / keydown / pointerdown on the scrollbar
```

Rules:

1. A `scroll` event whose `scrollTop` matches a recorded `noteProgrammatic()` target within
   `tolerancePx` inside `ttlMs` is **self-caused**: it must not change follow state. A mismatch
   only clears the recorded programmatic target; it also must not change follow state.
2. Only **user-intent** events (`wheel`, `touchstart`, `keydown` on the container, pointer
   down on the scrollbar) may suspend following. A scroll event alone never suspends it.
3. Programmatic scrolls set `scroll-behavior: auto` for the duration of the write and restore
   it afterwards, so the recorded target is reached deterministically. The unconditional
   `scroll-behavior: smooth` on `.messages` is removed; smooth is applied only to
   user-initiated jumps (scroll-to-bottom button).
4. Content growth above the viewport must not change follow state; history hydration keeps
   using `anchorHistoryToBottom()`.
5. Re-entering follow mode is explicit: distance-to-bottom under `thresholdPx` on a
   user-caused scroll, or the scroll-to-bottom control.

`MessageRenderer.scrollToBottom()` and `ToolCardRenderer.scrollToBottom()` both delegate to
the owner instead of testing `isNearBottom` themselves. `MessageRenderer.isNearBottom` is
deleted (it is the shared state that makes the two renderers fight).

### Verification

- `scroll-ownership.test.js` with a stub container: programmatic matching and diverging scrolls
  both keep follow state; divergence only clears the programmatic token; a user wheel suspends
  regardless of distance; a scroll event with no user intent never suspends; expiry of the TTL
  still does not create user intent; re-arm on returning under the threshold.
- Manual e2e (the only real proof): scroll up during a fast streaming turn with long markdown
  code blocks and confirm the viewport stays put; press the scroll-to-bottom control and
  confirm following resumes; feed a tool card while reading history.

---

## P4 — Semantic type roles

### Contract

- Add fallback role tokens in `public/style-theme.css`, mapped onto the existing scale (no new
  scale, no re-skinning): `--text-markdown` (= today's `--chat-font-size`), `--text-code`,
  `--text-meta`, `--text-ui-label`. Runtime-derived values remain the responsibility of
  `applyAppearanceToDom()`.
- `--text-code` is derived from the chat font level through a table in
  `public/appearance-preferences.js` (`CODE_FONT_SIZE_PX`), mirroring the existing
  `CHAT_FONT_SIZE_PX` / `PREVIEW_FONT_SIZE_PX` pattern — one step below the chat size,
  clamped to a 12px floor. Code blocks and inline code stop inheriting the chat size.
- `applyAppearanceToDom()` writes the role tokens it derives, exactly as it already writes
  `--chat-font-size`.
- Chat-surface literals are replaced **only** where they are role-bearing (message meta,
  timestamps, status rows, code) — not a repo-wide px sweep. Remaining literal declarations
  outside the chat surface are out of scope.

### No new themes (D4, decided 2026-09-16)

Dr. Lin: **Picot does not add themes.** No warm pair, no palette change, no pairing mechanism
— the existing six themes stay exactly as they are. P4 is type roles only, and it must not
touch a single colour token.

Recorded why, so this is not re-litigated: PiChamber ships 42 theme variants (20 families ×
light+dark, plus two single-variant themes) because each theme carries a `metadata.variant` and
the settings UI offers a Color Mode (`system | light | dark`) **plus two** independent selectors
(`selectedLightTheme` / `selectedDarkTheme`). Picot has none of that — `data-theme` holds one
id, the `dark` flag only feeds `isThemeDark()`, OS-follow is hardcoded light→terracotta /
dark→night. Adding a warm pair would therefore either ship two unrelated cards (the light one
landing within a few percent of Terracotta's `#f4f1ec`, i.e. a near-duplicate) or require
building PiChamber's per-variant preference model. Neither is worth it; the palette is not the
problem this spec solves.

### Verification

- Unit test: the code-size table covers every `FONT_SIZE_LEVELS` entry, is monotonic, and
  respects the 12px floor; `applyAppearanceToDom` writes the derived roles for each level.
- Visual check across all six themes × five chat font levels (the appearance spec's existing
  manual matrix), plus code blocks inside user bubbles and inside the process rail.

---

## P5 — Conversation navigator rail

**Depends on P1** (turn registry, the answer slot, `[data-turn-id]`) and **lands before P2**
(see the cross-reference in P2's contract). Scope is the rail that already exists — the
`// Conversation navigator rail (Codex-style)` block in `public/app.js` (`getConversations`,
`getActiveConvIndex`, `jumpToConversation`, `rebuildNavDots`, `showNavTooltip`), the
`Conversation navigator rail` block in `public/style.css`, and `#conv-nav` / `#conv-nav-track` /
`#conv-nav-tooltip` in `public/index.html`. No new surface is added; PiChamber's 722-line
implementation is **not** the target.

### Defects this removes (all verified in the current code)

1. **Overflow is whole-track scaling.** `rebuildNavDots()` applies
   `transform: scale(560 / naturalHeight)` with `transformOrigin: "top left"` past
   `CONV_NAV_MAX_HEIGHT = 560`. This shrinks hit targets and visually compresses the rail; it also
   hand-synchronizes `transform`, the pre-scale `--nav-w` value, and `convNavEl.style.height`.
2. **Per-tick hover rebuilds the entire rail.** Every tick owns `onclick` / `onmouseenter` /
   `onmouseleave` closures and both handlers call `rebuildNavDots()`, which walks all turns and
   reassigns handlers/styles. The cost at 60/100 turns is a hypothesis to baseline before P5.
3. **Uncoalesced scroll path.** The `scroll` listener runs the same full work on every event,
   with no rAF coalescing and no cached offsets.
4. **No bottom anchor.** `getActiveConvIndex()` returns the last turn whose user-message top is
   at or above `visibleTop + 4`, else `0`. At the bottom of a session whose last turn is short,
   that prompt never crosses the reading line, so the highlighted tick stays one behind;
   `_navLockedIdx` (an 800ms lock) masks it only right after a jump.
5. **The settled-turn preview is dead.** `getConversations()` pairs a user message with
   `nextElementSibling`, but `collapseCompletedTurn()` inserts the process-details group
   between them, so `reply` is `null` for every settled turn and the tooltip renders the
   question only. This is the P1 dependency in one symptom; P5.1 removes the cause.
6. **Pane-edge docking.** `.conv-nav { left: 16px }` anchors to the chat pane while `.messages`
   pads its content by `max(var(--space-12), calc((100% - 960px) / 2))`. On a 2560px window the
   message column starts ~800px from the pane edge and the rail floats alone at 16px.
7. **Ordinal-only, unlocalized labels.** Ticks are `<button>`s labelled
   `"Jump to conversation 7"` (hardcoded English), and `#conv-nav`'s
   `aria-label="Conversation navigator"` is a hardcoded English literal in `index.html`.

### Contract

- **P5.1 Turn source is the registry, never a DOM walk.** Keep a complete, session-scoped turn
  registry with `{ id, promptPreview, answerPreview, entryId, mountedElement? }`; separately
  derive the bounded tick DOM window from it. `ensureTurnMounted(turnId) -> Promise<Element>` is
  the shared P2/P5 seam: it reveals a folded turn, waits for its DOM mount, then returns its
  `[data-turn-id]` element for scrolling. On session switch, clear the registry, pending reveal,
  cached offsets, observers, and navigation lock before accepting new turns. This restores settled
  answer previews and keeps the rail independent of P2's mounted subset.
- **P5.2 Constant pitch plus a window of ticks, never a transform.** One pitch constant, at
  most 30 ticks in the DOM, centered on the active tick while the user is not interacting, and
  glided by one tick when the pointer or focus reaches an edge zone. The scale strategy and all
  three of its bookkeeping quantities are deleted.
- **P5.3 One hit surface.** The track becomes a single keyboard-reachable `role="listbox"`
  with `tabindex="0"`; it owns `aria-activedescendant`. The tick index is
  `clamp(Math.floor((pointerY - trackRect.top) / PITCH), 0, count - 1)`. Ticks become
  non-interactive visuals (`pointer-events: none`) carrying `role="option"` only for the
  `aria-activedescendant` relationship; the track itself never gets `pointer-events: none`.
  Widths are written only for the overscan window. Per-tick closures and the hover-time
  `rebuildNavDots()` call are deleted.
- **P5.4 Scroll spy with cached offsets.** Adopt PiChamber's `scrollSpy` shape: offsets are
  recomputed only when a dirty flag is set (ResizeObserver on the container and on registered
  ticks with a ~100ms debounce, MutationObserver for structure only), a scroll event sets the
  flag and schedules one rAF, and the active tick is a binary search for the last tick at or
  above the reading line. **Keep Picot's header-aware line** (`visibleTop` = the greater of the
  container top and the floating header's bottom, +4px) — it is better than PiChamber's
  `scrollTop + 100` because Picot has a floating header — and **add the missing bottom anchor**:
  within `max(48px, 10% of the viewport)` of the bottom, the active tick is the last turn.
  Re-evaluate `_navLockedIdx` afterwards: with the anchor and coalescing in place it may be
  removable, but that is a measurement decision, not part of this contract.
- **P5.5 Labels and keyboard.** A tick's accessible label becomes the prompt preview
  (truncated, whitespace-collapsed) instead of an ordinal, and new i18n keys replace both
  hardcoded English strings. Focus stays on the track; `aria-activedescendant` identifies the
  active visual option. ArrowUp/ArrowDown/Home/End move the active index, Enter calls
  `ensureTurnMounted()` then jumps, and Escape returns focus to the transcript. The existing
  previous/next-conversation shortcuts keep sharing the same active-turn resolution.
- **P5.6 Left-gutter float（2026-09-19 手动测试修订）.** The rail floats in the chat
  pane's left gutter via CSS `left: 16px` against its offset parent（gutter ≥ 48px；
  `@media (max-width: 900px)` 隐藏保留）。The original column-edge docking was implemented
  then rejected in manual review: it double-counted the sidebar width (viewport rect fed into
  an offset-parent-relative `style.left`) and landed mid-window; the left-gutter float is the
  confirmed target behavior. The left side is kept deliberately: Picot's user bubbles are
  right-aligned and filled, so a right-side rail would contend with the bubble edge and its
  action toolbar.

**Deliberately not in P5** (PiChamber has these; they are polish on top of a working rail): the
hover mini-list panel, the edge auto-carousel timer, the sliding window/panel animations, and a
per-tick `Load more prompts` affordance. The existing question+answer tooltip stays as-is, with
its answer line fixed by P5.1. The existing whole-rail hover pill stays too — its CSS already
keeps border and padding constant so it cannot shift tick layout, and P5.2's windowing must
preserve that property.

### Deletions

- `CONV_NAV_MAX_HEIGHT`, the `scale()` computation, the pre-scale `--nav-w` write and the
  `convNavEl.style.height` sync.
- The per-tick `onclick` / `onmouseenter` / `onmouseleave` closures and the
  `rebuildNavDots()` calls inside them.
- The `scroll` listener's inline rebuild body (replaced by the spy).
- `getConversations()`'s DOM pairing — superseded by P5.1's registry read.
  `getActiveConvIndex()` moves into the spy and loses its `0` fallback in favour of the
  bottom-anchor rule.
- Both hardcoded English labels.

### i18n

`messages.conversationNavigator` (replaces the `index.html` literal) plus the preview-based
label; keys in en/zh/ja/es.

### Verification

- Pure model tests (in the rail module): the window computation (30-tick cap, centering, edge
  glide, clamping), the reading-line pick over offsets (binary search and boundary cases), and
  the bottom-anchor override.
- Behaviour test on a synthetic 60-turn fixture: at most 30 ticks in the DOM; the active tick
  remains inside the window; pointer and keyboard index mapping work at both window edges without
  rebuilding unchanged tick nodes; the tooltip shows the registry answer preview for a settled
  turn; jumping to an unmounted turn awaits `ensureTurnMounted()` before scrolling.
- P2 interaction test: with the gate closed the rail lists every turn, and jumping to a folded
  turn reveals it before scrolling.
- Manual e2e: a 100+ turn session, scrollbar drag, jump to the oldest turn, keyboard
  navigation, a window narrow enough for the column to reach the rail, the 900px breakpoint,
  and a session switch mid-scroll.
- Baseline before P5: with a 60- and 100-turn fixture, record scroll script time and layout/recalc
  counts (`scripts/perf`). Repeat after P5; the result, not an assumed threshold, decides whether
  `_navLockedIdx` remains necessary.

---

## Open decisions

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Live segments: demote-on-tool-start (text can move from the answer slot into the rail once) vs never move (accept inverted order vs history) | A: demote · B: never move | **A.** It is one element move per segment, it reproduces history exactly, and the alternative leaves live and history permanently divergent — the defect this spec exists to remove. |
| D2 | Live status header: elapsed from `agent_start` (client clock) vs no duration while live | A: elapsed timer · B: settled-only | **A**, with the timer alive only during a live turn. A client clock can drift from the daemon's `runStartedAt`; flag it and keep the settled value computed from the same client clock so the two never disagree. |
| D3 | Fold gate: which turns stay mounted | A: newest 2 · B: newest 1 · C: by total activity count | **A** (matches the borrowed design and is easy to describe). C is better if a 2-turn session is still heavy; needs measurement first. |
| D4 | New themes / warm palette | **DECIDED 2026-09-16 (Dr. Lin): do not add themes.** No warm pair, no palette change, no pairing mechanism. No longer an open decision. | P4 is type roles only and must not touch a colour token. Rationale recorded under "P4 — No new themes". |
| D5 | Scope of "code font size" | A: derived from chat level (no new setting) · B: its own Appearance knob | **A.** YAGNI until someone asks; the role token makes B a one-line change later. |

## Rollout order and rollback

P3 → P1 → P5 → P2 → P4.

P3 first because it is the smallest, has no DOM restructure, and its bug class (auto-follow
fighting the user) is independent — it can land and be validated alone. P1 next: it is the
structural phase, and both P2 and P5 need its turn registry. **P5 before P2**: P5.1 removes the
rail's DOM coupling, which the fold gate would otherwise break, and it also fixes the
settled-turn preview bug that P1's shape change re-exposes. P2 then builds on a
registry-driven rail. P4 is token-layer only and can land any time.

Each phase is individually revertible: P1's new turn structure is reachable only through the
`{ turns: true }` opt-in, so reverting means reverting the opt-in, not re-adding
`collapseCompletedTurn()` (which the revert commit restores as a whole). P5 reverts as a single
commit — it is self-contained in the rail module, its CSS block and the two labels, and no
other phase depends on its internals.

## Out of scope

The rail's hover mini-list panel, edge auto-carousel and animation polish (P5's explicit
exclusions); PiChamber's rail mount budgets; per-turn response pagination, **any new
or restyled theme (D4)**, the private relay and any remote-connection item (separate workstream,
note §2), the composer (separate spec), Quick/Side Chat rendering, the Info tree, session
search UI, and any change to the Pi protocol or the Rust host beyond forwarding the
already-present `turnId` to the WebView.
