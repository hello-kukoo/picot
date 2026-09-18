# Subagent 主聊天显示与导航设计

**Status:** 设计定案（2026-09-18 grilling 会话，Dr. Lin 拍板 Q1–Q6），未实现。
**Date:** 2026-09-18
**Provenance:** grilling 会话定案。事实底座来自两轮 codebase-analyzer 分析（主聊天渲染管线 / sidebar 树机制）、pi-subagents 扩展源码核实、upstream 参照 `picot-public-v3.3`（ACP subagent 卡片 `f207db0`，upstream 作者 ShixinGuo 原作，位于 `private/feature-v3.3-new-arch` 分支，从未 merge 进本分支）。

---

## 1. 问题

主代理经 pi-subagents 扩展派发 subagent 后，Picot 有三处缺口：

1. 主聊天难看。tool card 是无差别渲染器：header 只剩 `subagent` 加空预览（`getArgsPreview` 不识别结构化 args），body 是 args 的 JSON dump，输出只取 `result.content[].text`，结构化 `details` 全程被丢弃（live 与 history 都是；`public/ui/tool-card.js`、`public/app.js:3287` `formatToolOutput`）。
2. composer 上方有一条原始 JSON。pi-subagents 持续推 `setWidget("subagent-async", ["PI_SUBAGENT_ASYNC_JSON:{...}"])`，落到 WidgetMirrorRegistry 的 `DefaultTextPanel`（`public/ui/widget-mirror-registry.js:16-40`），显示为一行不可读的前缀 JSON。
3. sidebar 不即时，点击有双写风险。subagent jsonl 无 fs watch，扫描靠手动触发，运行全程通常不可见；点击 subagent 行会 `prepareWorkspaceTarget` 再 spawn 一个 pi 进程加载同一 jsonl，与还在写的原 subagent 进程形成双写。

## 2. 事实底座（已核实到代码）

### 2.1 Pi 侧：pi-subagents 扩展（用户级 npm 包，Picot 不能假设存在）

位置 `~/.pi/agent/npm/node_modules/pi-subagents/`。两种运行模式（`extension/index.ts:219`）：

- foreground（`async:false`）：阻塞执行，`onUpdate` 流式推 `AgentToolResult<Details>`，`tool_execution_update` 的 `partialResult.details` 携带结构化进度。
- background（`async:true`，默认）：tool 立即返回，result `details` 含
  `{id, name, title, task, agent, sessionFile, status:"started", mode:"background", async:true, deliveryState, parentClosePolicy, autoExit}`。child session 的 jsonl 绝对路径在 tool 返回时就已带上。结果以 steer message 回流 parent。

持续状态通道：`setWidget("subagent-async", lines)`，line = `"PI_SUBAGENT_ASYNC_JSON:" + JSON`（`runs/background/async-status-snapshot.ts:275`）。Snapshot 是版本化、带上限的树（`kind:"pi-subagents.async-status-snapshot"`, `version:1`）：

- `runs[]: {id, kind: subagent|workflow|step, label(agent 名), state: queued|running|complete|failed|paused|stopped|rejected, startedAt/updatedAt/endedAt, activity?: {state, currentTool, lastActivityAt, currentToolStartedAt, turnCount, toolCount}, children?[]}`
- caps：20 runs / 每节点 8 children / 深 3 / 字符串 160 / 序列化 32KB；超限记入 `omitted`。

推送时机（`runs/background/async-job-tracker.ts`）：async 目录 fs.watch 加 liveness 轮询（`min(POLL_INTERVAL_MS, 5000ms)`），运行中持续重推。会话恢复时 `restoreActiveJobs` 把 queued/running 的 run 重新推给 UI，所以 Picot 刷新页面后 panel 能自动重建。全部 job 结束时 `setWidget(key, undefined)` 撤掉 widget。

Child session 文件：subagent 的 jsonl 落在 parent 的同一 bucket 目录，首行 `parentSession` 指向 parent.jsonl，`session_info` 行写 `name:"[agent] title"`（如 `[worker] Implement questionnaire renderer`），并追加 marker 行 `{"type":"custom","customType":"pi-subagents_launch_metadata",...}`。

### 2.2 Picot 主聊天现状

- `ToolCardRenderer`（`public/ui/tool-card.js`）对所有工具无差别渲染；唯一特判是 `edit` 的 diff。`MessageRenderer` 不渲染 toolCall/toolResult。
- 事件链：`tool_execution_start/update/end` → `handleToolExecution*`（`public/app.js:3196-3238`）→ `createToolCard/updateToolCard/finalizeToolCard`。`updateToolCard` 只做文本覆盖和状态类切换，没有结构化重建路径。`result.details` 经桥接原样到达前端，但无消费者。
- agent_end 后 `collapseCompletedTurn`（`public/app.js:2886`）把 tool card 折叠进 `Process details · N steps` 组。
- WidgetMirrorRegistry（`public/ui/widget-mirror-registry.js`）：`registerRenderer({widgetKey, toolNames, createPanel, replay?, matchesNotify?})`；panel dock 在 composer form 上/下方（默认 aboveEditor，属 ambient 面板，不在聊天流内）。已注册 renderer 的 panel 不接收 `widgetLines`：widget 只是心跳，状态靠 `handleToolResult`（tool result details）驱动。参考实现：`rpiv-todo`（`public/ui/rpiv-todo-mirror.js`）。

### 2.3 Picot sidebar 现状

- 数据面 `workspace_sessions`（`src-tauri/src/host_data.rs:164-273` 并行扫描 bucket），可见性门槛：至少 1 条 user message、name 已 seal、cwd 匹配 workspace root。`parentSession` 只用于建树（`public/sidebar/session-tree-model.js:49`），child 行渲染 `├─ [worker] title` 缩进。现行契约（ARCHITECTURE.md）：不隐藏、不分类（`hiddenSubagentCount` 恒 0）。
- 没有 fs watch；扫描只在启动、刷新按钮、展开 workspace 行、sidebar 增删改、新主会话落盘时发生。subagent 从 spawn 到跑完，sidebar 通常不知道。
- `provisionalSession`（`public/sidebar/index.js:659`）：单 slot，新主会话落盘前的占位行，扫描发现真文件按 filePath 去重合并。
- subagent 进程是 pi-parent 的孙进程，不在 RuntimeCoordinator 里：`runtime_instances` 看不见它，没有 running/streaming 标记，「找回 runtime」无从谈起。
- 历史决策（Dr. Lin 口述）：平铺看不出层级，先做隐藏；隐藏后无法删除 subagent jsonl，又撤销隐藏改成树形显示（现行状态，`1619c4b`）。

### 2.4 可用数据面（本设计依赖的现成能力，零后端改动或近零）

- `read_session_messages(workspaceId, sessionId)`（`host_data.rs:311`）：纯 host 侧读同 bucket 任意 session 的 active chain 消息，不经 pi 进程。前端 `fetchDiskHistory → renderTranscriptEntries` 渲染管线现成。
- tool `details.sessionFile`（live 与 history 都有）：join key = snapshot run `id` 对上 tool details 的 `id`。
- `pi-subagents_launch_metadata` marker 行：host 扫描时可探测（一行分类），用于区分 subagent child 与 fork/clone child。

### 2.5 双写风险（Q3 的由来）

subagent 运行中，其 jsonl 正被 subagent 进程持续追加。此时任何「spawn 新 pi runtime 打开该文件」的路径（即 sidebar 点击现状）形成两个写者：两个进程各自 append，session 树分叉，Picot 视角与实际进度脱节。subagent 进程不归 Picot 管，无法从进程层面协调。

## 3. 设计总览

四个组件，一条只读导航：

```text
┌─ 主聊天窗口 ──────────────────────────────────────────┐
│  ...聊天流...                                          │
│  ┌ tool card（P2）────────────────┐  ← 单次 dispatch 记录│
│  │ [✓] worker · 实现问卷渲染器     │     + 展开懒加载      │
│  │     child transcript           │     child transcript │
│  │ 打开 session →（P3 只读视图）   │                      │
├───────────────────────────────────────────────────────┤
│  ┌ fleet widget（P1）─────────────┐  ← 实时 fleet 概览   │
│  │ ⠋ worker · ...  ↳ edit · 5 turns│     (ambient,       │
│  │ ✓ scout · ... · 1m02s          │      composer 上方)  │
├───────────────────────────────────────────────────────┤
│  composer                                              │
└───────────────────────────────────────────────────────┘
  sidebar（P4）：provisional subagent 行即时出现在 parent 下方
  导航（P3）：widget 行 / 卡片链接 / sidebar 行 → 一律只读视图
```

数据源分工：widget 吃 fleet snapshot（setWidget 持续推送）；tool card 吃 tool details（含 sessionFile）加懒加载 jsonl transcript；sidebar provisional 吃 tool details。

## 4. P1：fleet widget（`public/ui/subagent-fleet-panel.js`）

向 WidgetMirrorRegistry 注册 `widgetKey:"subagent-async"` 的专用 renderer，替换 DefaultTextPanel 的原始 JSON 显示。

行内容，对齐 Pi TUI fleet status 的密度：

```text
┌─ Subagents ───────────── 2 running · 1 done ─┐
│ ⠋ worker · Implement questionnaire renderer  │
│      ↳ edit public/ui/questionnaire-card.js · 5 turns │
│ ⠋ reviewer · Review extension settings       │
│ ✓ scout · Trace UI event flows · 1m02s       │
└──────────────────────────────────────────────┘
```

- 行 = `[状态图标] agent · title`；running 加第二行小字 `currentTool · N turns`（turnCount）；终态收单行加耗时（endedAt−startedAt）。
- 推送驱动原地刷新，不动聊天流滚动位置。超过约 5 行面板内部滚动。
- 嵌套 children（workflow step）：展开态最多两层，只看状态，不可点（snapshot 没有 sessionFile）。
- 顶层 run 行可点击，进 P3 只读视图。join：snapshot run `id` 对上已见 tool details 的 `id` 和 `sessionFile`；join 不上就只显状态。
- 面板随 `setWidget(key, undefined)` 消失（全部 job 结束），不残留；与 rpiv-todo panel 并存堆叠（registry 既有行为）。

Registry 契约扩展（`widget-mirror-registry.js`，约 10 行）：panel 可实现可选 `applyWidgetLines(lines)`。`handleWidgetRequest` 在 setWidget 到达时，若 panel 实现了该方法，就把去前缀后的 snapshot 交给它（rpiv-todo 不实现，行为不变）。这是本设计唯一的既有模块契约改动。

## 5. P2：tool card 记录卡（`public/ui/subagent-tool-card.js`）

toolName === `"subagent"` 时由该模块接管渲染（`tool-card.js` 留一个分流点）。不建通用 per-tool registry：目前只有 edit/subagent 两个特例，第三个出现再抽象。

- 折叠态：`[状态图标] agent · title`（upstream ACP 卡片标题行形态，`f207db0`），替换现在的空预览和 args JSON dump。
- 展开态：懒加载 `read_session_messages(parentWorkspace, childSessionId)` 渲染 child 的 transcript（工具调用时间线，复用现有 history 渲染器）。运行中的 run 展开时每次重新拉取，文件在追加，刷新可见最新进度。foreground 模式下 `tool_execution_update` 的 `partialResult.details` 可用于流式状态行。
- 卡片尾部「打开 session」链接进 P3。
- agent_end 折叠豁免：subagent 卡不进 `Process details` 组。background 模式下 parent 的 agent_end 到达时 subagent 还在跑，折叠即失联。
- 历史回放同样处理（details 持久化在 jsonl 的 toolResult 里；文件被删则降级为纯记录行）。
- 不需要 upstream 的「Send to Pi」按钮：background subagent 结果自动 steer 回 parent。

## 6. P3：只读视图（`public/ui/subagent-readonly-view.js`）

三个入口一律进只读：widget 顶层 run 行、tool card「打开 session」、sidebar subagent 行（provisional 与扫描行）。

- 渲染：`read_session_messages` 加现有 transcript 渲染管线，零进程。
- 形态：盖在聊天区上的非模态 overlay（复用 dialogs overlay 的先例），横幅显示 `agent · title · 状态（运行中/已结束 · 耗时）` 加返回按钮。不进 URL 状态机，不触碰当前 transcript 的渲染状态，后台 mirror_sync 继续走，被 overlay 遮住而已。
- 运行中：随 widget snapshot 刷新横幅状态；transcript 部分手动刷新，或跟随 snapshot 自动重拉，实现时取简者。
- v1 不做「继续此会话」按钮。理由（Dr. Lin）：自动 spawn 的 subagent 通常不需要继续对话。需要时再加，路径是现有 prepare→spawn，届时已无写者。
- 普通（非 subagent）session 的点击行为不动。

## 7. P4：sidebar provisional 行 + host 分类字段

### 7.1 前端注入（`public/sidebar/index.js`）

- `provisionalSession`（单 slot）之外增加 `provisionalSubagents: Map<runId, session>`：从 `tool_execution` details 注入 `{filePath: sessionFile, parentSession: parentFilePath, name: "[agent] title", running: true}`，现有 `buildSessionTree` 按 `parentSession` 自动挂到 parent 下方。
- 状态更新来自 fleet snapshot（running/终态）；终态后撤销 provisional 行。
- 合并策略：运行中 provisional 行权威，同 filePath 压制扫描行，保住 running 标记与只读路由；终态撤销后由扫描行接管。扫描行未出现前（无手动刷新），行保持 provisional 直到 run 结束后的首次扫描。
- 行点击进 P3 只读视图。

### 7.2 host 分类字段（`host_data.rs`，一行分类）

- `session_summary_value` 增加 `subagent: bool`：扫描时探测文件内 `customType === "pi-subagents_launch_metadata"` 行。
- 用途是路由提示：扫描到的 subagent 行点击走只读。它不是可见性规则，9/17 立的「parentSession 只建树、不隐藏不分类」契约不变（该字段不参与隐藏/过滤，只是行的属性）。
- 必要性：`parentSession` 非空的 child 不全是 subagent，/fork /clone 的主会话分支也有 parentSession，它们必须走正常 session select。
- 不复活 `session_sidebar_visibility` 表和缓存体系（9/17 已拆）。

## 8. 降级矩阵（pi-subagents 不存在 / 变体 / 边界）

| 场景 | 行为 |
| --- | --- |
| pi-subagents 未安装 | 无 setWidget 则无 panel；无 subagent 工具调用则无卡片，零成本 |
| 工具实现无 `details.sessionFile`（如 0.85.1 内置 example 版 `--no-session`） | tool card 退回通用渲染（guard details 形状） |
| snapshot join 不上（嵌套 children / 跨 session 的 run） | 行只显状态，不可点 |
| sessionFile 文件已删 | 记录卡降级纯文本行；只读视图入口隐藏 |
| subagent 属临时会话（Quick/Side Chat parent，文件不在已注册 bucket） | 只读视图报「无法读取」，降级为记录卡 |
| fork/clone child（有 parentSession 但非 subagent） | 走正常 session select，不受影响 |

## 9. 非目标

- 不做「继续此会话」按钮（v1）。
- 不做 host 侧 bucket fs watch（Q4-B 延后；provisional 注入覆盖 subagent 场景，通用「外部新 session 即时可见」另议）。
- 不移植 upstream 的 ACP runtime 机制（`acp_launch.rs`/`acp_manager.rs`，Picot 自有子代理进程是另一个功能），只取其卡片形态。
- 不改普通 session 的选中/复用/跨 workspace 行为（runtime 生命周期分歧另见 `2026-09-18-cross-workspace-runtime-lifecycle-divergence.md`）。
- 不改 9/17 的 sidebar 可见性契约（不隐藏、不分类）。

## 10. 实现清单

| 文件 | 动作 |
| --- | --- |
| `public/ui/subagent-fleet-panel.js` | 新建（P1） |
| `public/ui/subagent-tool-card.js` | 新建（P2） |
| `public/ui/subagent-readonly-view.js` | 新建（P3） |
| `public/ui/widget-mirror-registry.js` | 小改：可选 `applyWidgetLines` 契约（P1） |
| `public/ui/tool-card.js` | 小改：subagent 分流点（P2） |
| `public/sidebar/index.js` | 扩展：`provisionalSubagents` Map 加只读路由（P4） |
| `public/app.js` | 接线：三入口进只读路由；subagent 卡折叠豁免 |
| `src-tauri/src/host_data.rs` | 小改：`subagent` bool 字段（marker 探测，P4.2） |
| `public/locales/*.json` ×4 | 文案：面板标题、状态标签、横幅、返回 |

实现顺序建议：P3（只读视图，导航地基）→ P2（卡片加懒加载）→ P1（widget）→ P4（provisional 加 host 字段）。四个组件接口独立，可分别验收。

## 11. 测试计划

- `subagent-fleet-panel.test.js`：snapshot 解析（前缀/版本/caps/omitted）、行渲染、join、children 不可点、撤除。
- `subagent-tool-card.test.js`：折叠行形态、懒加载触发、文件删除降级、details guard。
- `subagent-readonly-view.test.js`：三入口路由、横幅状态、返回、fork 行不误入。
- sidebar：`provisionalSubagents` Map 生命周期（注入/更新/终态撤销/同 filePath 压制）、`subagent:true` 行只读路由、fork 行正常路由。
- host：marker 探测单测（沿用 `subagent_marker()` 夹具，host_data.rs:1672）。
- 手测 e2e：真实 pi-subagents 跑一轮（foreground 加 background 各一），核对 widget 刷新、卡片懒加载、只读视图、sidebar 即时出现。

## 12. 决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| Q1 | 两层分工：widget 做 fleet 实时概览，tool card 做单次 dispatch 记录（C 案） | snapshot 本就是持续推送的聚合面；details 是单点快照，天然适合做记录；数据源都是现成的 |
| Q2 | widget 行形态对齐 Pi TUI fleet status | 密度合适；currentTool/turns 是判断卡死的最低信息量 |
| Q3 | 三入口一律只读视图；v1 无继续按钮 | subagent 进程在任何版本的 RuntimeCoordinator 里都不存在，spawn 新 runtime 读运行中文件等于双写；「看」是 95% 的意图 |
| Q4 | 前端 provisional 注入（A 案）；不做 host fs watch | details.sessionFile 现成；零后端；B 案是通用基建另议 |
| Q5 | tool card 取 upstream ACP 卡片形态，懒加载 jsonl transcript | 形态已被 upstream 验证；机制上 Picot 无 child 事件流，jsonl 是权威替代 |
| Q6 | 四模块拆分、registry `applyWidgetLines` 契约、marker 布尔分类、降级矩阵 | 模块纪律；最小契约改动；fork 必须与 subagent 区分 |

## 13. 参照与分歧记录

- upstream ACP 卡片（`f207db0`，ShixinGuo，`private/feature-v3.3-new-arch`，未 merge）：形态参照（标题行、工具时间线、展开交互）。机制不可移植：ACP 子进程由 Picot spawn 并拥有事件流，pi-subagents 的孩子是 pi-parent 的孙进程，Picot 只有 details/snapshot/jsonl 三样。
- picot-public-v3.3 的 hide 提交（`04be4f6`，Dr. Lin）：该分支把 pi-subagents session 藏出 sidebar；本分支 9/17 `1619c4b` 立相反契约（树形显示，因隐藏后无法删除 jsonl）。两分支分歧保持，各自正确。
- 跨 workspace runtime 生命周期分歧：见 `2026-09-18-cross-workspace-runtime-lifecycle-divergence.md`（仅记录，本设计不触碰）。
