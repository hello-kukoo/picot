# History gate 滚动自动加载

**状态：** Implemented — 2026-09-22（模块 `public/ui/history-gate-auto-reveal.js` + app.js 接线 + 回底按钮显隐；可选项〔按钮弱化样式、fade 过渡〕按 spec 默认未做；长 session 手测待 Dr. Lin 走查）
**日期：** 2026-09-20
**参照：** Paseo `packages/app/src/agent-stream/history-start-pagination.ts`（滚动触发状态机）、
`use-stream-history-window.ts`（本地揭示/远端加载分层）、`view.tsx:1138-1155` +
`bottom-anchor-controller.ts`（回底部按钮与粘底/脱离模式）；Picot 既有 gate
（09-16 chat-window spec P2）与 scroll ownership（同 spec P3）

## 问题

当前 history fold gate 的分页只由按钮触发：`.history-gate-btn`（加载更早）与
`.history-gate-all`（全部加载）。用户滚到顶后必须移动鼠标点按钮，每轮只出
2 个 turn（`HISTORY_REVEAL_BATCH_TURNS = 2`）。

Paseo 的体验是：滚到距历史顶端 96px 内自动加载一页，视口锚定不跳；一页填不满
视口（短内容/compact）时自动续页直到填满或耗尽。

Picot 与 Paseo 的一个关键差别让这件事更简单：Picot 的全量 entries 已在内存
（jsonl 一次读入 + turn 切分），gate 只是「揭示多少」的 DOM 挂载控制——不存在
远端分页层。缺的只是触发器。

对称的另一半体验：用户向上滚动脱离底部后，Paseo 在底部浮出「回到底部」按钮
（chevron），点击平滑滚回并恢复粘底跟随。Picot 的 DOM 里已有
`#scroll-bottom-btn`（内含 `#scroll-bottom-badge` 新消息角标），点击处理完整
（`followBottom()` 平滑滚回 + 重新武装跟随），但**没有任何代码路径移除它的
`hidden` class**——按钮永远不显示；badge 是按钮的子元素且 `.hidden` 是
`display:none !important`，因此 badge 同样实际不可见（潜伏 bug）。

## 已验证事实

| 事实 | 证据 |
| --- | --- |
| gate 结构：初始挂载 `HISTORY_FULL_MOUNT_TURNS = 2` turn，其余折叠 | `public/ui/turn-model.js:6`、`app.js:5864` 注释 |
| 按钮揭示单批 `HISTORY_REVEAL_BATCH_TURNS = 2`；「全部」走 rAF 分批 `HISTORY_GATE_BATCH_TURNS = 10`，`loadToken` 可取消 | `public/ui/turn-model.js:7`、`app.js:6224-6243` |
| 揭示插入已有滚动锚定（`insertTurnFragmentBeforeControl`：记录 scrollHeight/scrollTop，插入后补偿） | `app.js:5895-5901` |
| 搜索渲染挂载全部 turn，gate 在下一次普通渲染重建（`forceReset`） | `app.js:6185, 6247-6250` |
| gate control 生命周期：`gateApplies` 时 append 到 messagesElement，`remaining <= 0` 或非 gate 渲染时移除/置 null | `app.js:6226-6246 updateHistoryGateControl` |
| Paseo 触发阈值 96px、加载中不重复触发、进度键防重、填不满视口续页 | `paseo/.../history-start-pagination.ts`（`HISTORY_START_THRESHOLD_PX = 96`、settle 后续页判断） |
| jsdom 无原生 IntersectionObserver | vitest 环境事实，测试需 stub |
| jsdom 无原生 IntersectionObserver | vitest 环境事实，测试需 stub |
| Picot 已有 `#scroll-bottom-btn`（含 badge 子元素）与完整点击处理：`followBottom()` 平滑滚回并重新武装跟随 | `public/index.html:565-576`、`app.js:661-666`、`scroll-ownership.js` 的 `followBottom`（smooth + token + re-arm） |
| 按钮从未被显示：全仓无 `scrollBottomBtn.classList.remove("hidden")`；`.hidden` 为 `display:none !important`，badge 作为子元素一并不可见 | `app.js` grep 仅命中 click 内的 add；`style.css:59` |
| 现有 scroll 监听已按 150px 阈值计算 `isScrolledUp` 并管理 badge 显隐 | `app.js:2394-2401` |
| Paseo 显示条件：`!isNearBottom` 或 `isTimelineDetached`——脱离底部即显示，与新消息无关；新消息是独立信号（unread）；进出带 fade 动画；点击走 `scrollToBottom("jump-to-bottom")` | `paseo/.../view.tsx:1138-1155` |
| Paseo 粘底语义：用户滚离 ≥24px（`USER_SCROLL_AWAY_DELTA_PX`）脱离；脱离期间新内容不拽回；粘底期间内容增长自动跟随 | `paseo/.../bottom-anchor-controller.ts`（detach/restick 规则） |
| Picot 已有等价粘底模型（scroll ownership P3：程序性/用户滚动区分、跟随重武装规则 5） | `public/session/scroll-ownership.js` 全文 |

## 设计

### 触发器：IntersectionObserver

新增 `public/ui/history-gate-auto-reveal.js` 模块（一个职责：滚动自动揭示）：

1. `observe(gateControl, messagesElement, reveal)`：以 `messagesElement` 为 root、
   `rootMargin: "96px 0px 0px 0px"`（顶端方向）观察 gate control。
2. 进入视口回调 `reveal()`：调用 `mountOlder(HISTORY_REVEAL_BATCH_TURNS)`。
3. **填满视口语义**：插入后若 control 仍连接且仍 intersecting（内容没填满视口），
   `requestAnimationFrame` 续一批，直至不 intersecting、`remaining <= 0`、control
   失连。单条 rAF 链串行，无并发。
4. `disconnect()` 在 `updateHistoryGateControl` 的 `remaining <= 0` 移除分支、以及
   `renderSessionHistory` 的非 gate 分支（`historyGate.control = null` 处）调用。
   observer 实例挂在 `historyGate` 记录上，随 gate 生命周期走。

### 与既有机制的互斥

- `mountAll` 的 `loadToken` 链保留不动；自动揭示共用同一 `historyGate` 记录，
  `forceReset`/control 重建自然取消旧链（control 失连即停）。
- 搜索渲染（`searchRender`）本来不挂 gate control，无观察对象，天然不触发。
- 用户手动点按钮与自动触发走同一 `mountOlder`，无竞争。

### 按钮保留

按钮不删：键盘/读屏可达性、「全部加载」显式入口。视觉弱化（自动触发生效后
按钮降级为次要样式）作为可选项，默认不动样式。

### 常量

`AUTO_REVEAL_THRESHOLD_PX = 96`（对齐 Paseo）与续页批大小复用
`HISTORY_REVEAL_BATCH_TURNS`。集中定义在 turn-model.js 或本模块，留标定空间。
`HISTORY_REVEAL_BATCH_TURNS`。集中定义在 turn-model.js 或本模块，留标定空间。

### 回到底部按钮（scroll-to-bottom control）

补上按钮的显示逻辑，并顺带修复 badge 不可见的潜伏 bug：

1. **显隐驱动**：在既有 scroll 监听（`app.js:2394-2401`，150px 阈值）里同步：
   `isScrolledUp` 为真 → `scrollBottomBtn.classList.remove("hidden")`；回到底部
   → `add("hidden")`（badge 的隐藏逻辑不动，现有行保持）。显示只看位置，不看
   新消息——与 Paseo 的 `!isNearBottom` 一致；新消息仍由 badge 独立表达。
2. **badge 修复**：按钮显示后，`showNewMessageBadge()` 现有的 remove("hidden")
   才真正可见；回底/点击路径的隐藏逻辑已存在，无需改。
3. **点击行为**：零改动。`followBottom()` 已具备 Paseo 的 `jump-to-bottom` 语义
   （平滑滚回 + 重新武装跟随）。
4. **粘底/脱离**：零改动。scroll ownership 已实现 Paseo 的 sticky/detach 等价
   物（程序性滚动不解除跟随、用户滚离解除、控制重武装）。
5. **过渡动画（可选）**：Paseo 用 fade 掩盖 smooth 滚动途中的位置闪变。Picot
   以 CSS `opacity/transform` transition 替代瞬时显隐作为可选项；默认先不做，
   观察闪变是否可感。

边界：gate prepend 的锚定补偿（`insertTurnFragmentBeforeControl`）会写
scrollTop 并触发 scroll 事件，`isScrolledUp` 按新位置重算——若补偿后仍在顶部
附近（atBottom=false），按钮出现，属正确行为。

## 与 upstream 的关系

gate 本身是 v3 09-16 spec P2 引入（upstream 无折叠门）。本 spec 是 v3 内部
交互增强，无 upstream 对齐义务。滚动锚定复用既有实现，不引入新的滚动所有权
（scroll-ownership.js 语义不动）。

## 测试计划

1. vitest + jsdom，stub IntersectionObserver（记录 observe/unobserve 与回调注入）：
   - control 进入视口 → `revealedCount` 增加一个批次。
   - 插入后仍 intersecting → rAF 续批；不 intersecting → 停。
   - `remaining = 0` → disconnect 被调用。
   - gate 重建（切换 session）→ 旧 observer disconnect，新 control 被观察。
   - 搜索渲染路径不注册观察。
2. 手测：长 session（>30 turn）滚到顶自动连续揭示、视口不跳；「全部加载」仍可用；
   切 session 后自动揭示不串台。
   切 session 后自动揭示不串台。
3. 回底按钮：jsdom 断言——滚离底部（scrollTop 置顶）→ 按钮移除 `hidden`；回到
   底部 → 恢复 `hidden`；badge 在按钮显示且 `isScrolledUp` 时
   `showNewMessageBadge` 生效；点击触发 `followBottom` 且按钮与 badge 双隐藏
   （既有行为回归）。
4. 手测：流式输出中向上滚 → 按钮出现、内容不拽回视图；点按钮平滑滚回并恢复
   自动跟随。

## 验收条件

- 滚动到 gate 处自动加载，无需点按钮；锚定不跳（沿用既有补偿）。
- 按钮与「全部加载」行为不变。
- 按钮与「全部加载」行为不变。
- 向上滚动即出现回底部按钮；点击平滑滚回并恢复跟随；新消息 badge 恢复可见。
- `bun run check` + 上述 vitest 全绿。
