# datarx-safety-guard-pi 设置页与富对话框设计

## 状态

v1，2026-09-21。grilling 会话（Dr. Lin，Q1–Q9）逐项拍板。
**Implemented 2026-09-21；spec tracks code**（扩展侧 payload 增加
operation-global 的 `warning: true` 标志；通用对话框滚动修复为整卡
max-height + overflow-y，按钮固定由富卡片承担）。

## 背景

`datarx-safety-guard-pi`（git 源，自家 fork of @firstpick/pi-extension-safety-guard）
已装、上游版同时装着，两者读写**同一** `~/.pi/agent/safety-guard.json`（同
`PI_SAFETY_GUARD_CONFIG_FILE`）。bash 审批提示在 TUI 是可滚动 SelectList；
GUI 回退 `ctx.ui.select(长文本)` → Picot 通用对话框被撑爆（不可滚、按钮出屏）。

## 决议

| # | 决策点 | 决议 |
| --- | --- | --- |
| 1 | 包共存 | **卸载 firstpick 版**，只留 datarx fork；共享文件问题随之消失 |
| 2 | 设置页 | 复用现有 `safetyGuard.config.*` bridge ops 与 renderer，第二个 source gate 指向 fork |
| 3 | 对话框数据契约 | **改扩展**：非 TUI 模式 `ctx.ui.select` 的 message = 人类可读标题行 + `{"__safetyGuardBash":1,"version":1,"sections":[…],"command":"…","choices":[…]}`；Picot 检测标记渲染富卡片，解析失败剥标记回退通用对话框 |
| 4 | 布局 | 命令等宽代码块（横向滚动）+ 各 section 卡片；**上下文摘录默认折叠**；底部固定操作按钮（Block 第一 + 默认焦点），各放行按钮带 scope hint（lifetime 语义） |
| 5 | thinkingLevel | datarx 设置页暴露 `autoReview.model.thinkingLevel` select（off…max） |
| 6 | 响应机制不动 | options 原样传 select；Picot 按钮 → 现有 `extension_ui_response`（`{value: label}`）；取消/Esc → `{cancelled: true}` = Block（与 TUI 取消语义一致，index.ts:685） |
| 7 | firstpick 善后 | 删 firstpick renderer gate，保留 ops（共享基础设施）；firstpick spec 加 Uninstalled 注记 |

## 契约细节

- payload sections 复用 `BashPromptSection {label, body, warning?}`（纯文本，
  `formatPromptCommand` 的 highlight 默认恒等——`>>> <<<` 是文本标记非 ANSI）；
  choices 从 `Map<label, {scope, lifetime?}>` 序列化为保序数组（Block 第一）。
- Picot 富对话框组件 `public/ui/safety-guard-dialog.js`：
  `handleExtensionUIRequest(request)` 检测 `method==="select"` + message 含
  标记 → 解析 → 渲染卡片并应答；解析失败返回 false 走通用对话框。
  接线点：主聊天 `app.js`（questionnaireCard 之后、switch 之前）；侧聊
  `ephemeral-chat-view.js` 的 select 渲染分支同样先过拦截。
- 通用对话框顺手修滚动（max-height + overflow + 按钮固定），下一个发长
  select 的扩展不再撑爆。

## 验证

- 扩展：payload 单测（sections/choices 序列化、无 ANSI）；
- Picot：拦截单测（标记检测、解析失败回退、按钮应答 value、Esc→cancelled）；
  设置页 gate 单测（datarx source 命中、thinkingLevel 写入）；
- `bun run check`、`bun run test`；手动 e2e：rm 触发审批 → 富卡片 → 各按钮
  → allow/block 语义与 TUI 一致。
