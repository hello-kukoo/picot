# 后台任务状态面板｜设计说明

[原型：浏览器直接打开](./2026-09-30-subagent-async-widget-renderer-prototype.html)。顶部「多任务 / 单任务 / 空态 / 切换主题」仅是评审开关，不进入 Picot。假数据没有 API 连接，消息输入不发送。

## 任务与位置

在输入框上方扫一眼并行任务：谁在做、谁完成、谁失败、谁需要注意。沿用 `aboveEditor` 槽位，面板贴输入框右侧，不侵入聊天记录；`runs=[]` 且无省略时整块移除，不留空白占位；`runs=[]` 且 `omitted.runs>0` 时保留面板，显示「N 个后台任务 · 详情不可用」摘要行，不把不可见任务误报为空。原型空态开关仅演示前一种情况，后一种交给正式 renderer 实现。既有 `.input-area`、`.composer-card`、`rpiv-todo-panel` 提供位置和密度参照。Tauri WebView 原生 JS；原型仅复刻 Night / Terracotta 两套 Picot token，正式 renderer 应直接继承 `style-theme.css` 六套主题。

## 布局与视觉

- 宽度 `min(34rem, 100%)`，四行以内显著展示；高度上限 `min(19rem, 44dvh)`，窄屏占满输入区，内容过长内部滚动。`--space-2/3` 间距、`--radius-md` 圆角、`--border-hover` 边框、`--bg-frosted` 底色，延续 todo mirror v3 的不透字面板。
- 标题「后台任务」与统计同一行，统计由根 `runs` 计算。任务首行：状态图标、agent `label`、中文主状态，必要时旁边叠加「⚠ 需关注」徽标；次行：当前工具和耗时、轮数、工具次数或终态耗时；缺字段直接省略，不展示假零值。不做树形：`children` 不渲染（Dr. Lin 拍板，嵌套子代对用户和主 agent 无价值），仅扁平根列表；children 完全不参与 `+N` 计数。
- 最多展示前四个根；`+N = 未展示的根 run 数 + omitted.runs`，有遗漏时显示 `+N 个后台任务` 静态计数，不可展开；`omitted.children` 同样忽略。`activity.state === "needs_attention"` 只叠加徽标，不替换 `state` 对应的主状态；例如仍显示「运行中」及其运行图标。running 用主题 `--accent-text`，complete 用 `--success`，failed 用 `--error`，关注徽标用 `--warning`，queued 用 `--text-secondary`；partial / paused / stopped / rejected 保留独立文案，不误报为完成。徽标有图标和文字，不只靠颜色。
- 字号沿用 `--font-size-sm`（标题、状态、统计、次行），agent 主文本约 `--font-size-md`。正式实现宜保留 rem / 可缩放字体映射，别锁定固定行高或裁掉状态文字。

## 动态与可达性

运行图标 2.4 秒轻微明暗呼吸；耗时随收到的快照计算并静态显示，下次快照才刷新，原型切换场景即模拟新快照，不设每秒计时器。v1 实现为每帧重建行 DOM（上限 4 行、`aria-live="off"`、无焦点交互，churn 有界）；稳定行 DOM 列为后续优化项，待实测帧率或读屏反馈再引入。`prefers-reduced-motion` 停止呼吸。变化不自动抢焦点、不对耗时变化做 live 播报；建议只在主状态或需关注徽标发生转换时发一次简短 `role=status` 更新，同一状态不重复播报，避免读屏器刷屏。工具名与耗时始终可见、可选中复制，hover 仅轻微底色，无隐藏信息和点击暗示。行不是按钮；评审场景按钮支持 Tab、Enter、Space 和可见焦点。长名称省略但正式实现应提供完整可读名称（如文本 `title` 或屏幕阅读器可读全文）。浅色主题的警告/错误字色需检验实际对比度；原型中的这两项色值仅供演示，正式实现应走主题语义 token。

## 给实现者

建议 `.subagent-async-panel` / `__header` / `__summary` / `__list` / `__job` / `__detail` BEM 类名，主状态走 `data-state`，关注徽标独立呈现。注册 renderer 而非修改默认 JSON 面板；只消费 `pi-subagents.async-status-snapshot` v1 的根 `runs` 与根级 `omitted.runs`，节点读取 `id/kind/label/state/startedAt/updatedAt/endedAt/activity`，工具耗时读 `activity.currentToolStartedAt`；`activity.state` 仅识别 `active_long_running | needs_attention`，缺省表示正常活跃，不能写入不存在的 `active`。`children` 不读取、不渲染、不计数。避免对 widget 原始字符串拼接 HTML。仅 `runs=[]` 且无省略时移除面板；若 `omitted.runs>0`，改显详情不可用摘要。运行时切换沿用 registry 隐藏机制。原型的模拟数组、场景控制条、假聊天不可进产品。

## 未来扩展点

`task` 预览、`tokens`、`progress`、错误详情目前 snapshot 不提供，待上游扩展后再定布局。`steer` / `interrupt` 等写操作不在首版；若后续加入，须单独明确可执行条件、反馈和误触恢复。
