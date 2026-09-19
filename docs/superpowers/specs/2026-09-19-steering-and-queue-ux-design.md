# Enter=Steering、pi 队列取消与 Esc 语义设计

**Status:** Implemented — 2026-09-19 grilling 定案（Q1–Q3 全取推荐项）并同日实施。
评审修正：clear_queue 须列入 WebView 侧 `RUNTIME_RPC_COMMANDS` 白名单（host 对
runtime 命令原样透传，此表是唯一闸门），Esc 的 clear 等待有 ~1s 上限。
**Date:** 2026-09-19
**演化关系:** 取代 `2026-09-16-composer-interaction-design.md` 三项结论——C5 的
「本地队列行为不变」「GUI 取消能力 blocked（协议无 clear_queue）」（后者经查证为
过时文档所致误判），以及 C3 的「流式本地队列即时清空例外」（本地队列删除后例外
随之失效，流式 Enter 与 direct 发送走同一 C3 投递记录）。

## 事实更正（实施前核实，行为基线）

- `clear_queue` RPC 自 **0.84.4** 进入上游（CHANGELOG + git tag 证实），内嵌 0.85.1 **支持**：
  全量移除 pi 侧 steering + followUp 队列并返回被清文本；不支持按条删除。
- `prompt` 流式中必须带 `streamingBehavior`：`"steer"` 在当前轮工具调用间隙、下一次 LLM 调用前
  送达（中途转向）；`"followUp"` 等整轮结束。extension commands 流式中**立即执行**（裸 prompt 合法）。
- pi 的 `abort` 语义：队列有剩余消息时**继续排空执行**（"abort continues queued messages"）。
- 现状核实：Picot 的 Enter（流式中）走本地 `messageQueue`，agent_end 后 flush 成新 prompt——
  语义上是客户端手搓的 follow-up；且 Esc 后 `updateUI→flushQueue` 会把队列消息立刻发出
  （「停下又接着跑」，与 pi abort-continues 殊途同归的坑）。

## 决议（grilling Q1–Q3，均取推荐项）

| # | 决策 |
| --- | --- |
| Q1-A | **Enter（流式中）= 真 steering**：`prompt + streamingBehavior:"steer"`；本地 `messageQueue`/`flushQueue`/「Queued」pill 整体删除。无乐观气泡、无 `lastSentMessage`——「Steer」pill 由 `queue_update` 呈现；投递走 C3 状态机（`streamingAtDispatch=true`，rejection 不动 streaming 态）。extension command 流式中走裸 prompt 立即执行（协议明文）。 |
| Q2-A | **pi 队列「清空队列」按钮**：队列区头部显示（有消息时）；点击调 `clear_queue`，返回的 steering+followUp 文本**回填 composer**（空则置入、非空则换行追加，与 C3 恢复规则一致）。pill 保持只读（按条删协议不支持，不做假 ×）。 |
| Q3-A | **Esc = clear_queue → 回填 → abort**：终止前先清 pi 队列（回填规则同上），run 真正终止、不丢字。clear 失败仍照常 abort（降级为 pi 的 continues 语义）。 |

## 按钮可见性（Dr. Lin 提案项，无分叉直接落实）

- idle：caret（延时发送）**隐藏**，仅主发送按钮；Alt+Enter 键盘路径不受影响（idle 降级直发）。
- 流式：红色「终止」+ 其左侧 caret（现 DOM 顺序已满足）。
- tooltip 不变：主按钮「即时发送消息」、caret「延时发送」。

## 不做

- 按条删除 pi 队列消息（协议无此能力）。
- steering/followUp 模式设置（`set_steering_mode`/`set_follow_up_mode`）暴露。
- Quick/Side Chat composer。

## 验证

- `planSteeringSend` 意图矩阵单测（idle→direct、流式+extension→prompt-now、流式→steer）。
- i18n：新增 `queue.clearQueue`（四语言）；`queue.steering`/`queue.followUp` 沿用既有键。
- app 级集成测试 `public/app-steering-queue.test.js`（JSDOM + 假 WebSocket，覆盖下列「手动」项的客户端一半）：
  流式 Enter 发出 `prompt + streamingBehavior:"steer"` 且不渲染乐观气泡；idle Enter 发出无
  `streamingBehavior` 的裸 prompt；流式 + extension command 发裸 prompt；`queue_update` 渲染只读的
  Steer/Follow-up pill；清空按钮**真的发出 `clear_queue`**（P0 回归护栏）且只在确认成功后回填并隐藏，
  失败时保持原状；非空草稿下回填按换行追加；Esc 先 `clear_queue` 后 `abort` 且文本回到输入框；
  caret 仅流式存在；Alt+Enter 流式中发出 `follow_up`（非 steer）且无本地气泡；拒绝 steer 不动
  streaming 态；Esc 后 UI 回到 idle；Esc 发生在 steer **尚在途**时，回填文本不被迟到的
  acceptance 清空（`pullBackTexts` 结算对应投递记录，Q3-A「不丢字」的那条竞态）；会话身份切换后
  上一会话的队列 pill 不残留（含同工作区原地切换这条无刷新路径）；确认清空后的隐藏不是永久的
  （pi 再报队列会重新显示）。
- composer-follow-up / app-startup / at-file-mention 焦点测试；全量 `bun run test` + `bun run check`。
- 真机实测（2026-09-19，内嵌 `src-tauri/resources/pi/pi` **0.85.1**，rpc 模式，
  `--provider google --model gemini-3.1-flash-lite`，`-ne` 隔离用户扩展）：首轮让模型调 bash 执行
  `sleep 8`，在工具执行期间注入消息，观测到的帧与时刻为
  · **steer**：2.5s 入队（`queue_update steering=[…]`）→ 10.2s 工具结束**的同一时刻** steering 清空
    （在工具间隙、下一次 LLM 调用前投递）→ 该轮最终文本为 `STEERED`，原计划的 `DONE` 未出现（真转向）。
  · **followUp**：同样 2.5s 入队但进 `followUp` 桶 → 10.2s 工具结束**不**投递 → 12.6s 本轮 LLM 调用
    结束才清空 → 文本先 `DONE` 后 `FOLLOWED`（等整轮结束，与 steer 形成对照）。
  · **clear_queue + abort**：`clear_queue` 响应 `data.steering` 原样返回队列文本、队列随即清空；随后
    `abort` 终止了正在执行的 bash（`tool_execution_end error=true`）并结束该轮，被清的文本全程未被执行。
  · **extension command**（另一次带用户扩展的重跑，不加 `-ne`）：运行中发
    `{"type":"prompt","message":"/no-sleep"}`（**不带** `streamingBehavior`）→ `success: true`；
    同一轮再发纯文本裸 prompt → `success: false`，error 为
    「Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.」。
    这正是 Q1-A 让 extension command 走裸 prompt、其余走 steer/followUp 的依据。
  · **abort 不清队列会继续排空**（Q3-A 为何必须先 clear）：运行中入队 steer 后**只发 `abort`、不发
    `clear_queue`** → 3.2s `agent_end` 的**同一时刻**又起 `agent_start` 且 steering 清空 → 该轮最终文本为
    `DONE` 加 `ABORT-DRAINED`，即被 abort 的排队消息照样执行了一遍。这是「abort continues queued
    messages」的实证，也正是旧客户端 Esc 之后「停下又接着跑」的坑。
  · **clear_queue 两个桶一起清、各自返回**：先入队 steer 再入队 followUp（`queue_update` 分别显示两个桶）
    → `clear_queue` 响应 `data = {steering:["S-MARK-STEER"], followUp:["Reply with exactly: F-MARK-EXECUTED"]}`
    → 随后 `queue_update` 两桶皆空；被清的 followUp 文案从未出现在任何 assistant 文本中（确未执行）。
  因此本节原先的三个「手动」项均已有等价证据，extension command 走裸 prompt 与 abort/clear 的取舍前提
  也一并实测；GUI 端人眼走查仍可做，但已不是未知项。
