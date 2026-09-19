# Enter=Steering、pi 队列取消与 Esc 语义设计

**Status:** Approved — 2026-09-19 grilling 定案（Q1–Q3 全取推荐项）。
**Date:** 2026-09-19
**演化关系:** 取代 `2026-09-16-composer-interaction-design.md` C5 中「本地队列行为不变」
与「GUI 取消能力 blocked（协议无 clear_queue）」两项结论——后者经查证为过时文档所致误判。

## 事实更正（本次核实）

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
- composer-follow-up / app-startup / at-file-mention 焦点测试；全量 `bun run test` + `bun run check`。
- 手动：流式中 Enter 发 steer（「Steer」pill 出现、当前轮转向）；Alt+Enter 发 followUp；
  清空队列按钮回填；Esc 终止 + 队列文本回输入框；idle 无 caret。
