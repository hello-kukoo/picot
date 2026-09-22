<!-- ABOUTME: Picot 右侧 Info panel 的产品与实现约束。 -->
<!-- ABOUTME: 定义原生 Pi session tree 导航、消息 Fork/Edit 与 workspace action 复用。 -->

# Info Panel 设计

## 状态

设计方案。2026-08-21 与 Dr. Lin 讨论确认。

配套视觉原型：[`2026-08-21-info-panel-prototype.html`](2026-08-21-info-panel-prototype.html)。

## 目标

在 Picot 右侧栏新增 **Info** panel。它有两个互不影响的区域：

1. **Workspace**：固定显示的工作区基本操作。
2. **Session history**：可独立纵向滚动、以 GUI 呈现当前 session 的原生 Pi `/tree`。

Info 用于看清 branch 和当前 active branch；主聊天不承担树形展示。

## 非目标与硬边界

Picot **不重新实现 Pi 的 `/tree`、`/fork`、branch 持久化、session 复制或 branch
切换逻辑**。

- Pi 是 session JSONL、`id`/`parentId` 树、active leaf、branch 切换、`/fork` 与
  session 创建的唯一权威来源。
- GUI 通过既有 embedded-server/RPC 通道调用 Pi 原生能力，再渲染 Pi 返回的权威状态。
- GUI 不得自行写 session JSONL、复制会话 entry、按 timestamp 推断 branch，或维护与 Pi
  竞争的 branch 模型。
- “用 GUI 实现 `/tree`”仅指可视化 Pi 的树，并为其既有状态转换提供图形入口；并非复制其实现。

## 布局

```text
Info
────────────────────────────
Workspace                    ← 固定；history 滚动时始终可见
/path/to/current/workspace
▣ Copy path
[VS Code icon] Open in VS Code
[Zed icon]     Open in Zed
[Terminal icon] Open in Terminal
────────────────────────────
Session history              ← 只有此区域纵向滚动
  current session 的原生 tree
```

### 尺寸与滚动

- Info panel 是垂直 flex container，必须设置 `min-height: 0`。
- panel header 和 Workspace 区域为 `flex: 0 0 auto`。
- Session history 为 `flex: 1 1 auto; min-height: 0; overflow-y: auto`。
- 很长的 tree 不得把 Workspace 操作滚出可视区。
- workspace path 单行省略；悬浮提示或等价无障碍机制显示完整路径。

## Workspace 操作

Info 增加主工具条已有操作的入口：

- Copy path
- Open in VS Code
- Open in Zed
- Open in Terminal

每个操作为独立单行链接，不使用按钮外观。每行带图标：应用使用主工具条 app 下拉菜单
的同一图标资源；Copy path 使用复制图标。

### 不变量：同一 action source

Info 必须复用主工具条同一个 action source/controller，而非重复实现：

- IDE 可用性检测；
- 平台相关 terminal / app 启动命令；
- clipboard 处理；
- 成功与错误反馈；
- disabled state 规则；
- app icon 资源与 fallback monogram。

同一 action 实现、两个渲染位置，防止平台逻辑和启动行为漂移。

## Session 数据模型

Pi session 是 JSONL tree。Pi 拥有 entry 的 `id`、`parentId` 和 current active leaf；树形结构
不是 UI 自创数据。

```text
User: JWT or Cookie?
└─ Assistant: JWT recommendation
   ├─ User: Implement JWT
   │  └─ Assistant: JWT result
   │     └─ User: Add expiry tests
   │        └─ Assistant: done                 ← active leaf
   └─ User: Implement Cookie instead
      └─ Assistant: Cookie result
         └─ User: Add CSRF protection
            └─ Assistant: done                 ← inactive branch leaf
```

### Session history 显示范围

严格只渲染 Pi 原生 message entry 中 role 为以下两类的节点：

- `user`
- `assistant`

不渲染 tool call、tool result、thinking、model change、compaction、branch summary、custom
entry、label 或其他 bookkeeping 节点。

Assistant 节点规则：

- 每个 turn 只显示最终 assistant answer 的文本预览。Pi 可能为一个 turn 持久化多个 assistant
  entry；中间 assistant entry 即使含文本，也属于过程详情，必须隐藏。
- `stopReason` 为 `error` 或 `aborted`：即使无文本，也显示紧凑状态节点，保留失败历史。
- 仅含 tool activity、无文本、非 error/aborted：隐藏。
- 被隐藏的非 message entry 不能破坏逻辑树的 parent/child 连接。渲染时基于 Pi 的完整原生
  tree 计算可见节点 connector，仅在视觉层跳过隐藏节点。

### 节点预览

- User：第一条非空文本行，超长省略。
- Assistant：第一条非空文本行，超长省略。
- 不生成摘要；不调用 LLM；不维护摘要缓存。
- 用 role icon 与颜色区分 user / assistant；预览不是完整 transcript。

## Active branch 与主聊天

### active leaf 是权威状态

UI 必须分清两个概念：

- **active leaf**：Pi 当前 branch 的权威末端。它决定 LLM context，以及普通下一条消息
  接到哪里。
- **scroll target**：主聊天当前临时滚动位置。它不得改变 context、active leaf、composer
  内容或 branch。

不得混淆二者。

### 主聊天规则

主聊天只渲染一条线性 transcript：从 root 到当前 active leaf 的 ancestor path。

Session history 默认也以扁平时间线显示 active path；没有 sibling branch 时，user/assistant 不缩进、
不绘制树线。只有实际存在的 inactive sibling branch 才使用 branch summary、灰色节点和视觉缩进。

不得在主聊天 inline 显示 sibling branch。否则同一逻辑位置会出现多个替代消息，既破坏线性阅读，
也会错误暗示 LLM context 包含全部分支。Session history 是唯一树形可视化。

### Active / inactive tree 状态

| Tree 内容 | 默认展开 | 视觉 | 主要点击行为 |
| --- | --- | --- | --- |
| Active path | 展开 | 正常对比度；current leaf 明确选中 | 滚动主聊天到精确消息 |
| Shared ancestor | 展开 | 正常对比度 | 滚动主聊天 |
| Inactive branch | 在 fork point 折叠 | 灰色 / 低对比 | 不进行消息导航 |
| 已展开 inactive branch | 用户手动展开 | 保持灰色 / 低对比 | 不进行消息导航；leaf 可 Resume |

Inactive 节点没有 click-to-scroll：它们不存在于当前 transcript。不得提供看似可导航、实际无效果
的控件。

### Inactive branch 展开

- 在分叉点显示折叠的 inactive branch 摘要；可用时包含 turn count。
- 用户可展开查看预览。
- 展开的节点仍为 inactive 外观，也仍不可定位主聊天。
- 只有 terminal leaf 显示 `Resume branch`；hover 时快捷显示，同时在 overflow/menu 内提供
  keyboard/touch 可发现入口。

### Resume branch

`Resume branch` 是显式 branch switch，不是 scroll navigation。

1. GUI 请求 Pi 用其原生 session tree 能力选择该 inactive **leaf**。
2. Pi 成为新 active leaf 的权威来源；Pi 自身需要的 branch summary 流程必须保留。
3. 主聊天从 root / time 0 到该 leaf **全量重绘**。
4. Session history 重算 active path：新 active 节点恢复正常对比并展开；原 active
   descendants 变灰、成为 inactive。
5. composer 清空。
6. 后续普通 user message 从此 leaf 延续该 branch。

只有 branch leaf 有 `Resume branch`。中间节点不能隐式代表“从这里新开 branch”，避免目标歧义。

## Session history 点击

- 点击 active path 的 user 或 assistant 节点：滚动主聊天到对应已渲染消息；允许短暂 focus flash。
- 点击不改变 active leaf 或 composer，即使目标是早期 active 消息。
- inactive 节点无点击动作；唯一 branch-changing affordance 是 inactive leaf 的显式
  `Resume branch`。
- Session history 必须高亮 current active leaf；它不是主聊天当前 scroll location。

## User message toolbar 操作

消息 toolbar 操作只出现在 user message。Assistant message 在本设计中不出现 Fork 或 Branch
操作。

既有 toolbar 的 future-action contract 见
[`2026-08-10-message-toolbar-design.md`](2026-08-10-message-toolbar-design.md)。新增操作必须遵守
该 contract：真实 button、明确 accessible label、可 keyboard focus，及 user toolbar 的可见性规则。
本设计同时**取代**该文档的 user slot 顺序（原为 `time`、`copy`、future actions 追加在后）；
`2026-08-10` 文档已同步标注。

### 顺序与 Long Prompt 展开

User message toolbar 的视觉顺序固定为：

```text
Expand / Collapse → Fork session → Edit → Copy → Timestamp
```

- `Expand / Collapse` 是既有 long user prompt 阅读控制，**不重新实现、不改变折叠规则**；
  现状为 ≥400 字符或 ≥8 换行即默认折叠（`USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD` /
  `USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD`）。本设计只约束其按钮位置。
- 仅被折叠的 long prompt 显示 `Expand / Collapse`。短 prompt 不保留空 slot。
- `Fork session` 与 `Edit` 始终紧跟 Expand/Collapse；阅读状态切换不得改变它们之间的相对顺序。
- `Copy` 是辅助动作；`Timestamp` 是静态 metadata，始终最后。
- toolbar 的显示/隐藏不得改变消息正文布局；尤其不得因 Expand/Collapse 导致 Fork 或 Edit 误触。

### Fork session

**User toolbar：`Fork session`**。

这是 Pi 原生 `/fork` 的 GUI 入口，不是自定义复制操作。

1. 用户在历史或当前 user message 触发 Fork。
2. GUI 要求 Pi 对该 user message 执行原生 fork 行为。
3. Pi 创建新 session file，复制原生历史至该 user prompt。
4. 左侧栏收到并显示新 session 条目，同时选中新条目。
5. 主聊天切换到新 session 的 transcript。
6. composer 预填所选 user message 文本，等待用户编辑；不得自动发送。

结果：原 session/tree 不改变；新 session 独立。

### Edit and branch

**User toolbar：`Edit`**。

这是 Pi 原生 `/tree` 中选择 user message 的 GUI 等价入口；只有用户编辑并发送后才创建 branch。

1. 用户在指定 user message 触发 Edit。
2. GUI 调用与 Pi `/tree` 选择该 user entry 相同的原生行为：Pi 将 leaf 移到所选 user 的 parent，
   并将原 prompt 填入 composer。
3. 用户编辑并提交。
4. Pi 从此 parent 正常追加提交后的 user message，以其原生 `parentId` 逻辑创建同 session 的
   sibling branch。
5. 新 assistant reply 和后续消息只存在于新 branch。

Edit 不得只复制 prompt 后调用通用“append to current leaf”命令；若目标是历史消息，结果会挂到错误
branch。

### Context 后果

原 branch：

```text
User: JWT or Cookie?
└─ Assistant: JWT recommendation
   └─ User: Implement JWT
      └─ Assistant: JWT result
         └─ User: Add expiry tests
```

将 `User: Implement JWT` Edit 为 `Implement Cookie` 后，新 Cookie user 与原 JWT user 同 parent。
Cookie 的 context 只包含到 JWT recommendation 的共用 ancestor，加上 Cookie branch 的消息。
JWT result 和 expiry-test turn 不进入 Cookie context，也不会迁移到 Cookie branch。

## 主聊天 Conversation Navigator

现有主聊天 Conversation Navigator（conversation turn tick rail）从主聊天右侧移到左侧。它仍只在
当前 active branch 的线性 transcript 中导航；不承担 Session history 的 branch 浏览或切换。

### 位置与 tooltip

- Rail 位于 main chat 左边缘，与左侧 session sidebar 相邻，但属于 main chat，不得覆盖或挤压
  sidebar。
- 为消息正文保留足够左 inset，rail 不得遮挡 assistant 或 user message 文本、toolbar、focus ring。
- 现有右侧 rail 的 tooltip 向左弹出；移到左侧后，tooltip 必须向右弹出。
- 同步反转 tooltip 的 animation / transform origin，以及 hidden rail 的水平进入/离开方向。
- 窄窗口阈值需要随新左右布局重新验证；空间不足时继续隐藏 rail，不能造成 main chat 或 sidebar
  重叠。

### Hover 与 active 状态

- 默认 rail 保持轻量 tick 外观。
- 鼠标进入 **整个 rail hit area** 时，rail 容器显示带背景、圆角的矩形高亮；可带 subtle border 或
  shadow，作为整体 hover affordance。
- 该 hover surface 覆盖 rail 容器，不为每一个 tick 单独创建背景。
- active tick 保持 accent/highlight，优先级高于容器 hover background；两种状态必须组合而非互相覆盖。
- 保留可见 keyboard focus；hover 效果不能是唯一可发现性来源。

## 无障碍与交互

- 每个仅图标控件必须有明确 `aria-label`。
- Tree row 要向 assistive technology 传达 role、preview、active/inactive 状态与 current leaf 状态。
- Inactive row 应语义上不可操作，不能做成可 focus 的假 button。`Resume branch` 仍须可 keyboard
  到达。
- 保留 tree row、action link、toolbar action 和 navigator tick 的可见 focus style。
- Hover-only Resume 必须有 menu/keyboard/touch 替代入口。

## Backend/API 集成要求

实现前先检查 Pi embedded runtime API 与 Picot 既有 session/switch transport。只新增调用原生 Pi
操作所需的薄命令，并返回刷新后的权威状态。

Pi 必须提供、且 Pi 拥有的能力：

- 取得 current session 的完整原生 tree 和 active leaf；
- 选择 / switch 到既有 tree leaf；
- 选择 user message，进入原生 edit-and-resubmit 流程；
- 从指定 user message fork；
- 发送 / 返回 session update，让 sidebar、transcript、tree、composer 一致刷新。

前端不得从 tree 排序推导 active leaf，也不得保留失效的 native session state 副本。

## 原型验收标准

`2026-08-21-info-panel-prototype.html` 展示：

- 固定 Workspace 区域；
- 每项一行、带对应图标的 Workspace action link；
- Session history 独立纵向滚动；
- 展开的 active path；
- 灰色、折叠且可展开的 inactive branch；
- inactive branch leaf 的显式 Resume branch affordance；
- active 节点滚动 mock 主聊天；
- 不虚假宣称 inactive 节点能定位到 current transcript。

原型仅验证视觉与交互意图，不代表 Pi 集成已完成。

## 实现验证

完成实现后：

1. 验证 workspace action 调用主工具条的同一 shared controller，图标也复用同一资源/fallback。
2. 用真实 Pi session 建立至少两个 sibling branch；验证主聊天仅包含 active path，Info tree 包含两者。
3. 逐个点击 active user/assistant 节点；验证只 scroll，不改变 leaf/composer。
4. 展开 inactive branch；验证节点保持灰色且不可导航。
5. Resume inactive leaf；验证 Pi active leaf 改变、transcript 从 root 全量重绘到新 leaf、composer 清空、
   tree 状态互换。
6. Edit 历史 user message，修改并提交；验证 Pi 建立正确 parent 的 sibling branch，旧 branch descendants
   不进入新 context。
7. Fork 历史 user message；验证 Pi 创建并切换到新 session、sidebar 更新、原生复制历史止于所选 prompt、
   composer 预填且未发送。
8. 验证 user toolbar 的 `Expand/Collapse → Fork → Edit → Copy → Timestamp` 顺序；短 prompt 没有
   Expand/Collapse 空 slot；long prompt 展开/收起不改变其余 action 的相对顺序。
9. 验证 role filter、pure-tool assistant 隐藏、error/aborted assistant 可见、长 tree 滚动、keyboard focus
   与 touch 替代入口。
10. 验证 navigator 位于主聊天左侧、tooltip 向右、hover 时 whole rail 显示圆角背景，active tick 保持
    accent，且窄窗口不与 sidebar 或消息正文重叠。
11. 运行相关 focused tests、`bun run check`；若改动 session transport/persistence，运行 `bun run test`。
