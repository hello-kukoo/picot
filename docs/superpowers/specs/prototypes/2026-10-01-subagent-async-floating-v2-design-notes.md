# 后台任务悬浮面板 v2｜待评审提案

[打开独立原型](./2026-10-01-subagent-async-floating-v2-prototype.html)。顶部「多任务 / 单任务 / 空态 / 切换主题」仅供评审；任务是假数据，todo 是静态占位，消息输入不发送。不修改已实施的 v1 spec；批准后再由架构狮修订正式设计与 Plan。

## 要解决的问题

用户在读消息、写下一条指令时，先知道**当前有几个后台任务、分别由谁执行**；需要时再看每个任务的状态和耗时。面板不再占 composer 的垂直流空间。它与右侧 todo mirror 同时出现，互不覆盖。v1 单根 workflow 把多个子任务合成一行属于**数据投影问题**，架构狮另行核查；本稿只演示上游提供独立任务行后的样子，不主张前端拆 `label` 或遍历 `children` 造任务。

## 版位与避让

- 参照 `public/ui/rpiv-todo-mirror.css`：现有 todo 的 `position:absolute; right:max(var(--space-4), calc((100% - 960px)/2)); bottom:calc(100% + var(--space-2))` 以 `.input-area` 为包含块。建议给两块面板一个由 input-area 定位的**共同悬浮轨道**：`position:absolute; left/right: max(var(--space-4), calc((100% - 960px)/2)); bottom:calc(100% + var(--space-2)); display:grid; grid-template-columns:minmax(0,1fr) minmax(0,420px); gap:var(--space-3); align-items:end; z-index:12`。左放 subagent，右放 todo。正式实现还需核查 todo 既有插入顺序、`belowEditor`、runtime 隐藏及其他浮层层级；不能仅给 subagent 添一个 `left` 而让两个面板竞相覆盖。
- 两面板用 Picot 的 `--bg-frosted`、`--border-hover`、`--radius-md`，复刻 `rpiv-todo-mirror-v3.css` 的半透明磨砂视觉：该文件**明确禁用** `backdrop-filter`，避免消息字透过过低 alpha 玻璃难读。原型不加真正模糊滤镜；浅色 warning/error 用已上线 subagent CSS 的 `#946000` / `#b63f3f` 修正值。独立类名，不复用 `.rpiv-todo-panel`。
- 面板压在可滚动消息之上而非插入消息 DOM；消息滚到底后可在面板后经过。已有 `layout-insets.js` 只测 header/input-area 高度并更新 `--messages-*-inset`、scroll-padding，**不会替悬浮面板留底部空间**。实施时用同一处尺寸测量再计入浮层可见高度（取左右面板最大值），按现有消息区 scrollport / composer 遮挡逻辑核算 `scroll-padding-bottom` 与末尾留白，保证末条消息、焦点目标能滚到浮层上方；收起、展开、todo 改高、窗体尺寸变化都要更新。不要无条件叠加底部 padding 与 margin 两份 inset。原型刻意展示遮挡层次，未模拟产品级滚动避让。

## 收起、展开与数据

- 有任务时默认收起。汇总条显示图标、任务总数和所有**已知** agent 名称；名字不是仅 hover 可见。若数据源另有 `omitted.runs`，总数含该数且写「另 N 个未提供名称」，不虚构名字。完整名单可能换行，优先真实可读，不做只剩头像缩写、名字仅 tooltip 的设计。若窗口过窄，可让名单在有限宽度折行；不能只露「N 个」却藏谁在执行。
- 点「展开详情」原位展开；按钮用原生 `<button>`、`aria-controls`、`aria-expanded`，Tab 可达，Enter/Space 触发，焦点保持。展开区域显示 v1 行级状态、当前工具/工具耗时、轮数/调用次数、**每行自己的任务耗时**。每个上游任务一行，同一 agent 执行两个任务也分两行；无树形缩进、无伪造 task 文本。running / complete / failed、需关注叠加徽标用文案和图形双编码；其它已知状态沿用 v1。`+N` 是超过前四行的已知任务和上游 omitted 根数之和，仍是静态遗漏提示，**展开不代表已取回遗漏任务**。
- 「收起详情」回到汇总；点击面板外**不收起**，用户可滚动消息、选中任务文本并保持上下文。场景切换到真正空态（无行且无遗漏）时隐藏面板并复位收起；只有遗漏数量、无有效行时保留摘要「详情不可用」，避免假空态。切换 runtime 或接到坏帧的清理语义仍由现有 renderer/registry 决定。
- 详情高度用 `grid-template-rows:0fr → 1fr` 一次 180ms 过渡，列表 `max-height:min(19rem,40dvh)` 内滚动；运行图标沿用 v1 2.4s 呼吸。`prefers-reduced-motion` 停止**所有**过渡和呼吸。数据更新不抢焦点，不逐帧 live 播报计时；摘要本身有数量与名单，展开不是获知基本情况的唯一入口。

## 并存与窄窗

宽窗共享 960px 内容轨道，左侧拿余宽、todo 右侧不超过 420px；中等窗右列压至可用宽度约 38%。两列各自内部滚动，不因一侧展开把另一侧顶离基线。小于约 700px 改为单列悬浮堆叠，todo 压成摘要在上、subagent 在下靠 composer；subagent 展开详情上限约 `min(12rem,28dvh)`，避免覆盖整段消息。堆叠 todo 是否允许展开仍归 todo 自身控制，原型只画非交互占位；正式实现须保证 todo 真控件不被强制隐藏。低窗高另压缩详情上限。实际断点、滚动留白和输入法软键盘需实现期用真实窗口测。

## 与 v1 已决定事项的差异（尚未获批）

| v1 | v2 提案 |
| --- | --- |
| `aboveEditor`、composer 上方 in-flow；面板宽 `min(34rem,100%)` | input-area 为锚点，绝对定位在消息区底部；与 todo 共享轨道，左 subagent / 右 todo |
| 只读面板，不含操作按钮 | 仅增**本地详情展开/收起按钮**；任务行仍只读，不加 steer/interrupt |
| 一屏最多四个根，`+N` 静态 | 默认完整数量+已知名单；展开看前四行与 `+N`，不改变上游数据上限 |
| 根 run 一行；workflow 若是一根仍合并 | 目标每个 sub-agent/任务独立行与耗时；依赖上游投影方案经架构狮确认，不在前端按字符串拆分 |
| 空根且无遗漏隐藏 | 保持；只有遗漏数则保留「详情不可用」摘要 |

## 实施验收点

1. 两浮层同时出现时无重叠；一侧消失时另一侧保持正确左右归属；收起/展开和消息滚动到底后，最后一条消息可滚出浮层遮挡。
2. 默认汇总数量与已知名单完整；两个同名 agent 的两个独立任务显示两行、各自耗时；关注徽标不替换主状态；`+N` 与原数据遗漏数一致。
3. 键盘 Tab→Enter/Space 展开/收起，焦点不丢；点击外部不强制关闭；窄窗、长名称、低窗高均不遮住 composer 与 todo 操作。
4. Night/Terracotta 以及产品其余主题从实际 token 继承；降低动态偏好下无动画；读屏不播报每次耗时刷新。产品实现之前，上游多任务投影与 todo 的真实展开尺寸、层级规则需单独核实。
