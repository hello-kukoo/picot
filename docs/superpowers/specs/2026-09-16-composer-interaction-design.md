# Composer Interaction Design

**Status:** Approved — D1–D4 decided 2026-09-18 (all recommendations
accepted). The 2026-09-13 composer-follow-up spec is integrated as **C5**
(same day; source file deleted). C1–C5 implementation not started; Addendum A
below is approved and lands first.
**Date:** 2026-09-16
**Provenance:** borrow-list item from the PiChamber study
(`.memory/notes/pichamber-ui-and-remote-study.md` §1.5), re-verified against Picot's own
composer before writing. Independent of the chat-window spec
(`2026-09-16-chat-window-turn-ia-scroll-and-type-scale-spec`) — nothing here depends on
P1–P5, so it can be scheduled in parallel.

## Goal

Fix the composer's trigger arbitration and stop losing typed text. Four contract items, in
increasing cost: one trigger router, no menu for an unresolvable query, send-only-on-acceptance,
per-session drafts — plus C5, the follow-up queue send integrated from the former
2026-09-13 spec.

## Non-goals (deliberately not taken from PiChamber)

- **Its editor.** PiChamber wraps CodeMirror and keeps the document a plain string, and its own
  docs record the price of the highlighting it needed: a mirror-div composer that made
  width-affecting styles impossible and was disabled on mobile, a painted-selection layer that
  needed a native-selection extension for iOS input lag, and a range-scoped native caret to stop
  WebKit re-rendering its caret UI per keystroke. Picot's plain `<textarea>` plus one listbox per
  trigger is the cheaper correct design; none of that tunnel is proposed.
- Its 2612-line `ChatInput.tsx`, worktree/branch intent pickers inside the composer,
  first-prompt response-style injection, and the three-column attachment grid.
- Its mobile-keyboard correction **code**. The *discipline* is already here (the `e.isComposing ||
  e.keyCode === 229` guard with its WKWebView rationale in `messageInput`'s keydown handler is the
  same practice); nothing to port.

## Current state — what the code actually does

- Markup (`public/index.html`, `.composer-card`): `<textarea id="message-input">` plus three
  siblings — `#skill-slash-menu`, `#at-file-mention-menu`, `#image-previews` — and
  `#queued-messages` above the form. Toolbar left: attach + a button-triggered commands menu
  (`public/composer-command-menu.js`); right: model dropdown.
- Two independent pickers each install their own `input` and `keydown` listeners on the same
  textarea: `public/ui/skill-slash-command.js` (210 lines) and `public/ui/at-file-mention.js`.
  Both use `stopImmediatePropagation()`.
- Slash activation is `activeSlashQuery`: `beforeCursor.match(/^\/([^\s/]*)$/)` — it requires the
  **entire text before the caret** to be `/cmd`. So `请用 /skill:foo 处理这个文件` never opens the
  menu; slash commands only work when the composer contains nothing but the command. (`a/b`
  staying prose is the documented intent and must be preserved.)
- Two reachable consequences today: the two menus **can be open at once** (input `/abc@d` matches
  the slash regex and also yields a mention token `@d`), and because slash registers first
  (`app.js`, `setupSkillSlashCommand` before `setupAtFileMention`) its `stopImmediatePropagation`
  on Escape closes only itself — the mention menu is stranded until blur or token deletion.
- Unresolvable slash queries still open a menu with a "No matching skills" empty state.
- Send path (`sendMessage()` in `public/app.js`): `messageInput.value = ""` happens **before**
  dispatch; `trackPromptDelivery(requestId, message)` records the text with an **8000 ms
  self-expiring** timer; the rejection handler restores the text only when
  `!messageInput.value.trim()`, and otherwise shows `errors.messageNotDelivered`. So a prompt that
  fails late, or fails after the user has started typing again, is dropped without a trace.
- The streaming path is different and already safe: while `state.isStreaming` the message goes
  into the local `messageQueue` and the input is cleared immediately — the queue holds the payload.
- Composer text persistence today is exactly one mechanism: `workspace/nav-state-cache.js`'s
  `inputDraft` (1500-char cap, 90-second cookie, written only inside the swap-navigation snapshot,
  restored only when the composer is empty). `setComposerDraft()` is called once in the whole app
  (`app.js`, the fork/edit prefill). **There is no per-session draft**: switching sessions in the
  sidebar discards whatever is typed. (The comments at `app.js:867` / `:4892` describing "the saved
  draft" refer to this cookie snapshot and to `messageInput.value`, not to a draft store. Nothing
  named `editorText` or `draft` reaches the WebView from the Rust host — verified.)

## C1 — One trigger router

**New module `public/ui/composer-triggers.js`, pure and unit-testable:**

```text
resolveActiveTrigger(value, caret)
  -> { kind: 'slash' | 'mention', start, end, query } | null
```

- **Exactly one trigger may be active**, with fixed precedence (`slash > mention`). Both parsers
  first inspect the same caret position. If the caret is inside both valid tokens, slash wins;
  otherwise the sole valid token wins. A slash token starts at input start or after whitespace,
  ends at the next unquoted whitespace or the caret, and may include `:` and `@`; a mention token
  retains its existing rightmost-`@` and quote-aware rules. Thus `/abc@d` resolves to slash,
  while `/abc @d` resolves to mention when the caret is in `@d`.
- The **mention** branch must *move* `at-file-mention.js`'s existing parser (rightmost `@` only,
  quote-aware for paths with spaces, terminated by unquoted whitespace) — not rewrite it. Its
  semantics are already right and are covered by tests.
- The **slash** branch deliberately changes today's rule: the token at the caret starts with `/`
  at a token boundary (start of input or after whitespace), contains no unquoted whitespace, and
  keeps `:` allowed so `/skill:name` works. This makes a slash command usable mid-prompt while
  `a/b` stays plain prose.
- **One** `keydown` listener on the textarea routes Escape / ArrowUp / ArrowDown / Enter / Tab to
  the active picker, and only when that picker reports itself open; when none is open the keys fall
  through untouched (Enter still sends). Both modules' own `keydown` listeners are deleted, so no
  two handlers can ever contend for the same key again.
- Preserved: `aria-expanded` / `aria-activedescendant` wiring, `blur → queueMicrotask(close)`, the
  IME guard (`event.isComposing`; the composer's own keydown also keeps its `keyCode === 229`
  fallback for the WebKit/IME combination that reports a candidate confirmation as a plain Enter).

## C2 — No picker for an unresolvable query

- The slash/skill picker opens only when the resolved query has at least one candidate; otherwise
  the token stays plain prose. The heading-plus-"No matching skills" empty state is dead UI and
  goes, along with whatever renders it.
- The asynchronous skill load must not reopen the menu for a stale query — keep the existing
  generation check and extend it to the empty-result case.
- **`@` mention is deliberately excluded from this rule.** Its result set is query-driven and
  incremental against a remote search, so a transient empty list is legitimate feedback while
  typing. The distinction is catalog membership (static: skills, commands, snippets) versus search
  results (dynamic: files).

## C3 — Send only after the runtime response

Each direct `prompt` and C5 `follow_up` uses one delivery record:
`{ requestId, kind, text, images, sessionIdentity, state }`. Its states are `awaiting`,
`accepted`, `rejected`, and `unconfirmed`.

- `wsClient.sendRuntime()` must expose its generated `requestId` together with the promise for the
  correlated `runtime_response`. The record enters `awaiting` before the frame is sent; the input
  and pending attachments remain owned by the composer during that state. This replaces the
  current fire-and-forget `trackPromptDelivery()` timer.
- The correlated `runtime_response.response.success === true` is **acceptance**: Pi accepted,
  queued, or handled the command. It is not proof that the eventual agent turn succeeded. On this
  response, clear the composer only when it still equals captured text, consume only captured
  attachments, remove the record, and re-enable Send. A user edit during the wait wins.
- `runtime_response.response.success === false`, a correlated `runtimeError`
  (`command_undeliverable`), or a send failure is **rejection**. Remove the record, merge failed
  text back by replacing an empty composer or appending after a newline, return attachments to the
  pending set, retain `errors.messageNotDelivered`, and never overwrite a newer draft.
- If the correlated response has not arrived after 8000 ms, move the record to `unconfirmed` and
  render the existing `#queued-messages` area with `queue.unconfirmedSend`. Keep its request id,
  text, and attachments; never auto-resend. A late successful response resolves it as accepted; a
  late rejection follows the rejection path. Clicking the pill restores its text without sending.
- The streaming local-queue branch remains the documented exception: it has already retained the
  payload in `messageQueue`, so it may clear immediately. It must not also create an unconfirmed
  record.
- `handleResumeBranch`'s deliberate clear is authoritative; C3 restore paths must not resurrect
  input belonging to the old branch. C4 clears that branch's stored draft.

## C4 — Per-session drafts

- A draft belongs to an identity: the same session identity the send path resolves
  (`activeUiSessionFile` / the runtime target), plus a distinct key for the not-yet-materialised
  authoring target so a landing/global draft cannot leak into a registered session.
- **Write:** debounced (~300 ms) while typing, and **forced** at every edge where the page may stop
  running — session switch, `pagehide` / `visibilitychange → hidden`, and the swap-navigation
  snapshot. A pending timer is not a saved draft.
- **Read:** on session switch, restore that session's draft; skip the restore when the composer
  already holds text the user typed for that identity in the meantime. A draft is never applied to
  a session it does not belong to — the identity comes from the authoritative session record, not
  from a pending or guessed one.
- **Clear:** on confirmed send (C3), on `handleResumeBranch`, and through the same per-session
  cleanup path that removes other session-scoped state on delete/archive. The store is bounded
  (entry count and per-draft length) so a long-lived app cannot grow it without limit.
- **Storage:** use a dedicated DB-backed draft store, not the global `preferencesClient` key-value
  namespace. Its key is a versioned, encoded session identity; each value is text plus update time.
  The API must list and delete by draft namespace so session delete/archive removes its draft. Keep
  an in-memory write-through cache for synchronous rendering. Bound it to documented entry and
  per-draft limits, evicting least-recently-updated entries. `nav-state-cache.js` is the wrong home:
  its payload cap is 3500 chars total, the draft slice is capped at 1500, and it is
  consume-once-by-design for navigation only.
- **Attachments:** unsent image attachments are stashed **in memory** per identity so a session
  switch does not lose them. Persisting image bytes is out of scope.

## C5 — Follow-up 队列发送（整合自 2026-09-13 spec；2026-09-18 修订）

**来源**：原独立 spec `2026-09-13-composer-follow-up-design.md`（Approved 09-13，
未实施），2026-09-18 应 Dr. Lin 要求整合入本 spec 并删除原文件。以下三项明确取代原
决定：按钮-only 改为 Option/Alt+Enter 主入口；快捷键 idle 时由禁用改为降级直发；
`clear_queue` 全部取消改为 blocked，因为当前协议没有该命令。

### 背景——两个队列并存

- **本地队列**（`messageQueue`/`renderQueuedMessages`）：流式中发送 →
  客户端队列，`agent_end` 后 flush 成新 prompt；流式中 Enter 即此路径，逐条可取消。
  协议禁止流式中裸 `prompt`（无 `streamingBehavior`），故此队列存在。行为不变。
- **Pi 队列**（`renderPiQueue`，只读）：pi 进程内的 steering + followUp，
  `queue_update` 事件驱动展示。**协议无 `clear_queue` 命令（2026-09-18 核实
  rpc.md 全命令清单）——GUI 取消能力 blocked，待 upstream 支持**；队列保持只读。

pi 语义（2026-09-13 源码核实）：`follow_up` 仅入队；drain 只在 run 自然停止点
执行；idle 时入队会挂到下一个无关 run 结束才执行（idle trap）；extension
commands 不可入队（`follow_up` 抛错）；skill/prompt 模板命令会展开；`images` 支持。

### 交互

- **快捷键（主入口）**：Option/Alt+Enter → `{type:"follow_up", message, images}`。
  composer keydown 在普通 Enter 分支之前拦截 `altKey`（当前 Option/Alt+Enter
  落入普通发送分支，无冲突）。
  - **idle 降级**：agent idle 时按 Option+Enter 等同 Enter 直发（快捷键无禁用态
    可显示，dead key 不友好；「用户意图是送达」）。
  - **extension command**：`/` 前缀且命令注册表（`get_commands`，composer 菜单
    同源）解析为 extension 源 → 不可入队，走普通 Enter 路径（rpc.md 明文：
    extension command 即使流式中也立即执行）。skill/模板命令允许入队（pi 展开）。
  - 附件随行；无乐观用户气泡、无 `lastSentMessage` 记账——消息经
    `queue_update` → `renderPiQueue` 呈现（label `queue.followUp`，pi 入队即发事件）。
  - 投递完全遵从 C3 的 correlated `runtime_response` 状态机：accepted 才清输入和
    附件；rejected 保留输入；超时转为未确认。不得再使用独立的
    `trackPromptDelivery` 语义。
- **分裂按钮（原 09-13 设计，保留）**：send 按钮分裂控件（新模块
  `public/composer-follow-up-menu.js`，50 行规则），主区行为不变；caret 下拉单项
  「延时发送」→ 同一发送 helper。idle 时菜单项禁用（tooltip 说明）+ click-time
  竞态降级（下拉开着时 run 结束 → 点击降级直发）。按钮禁用态与快捷键降级的
  不对称是刻意的：菜单能显示状态，按键不能。
- **占位提示**：composer placeholder 补 ⌥↩/Alt+Enter 队列提示（新 i18n 键，
  兼作 C1 hint 的落点）。

### i18n

`composer.splitSend.*`（延时发送、idle/extension-command 两个 disabled
tooltip）；placeholder hint 键；四语言。

### 不做

steering 菜单项、`set_follow_up_mode` 暴露、Quick/Side Chat composer、取消按钮
（blocked，见上）。

### 验证

- 快捷键矩阵单测：idle（降级直发）× streaming（follow_up 控制消息形态含 images）
  × extension command（走 prompt 路径）× IME 组合态守卫。
- 分裂按钮：启用/禁用矩阵、click-time 竞态（流式中开菜单 → run 结束 → 点击 →
  直发 prompt 非 follow_up）。
- 投递相关：success 清输入/失败保留；queue_update → renderPiQueue 渲染 label。
- `bun run check`、focused vitest、`bun run test`。

## i18n

New keys in en/zh/ja/es: one for the unconfirmed-send pill (`queue.unconfirmedSend`), and — if the
C1 change ships with a hint — one for the composer placeholder, which currently advertises only
`/` and `@`. Existing `errors.messageNotDelivered`, `errors.commandUndeliverable*`, and `queue.*`
are reused rather than duplicated.

## Addendum A — prompt 模板进 slash 菜单（2026-09-18 grilling 定案）

**背景**：Pi 的 `get_commands` RPC 返回 `commandSources: ["extension", "prompt", "skill"]`，
prompt 模板已在响应中，仅被 `listSkillsViaRuntime`（`public/app.js`）的
`source === "skill"` 过滤器挡掉；发送侧 RPC `prompt` 契约原生展开 `/template`
（rpc.md「Input expansion」节）。本项只补「发现」，不动发送链路。

**决策**：

- 菜单泛化为「命令菜单」，只收**展开型**条目：prompt 模板 + skills。extension
  commands 不进——其语义是执行代码而非展开文本，部分依赖 TUI 交互面，在 Picot
  composer 中行为不可靠。
- 选中行为沿用现有 `select()`：插入 `/name ` 到输入框，参数（`$1`/`$@`）由用户补写，
  发送时 Pi 原生展开。零新机制。
- 呈现：单列表混排；模板用 `file-text` 图标（Lucide v1.33.0，与注册表同步版一致）、
  skill 保持 `box`；scope 标签（Personal/Project）沿用；不加图例。heading 与空态走
  i18n 新命名空间 `slashCommands.listLabel`/`emptyLabel`（四语言，仿 `fileMention.*` 前例）。
- 数据映射：`source:"prompt"` → `{ command: "/"+name, name, description, scope, kind:"prompt" }`；
  skill 条目补 `kind:"skill"`；`location:"project"`→project，其余→personal（沿用现有映射）。
  内部 seam 同步改名：`list_skills` op → `list_slash_commands`（前端私有，无外部引用）。

**不做**：

- `argument-hint` 参数提示——Pi prompt 模板支持该 frontmatter，但当前 Picot 的
  `get_commands` runtime capture 与 fixture 未观察到该字段；本轮不依赖它。升级 Pi 时复验。
- ephemeral/quick chat 菜单——现状本就没有 skill slash 菜单，未点名不扩。
- 模块改名/结构重构（`skill-slash-command.js` 名字暂留）——C1 会移动 slash 解析、
  C2 会删空态与 heading，届时一并收敛，避免同文件两次返工。

**验证**：菜单混合渲染/过滤/选中单测（kind 图标与 data-kind 断言）；`bun run check`；
locale 触碰跑全量 `bun run test`。

## Decisions (resolved 2026-09-18)

**拍板结果：D1/D2/D3/D4 全部取推荐项。**

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | How an unacknowledged send surfaces | A: unconfirmed pill in `#queued-messages` with pull-back · B: error notice only, text dropped · C: auto-resend on the next send | **A.** B loses data (today's behaviour, minus the silent part); C can duplicate a prompt that already reached Pi. |
| D2 | Draft storage | A: DB preferences channel + in-memory map · B: cookie/localStorage only · C: memory only, session lifetime | **A**, following the appearance/terminal precedent. B is capped at 1500 chars by the existing cookie budget; C does not survive a reload, which is half the point. |
| D3 | Slash scope | A: trigger at a token boundary anywhere in the prompt (fixes the mid-sentence defect) · B: keep the whole-input rule | **A.** The current rule is a functional limit, not a design choice: the menu cannot open once anything else is typed. |
| D4 | New trigger constructs (`#` snippets, `!` shell) | A: no · B: add with the router | **A.** Picot has no snippet store to resolve `#`, and the terminal panel already owns shell; the router's precedence list is the extension point if either ever exists. |

## Rollout order and rollback

Addendum A first (approved 2026-09-18). It may land first, but C1/C2 must migrate trigger,
heading, and empty-state behavior in that expanded menu module; separate implementations must not
edit the module in parallel.

C1 + C2 → C3 → C4. C5 is independent of all four and may land in parallel; its send
helper must reuse `trackPromptDelivery` until C3's in-flight record absorbs it.

C1 and C2 are one commit: they are both small, both live in the trigger path, and C1's router is
what makes C2's rule expressible (one place decides whether a picker opens). C3 is independent of
both and can land in parallel, but its in-flight record should carry the same session identity C4
formalises, so C3 is the natural first user of C4's identity helper. Each item is revertible on its
own: C1/C2 revert as one commit in three files, C3 in the send path, C4 as a module plus its call
sites.

## Verification

- **C1** unit tests over `resolveActiveTrigger`: the trigger matrix across caret positions
  (start, mid-prompt after whitespace, inside a word, on a path like `a/b`, inside a quoted
  `@"..."`), precedence when both constructs are present (input `/abc@d` must yield **exactly one**
  trigger — this is the assertion for the two-menus-open hazard), `:` retained for
  `/skill:name`, and the preserved mention semantics (rightmost `@`, quote handling, whitespace
  termination). Behaviour test: Escape/Arrow/Enter reach exactly one picker; with no picker open,
  Enter still sends.
- **C2** unit test: an unresolvable slash query opens nothing; a slow skill load that resolves after
  the query changes or empties does not reopen the menu.
- **C3** behaviour tests: generated requestId 与 `runtime_response` 的相关性；`success:true`
  只在文本未变时清空；`success:false`、`command_undeliverable` 与 transport failure 都按
  empty/append 规则恢复文本和附件；超时转未确认，late response 按其成功/失败分支收敛；
  streaming 路径仍立即清空且只显示一个表示。
- **C4** unit tests over the draft store (bounded, per-identity, cleared on send/resume/delete) and
  a behaviour test for the switch-away-and-back restore, including the "user retyped meanwhile"
  case and the not-yet-materialised identity.
- Manual e2e: type a multi-line prompt with a slash command mid-prompt; switch sessions and return;
  reload with a draft present; send with the network broken (rejection) and with the session
  killed (timeout); Quick/Side Chat composers unaffected.
- `bun run check`, focused vitest, then `bun run test`.

## Out of scope

Any editor upgrade (CodeMirror or a mirror-div highlighter), composer token highlighting,
attachment persistence, worktree/branch intent pickers, response-style injection, the rail and
scroll phases of the chat-window spec, Quick/Side Chat composer parity (verify only that they are
untouched), and any Rust host or Pi protocol change.
