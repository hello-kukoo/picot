# 本地 follow-up 队列设计（follow-up 不再排入 Pi）

日期：2026-09-26 ｜ 状态：Approved（Dr. Lin 定案：send-now=steer 插话；持久化=同窗口重载）

## 背景

Pi 原生队列的三个限制让 follow-up 排队不可控：

1. **协议只有整桶 `clear_queue`**（rpc.md:137-160）。逐条编辑/删除只能"清空+重排"，
   而清空与重排之间 Pi 可能恰好投递某条 steer，重排即丢字。逐条操作无法可靠实现。
2. **abort 后的 drain 依赖 Pi 行为**。且 abort 可能被宿主拒收（缺 turnId），前端却乐观
   解锁 UI，排队消息悬死（2026-09-26 实测：中断后队列不消费、新消息被堵队尾）。
3. **queue_update 只在变更时发**，跨会话回看只能靠内存镜像（piQueuePark）拼回显示。

Paseo 的做法（`packages/app/src/composer/actions.ts`）：队列由客户端自维护，逐条
edit / send-now，失败回队；agent 转入 idle 时 drain 队首一条。本设计移植该模式，
但 follow-up 的"唯一真相"放在 Picot 一侧。

## 目标 / 非目标

### 目标

- Alt+Enter 与「延时发送」^ 钮的入口不变；流式中改入 Picot 本地队列（localStorage，
  按会话文件键），不再向 Pi 发 `follow_up`。
- 队列逐条可控：编辑（取回 composer）、删除、提前发送（运行中 = 作为 steer 插话，
  不中断当前任务；空闲 = 直接发送）。
- 当前任务**确认**结束后按序自动发送，一次一条；判定依据是权威事件，不信任前端
  乐观状态。
- 同窗口重载后队列恢复。

### 非目标

- 跨窗口 / 跨 origin 共享。dev 端口随启动变化即换 origin，localStorage 不共享；
  不做宿主持久化（Dr. Lin 已拍板此范围）。
- 运行中 Enter 立即 steer 的行为不变（仍走 Pi steer，不经本地队列）。
- 后台会话不自动 drain；回切前台且空闲时再 drain。
- Pi steer 队列（`#pi-queue`）与整桶清空按钮保持现状。

## 决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | follow-up 唯一真相在 Picot 本地；Picot 不再向 Pi 发 `follow_up` | 逐条操作需要唯一真相；Pi 端只能整桶操作 |
| D2 | 存储 `localStorage["pi-studio:followup-queue:<sessionFile>"]`，值为 JSON 数组 | 沿用 `pi-studio-*` 命名；同窗口重载即恢复 |
| D3 | 条目 `{ id, text, images?, createdAt }`；单条 text 超过 256 KiB 不入库（仅本窗口内存） | 大粘贴走 offload 惯例；防 localStorage 配额炸裂 |
| D4 | 提前发送：流式中 = `prompt + streamingBehavior:"steer"`；空闲 = 普通直发 | Dr. Lin 定案：插话不中断 |
| D5 | 自动 drain：前台会话收到 `agent_settled`（或权威快照确认空闲）且队列非空 → 发队首一条；该条自己的 run 落定后再发下一条 | `agent_settled` = 无 retry/压缩/排队延续（rpc.md），是"真正结束"的权威信号 |
| D6 | drain 与提前发送都经既有 C3 投递；被拒时条目**回队头**（文本不进 composer），图片在当前会话仍是焦点时回预览；下一次 settled 重试 drain | 文本属于队列而非 composer；按序重试不得插到未离开的条目后面（Dr. Lin 2026-09-26 定案） |
| D7 | 编辑 = 取回 composer 并出队：composer 为空则替换，非空换行追加 | 沿用 clear_queue 回填惯例（Picot 既有行为） |
| D8 | 会话切换：渲染随 sessionFile 换键；回切且空闲时 drain | 队列属于会话，不属于窗口 |
| D9 | Esc / abort 路径不变（Q3-A 废止维持） | abort 被拒导致乐观解锁是另一独立 bug，另案修 |

## 行为矩阵

| 状态 | 动作 | 行为 |
|---|---|---|
| 流式 | Enter | Pi steer（不变，不进本地队列） |
| 空闲 | Enter | 直发（不变） |
| 流式 | Alt+Enter / ^ 钮 | 入本地队列，立即清空 composer，**无 wire 帧** |
| 空闲 | Alt+Enter / ^ 钮 | 直发（不变；`planFollowUpSend` idle → direct） |
| 流式 | 队列条目「提前发送」 | steer 插话；条目出队 |
| 空闲 | 队列条目「提前发送」 | 普通直发；条目出队 |
| 任意 | 队列条目「编辑」 | 文本（含图片）取回 composer，条目出队 |
| 任意 | 队列条目「删除」 | 条目移除 |
| 任意 | Esc | 只 abort（不变） |
| 前台 | `agent_settled` / 权威空闲快照 | drain 队首一条（若非空） |

## UI

- 本地队列渲染在 `#queued-messages` 区域（与 C3 未确认 pill 同区、不同样式类），
  每条三个按钮：编辑 / 删除 / 提前发送。新 i18n 键 `queue.edit` / `queue.delete`
  / `queue.sendNow`（四语言）。
- `#pi-queue`（Pi steer 镜像 + 整桶清空）不动。Pi 端 followUp 桶不再有 Picot 写入；
  若第三方客户端写入，仍只读显示。

## 失败与边界

- localStorage 写失败（配额 / 隐私模式）：条目保留在内存，console.warn 一次；
  不阻塞入队动作本身。
- 入队图片随条目存 data URL；超 D3 上限同样只留内存。
- drain / 提前发送被拒（如"Agent is already processing"）：条目回队头，
  等下一次 settled 重试或用户手动操作；拒因按 run 边界重试，不构成热循环。
- abort 被宿主拒收 → `agent_settled` 不来 → 不 drain（保守正确）。

## 验证计划

- 单元：`public/ui/follow-up-queue.test.js`（存取、逐条编辑/删除、配额降级、
  超限内存降级、键随会话切换）。
- app 级（扩 `public/app-steering-queue.test.js`）：流式 Alt+Enter 不发 wire 帧、
  composer 清空；settled 后 drain 发队首；流式提前发送 = steer；编辑取回；
  删除；重载恢复；拒绝经 C3 回填。
- 手动：中断 + 队列、切会话回切、窗口重载、清空按钮与本地队列互不影响。
- `bun run check` + 全量 `bun run test`。

## 与现有机制的关系

- `piQueuePark`：保留，继续服务 steer pill 的跨会话回显；followUp 桶自然闲置。
- C3（promptDelivery）：drain / 提前发送复用其受理-回执-拒绝回填语义。
- ARCHITECTURE.md 在实现落地时补一节"follow-up 本地队列"。
