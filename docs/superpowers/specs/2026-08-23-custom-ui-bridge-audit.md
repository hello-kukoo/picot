# Custom UI Bridge 审计记录

> 状态：只读审计完成，是否实现尚未决定。
>
> 本文只记录当前代码、upstream 对照结果、风险边界和待讨论问题；不构成实现批准，也不把 `ctx.ui.custom()` 引入当前产品。

## 1. 审计范围

本次审计针对 upstream `93290bd` 中与 Custom UI 相关的能力，重点检查：

- 当前 Picot/embedded Pi 是否已经使用 `ctx.ui.custom()`；
- 当前 `extension_ui_request` / `extension_ui_response` 通道能覆盖哪些交互；
- Custom UI 如果引入，需要如何绑定 owner、workspace、runtime generation 和窗口生命周期；
- 当前 WebView 的 HTML/iframe 安全边界能否直接复用；
- 是否可以直接移植 upstream 的 bridge 或 Native panel。

本次没有修改实现，没有复制 upstream 文件，没有新增依赖，也没有改变现有 `extension_ui` 协议。

## 2. 已验证的当前代码事实

### 2.1 当前确实存在 `ctx.ui.custom()` 使用者

当前仓库中的 `extensions/pi-chat-src` 已经包含真实的 TUI 交互，而不是仅有类型声明或测试占位：

| 文件 | 调用 | 用途 |
| --- | --- | --- |
| `extensions/pi-chat-src/tui/dialogs.ts` | `selectItem()` | 账号/频道选择列表 |
| `extensions/pi-chat-src/tui/dialogs.ts` | `showNotice()` | 信息、警告和错误通知 |
| `extensions/pi-chat-src/tui/dialogs.ts` | `runWithLoader()` | 将异步工作包装成 loader |
| `extensions/pi-chat-src/tui/telegram-setup.ts` | `observeTelegramTarget()` | Telegram 长轮询引导和取消 |
| `extensions/pi-chat-src/tui/chat-config.ts` | 间接调用上述函数 | pi-chat 账号与 DM 配置 |

这些调用依赖 Pi TUI component 的 factory、`done()` 回调、键盘输入和 `dispose()` 生命周期。

### 2.2 RPC mode 当前不会执行 custom factory

嵌入式 Pi 使用 RPC mode。Pi 当前 RPC UI 实现中，`custom()` 是未实现的 stub：

```ts
async custom() {
  // Custom UI not supported in RPC mode
  return undefined as never;
}
```

因此，类似下面这种调用在 RPC mode 中不会执行 factory：

```ts
await ctx.ui.custom((tui, theme, keybindings, done) => {
  // 当前 RPC mode 不会进入这里
});
```

对于等待 `done()` 的扩展逻辑，这会导致返回 `undefined`，或者在扩展自身包装不当时形成永久等待风险。

### 2.3 当前浏览器 UI 只支持结构化 dialog 方法

主 Chat 的入口是：

- `public/app.js::handleExtensionUIRequest()`
- `public/ui/dialogs.js::DialogHandler`

目前支持的 `extension_ui_request.method`：

- `select`
- `confirm`
- `input`
- `editor`
- `notify`
- `setStatus`
- `setWidget`

`DialogHandler` 负责 DOM 生命周期、超时、取消和 `extension_ui_response` 回传。它是一个单当前 dialog 模型，不是任意 TUI component renderer。

Side Chat / Quick Chat 也复用了 scoped `DialogHandler`：

- `public/ephemeral-chat-view.js`
- `public/ephemeral-chat-runtime.js`

临时聊天通过 `respondToExtensionUi()` 走 owner-scoped runtime transport，但当前仍只对应结构化 dialog，不支持任意 custom component。

### 2.4 当前 event transport 已有 extension UI 基础通道

当前已有 `extension_ui_request` 的事件和 response 基础设施：

- Rust broker 可以转发由 Pi RPC stdout 产生的 `extension_ui_request`；
- `src-tauri/src/host_server.rs` 对 Native runtime 的 extension UI request 做 session owner 过滤；
- `src-tauri/src/native_pi_manager.rs` 保存 pending UI request；
- `public/app.js` 和 `public/ephemeral-chat-runtime.js` 接收并响应结构化 UI request；
- `extensions/embedded-server.ts` 的 ephemeral command 处理中已有 `extension_ui_response` case，但该 case 目前只是确认命令，不是完整 custom UI round-trip authority。

因此，Custom UI 可以复用已有 transport 的 owner/runtime 方向，但不能假设当前通道已经具备完整的 custom component 状态机。

## 3. Upstream 对照结果

upstream `93290bd` 引入或调整了：

- `extensions/custom-ui-bridge.ts`
- `public/native/extensions/custom-ui-panel.js`
- Native integration 和相应测试

upstream bridge 的核心做法是：

1. 在 extension 侧替换 RPC mode 的 `ctx.ui.custom()`；
2. 将 Pi TUI component 渲染成 ANSI lines；
3. 通过特殊 `ctx.ui.notify(JSON)` frame 发送给 WebView；
4. Native panel 使用 xterm.js 显示 ANSI frame；
5. 将 xterm 输入通过内部命令送回 extension；
6. extension 调用 component 的 `handleInput()`；
7. 组件调用 `done()` 后发送 close frame 并 resolve 原始 Promise。

upstream 明确将 overlay 默认关闭：

```ts
export const CUSTOM_UI_OVERLAY_ENABLED = false;
```

其原因是 session start 时 custom UI 会出现 TUI overlay flash，而现有 GUI 没有稳定的 hidden-overlay 映射。

### 3.1 不能直接复制 upstream 文件

当前 Picot 与 upstream 的边界不同：

- 当前主架构的 owner、workspace、runtime generation 由 Rust broker/host 管理；
- 当前主 Chat 使用 embedded-server WS 和结构化 `DialogHandler`；
- Side Chat / Quick Chat 使用 ephemeral runtime 的 instance + generation 路由；
- 当前项目禁止把 `public/native/*` 整体迁移到主架构；
- Custom UI 的 response 必须复用当前 owner/runtime authorization，不能创建第二套 authority。

因此 upstream 文件只能作为行为参考，不能作为 file-level cherry-pick 或 wholesale port。

## 4. 当前可复用的安全基础

### 4.1 WebView navigation 和 HTML preview 边界

当前 HTML 文件预览已经使用受限 iframe：

- `public/file-preview-html.js`
- `HTML_IFRAME_SANDBOX = "allow-scripts allow-forms"`
- 不包含 `allow-same-origin`；
- `referrerpolicy="no-referrer"`；
- `srcdoc` 承载内容。

Rust `window_owner.rs` 对 WebView 导航只放行当前 owner 的合法源；对 iframe 相关的 `about:srcdoc` / `about:blank` 有明确例外，其他 `about:`、`data:`、外部 HTTPS、file 和自定义 scheme 仍拒绝。

这套边界可以作为未来 HTML preview 的安全参考，但不等于应该把 HTML/custom DOM 作为 `ctx.ui.custom()` 的第一阶段渲染模型。

### 4.2 Owner 与 runtime 绑定

当前基础设施已有以下身份信息：

- Rust `WindowOwnerRegistry`：owner、window label、canonical workspace、primary port、当前 origin、workspace generation；
- `VerifiedClientContext`：认证后的 client class 和 owner；
- ephemeral runtime：`owner + instanceId + generation`；
- Native runtime：`RuntimeTarget` 和 session owner 记录；
- embedded server：`activeSessionBinding.generation` 和 process/runtime reload 生命周期。

这些字段足以支撑 Custom UI request 的绑定，但当前 `extension_ui_request` 仍需增加或明确其 request identity 和失效语义。

### 4.3 当前 authorization 边界

`extensions/request-access.ts` 主要定义 embedded HTTP API 的 loopback-only 路由，不是一个完整的 UI capability registry。

当前已有的权限原则是：

- LAN/mobile/remote 不应获得 desktop-owner-only 能力；
- ephemeral runtime 不应访问主 workspace 的 host path、settings 或 host-owned state；
- owner、workspace 和 runtime generation 应由 host/broker 派生，不接受浏览器 payload 自报；
- window close、workspace transition、runtime restart 会撤销旧的 owner/runtime state。

如果 Custom UI 只负责渲染和输入，不应获得新的 host I/O 权限。需要文件、网络、settings 或 runtime control 的操作仍必须走现有 command policy 和 authorization。

## 5. 建议的最小安全边界（待讨论，不是实现决定）

以下是进入独立设计时的建议约束。

### 5.1 第一阶段只支持 Pi TUI renderable

建议第一阶段只接受等价于以下能力的 component：

```ts
{
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}
```

第一阶段不允许：

- extension 直接写宿主 DOM；
- 任意 HTML/custom DOM；
- `eval` 或脚本注入；
- iframe custom HTML；
- 从 custom UI 直接调用 host I/O；
- 通过 URL、cookie、localStorage 或 DOM 暴露 capability。

WebView 可以使用已经打包的 xterm 资产显示 ANSI/TUI 输出，但输入仍必须经过 owner/runtime-scoped transport。

### 5.2 默认不可用时必须快速结束

overlay 默认关闭时，不能继续保留“永不调用 factory”的 RPC stub 语义。

需要先定义一种明确结果：

- capability 未启用：立即返回 `undefined` / cancelled；或
- capability 已启用但当前 WebView 不可用：在有界 TTL 后返回 cancelled；或
- 产品明确接受等待：由扩展自行处理，但不建议。

任何方案都必须保证扩展不会永久等待 `done()`。

### 5.3 第一阶段建议单 pending，不支持 nested overlay

建议每个 owner/runtime 只允许一个 active Custom UI request：

- 不支持 nested overlay；
- 不支持后台 UI queue；
- 新 request 到来时取消旧 request，或直接拒绝新 request；
- 后续如果确有需求，再设计 stack 和 foreground arbitration。

原因：当前 `DialogHandler` 是单当前 dialog 模型，单 pending 更容易验证 response 不串线、close 幂等和重启清理。

### 5.4 Request identity 和一次性 response

Custom UI request 应使用 opaque request ID，并至少绑定：

```text
owner
window label
canonical workspace
primary port
workspace generation
runtime/session generation
opaque request ID
createdAt / expiresAt
```

response 必须：

- one-shot consume；
- duplicate response 忽略；
- stale request 忽略；
- 不接受浏览器传入的 owner、cwd、port 或 capability 作为 authority；
- 不将 secret 放进 frame、URL、DOM、日志或持久化数据。

### 5.5 建议的撤销触发器

| 事件 | 建议行为 |
| --- | --- |
| owner revoke / window destroyed | resolve cancelled，移除 panel |
| workspace transition | resolve cancelled，拒绝旧 request 的 response |
| workspace generation 变化 | 旧 request 失效 |
| Pi `session_shutdown` | resolve cancelled |
| runtime restart | resolve cancelled，清除 pending |
| WebSocket disconnect | 第一阶段建议取消，不自动恢复 |
| TTL 到期 | resolve cancelled |
| response consumed | 删除 request |
| duplicate/stale response | 忽略 |

建议 TTL 设上限，例如 30 秒；具体默认值需要产品讨论。

### 5.6 Custom UI 不应自动获得 host I/O

Custom component 的 keyboard input 不应直接成为文件、settings、shell、package 或 runtime 控制权限。

若 component 需要 host 操作：

1. 通过已有 command/API 发起；
2. 使用已有 owner/runtime authorization；
3. 由 host 派生 workspace 和身份；
4. 对路径、scope、generation 和 capability 做现有校验。

不新增“custom UI 可以执行 host I/O”的隐式能力。

## 6. 生命周期状态机草案

以下只用于后续讨论：

```text
idle
  └─ request issued → pending

pending
  ├─ owner/runtime/generation valid + client available → open
  ├─ duplicate/second request → rejected or cancel-old
  ├─ TTL expired → cancelled
  ├─ owner/window/workspace/runtime invalidated → cancelled
  └─ transport unavailable → cancelled or bounded wait

open
  ├─ input → component handleInput → update
  ├─ component done(value) → resolved → consumed
  ├─ ESC / explicit close → cancelled → consumed
  ├─ runtime restart / owner close → cancelled → consumed
  └─ render/handleInput exception → failed → consumed

resolved / cancelled / failed
  └─ all later input/response → ignored
```

必须保证 `done()`、dispose、close、timeout 和 owner cleanup 都是幂等的。

## 7. 目前不建议直接做的事项

以下内容不应作为 G 的顺手实现：

- 直接复制 `extensions/custom-ui-bridge.ts`；
- 直接复制 `public/native/extensions/custom-ui-panel.js`；
- 将主 Chat、Side Chat、Quick Chat 三套 UI 同时接入 custom overlay；
- 引入 HTML/custom DOM renderer；
- 让 LAN/mobile 客户端渲染或控制 Custom UI；
- 让 Custom UI 绕过 `command-policy.ts` 或现有 host authorization；
- 为 Custom UI 创建第二套 owner/source/capability registry；
- 通过 `ctx.ui.notify(JSON)` 偷渡一个未定义的长期协议；
- 在没有 cancellation 语义前让 Telegram 长轮询依赖 custom UI request；
- 在没有真实产品需求前启用默认 overlay。

## 8. 需要单独讨论的问题

以下问题不能仅靠代码审计决定。

### 产品范围

1. 是否真的要支持 `pi-chat` 当前这些 `ctx.ui.custom()` 交互？
2. 是否优先把 pi-chat 的 select/notice/loader 改写为当前已有的结构化 dialog API，而不是引入通用 Custom UI？
3. Custom UI 是否只允许内置 pi-chat 使用，还是允许第三方 package/extension 使用？
4. 如果允许第三方使用，是否需要 manifest capability 或安装时授权？

### 显示位置

1. Custom UI 是否出现在主 Chat？
2. 是否出现在 Side Chat？
3. 是否出现在 Quick Chat？
4. 多个 session/runtime 同时有 request 时，谁可以占用前台？
5. 是否允许 modal overlay？是否允许非模态 panel？

### 取消和长任务

 1. overlay 默认关闭时，`ctx.ui.custom()` 应该立即返回 cancelled，还是等待有界 TTL？
 2. 用户按 ESC、点击 backdrop、关闭窗口时，是否都发送同一种 cancelled 结果？
 3. Telegram `getUpdates` 长轮询在 UI 关闭后是否必须立即 abort？
 4. runtime restart 时，是否允许自动恢复同一个 custom UI，还是一律取消并要求扩展重试？

### 渲染模型

 1. 是否接受 ANSI/xterm 作为第一阶段渲染模型？
 2. 是否需要 mouse/pointer input，还是只支持键盘字节流？
 3. 是否需要 nested overlay / panel stack？
 4. 是否需要自定义尺寸、resize 和 mobile layout？
 5. 是否允许 HTML/custom DOM？如果允许，需要另开 HTML bridge 安全设计，不能混入 TUI bridge。

### 权限与客户端

 1. LAN/mobile/remote 是否一律禁止 Custom UI？建议默认禁止。
 2. Side/Quick Chat 是否必须复用已有 instance + generation 边界？建议必须复用。
 3. Custom UI 是否需要独立 capability？建议先使用现有 desktop-owner authorization，再讨论 manifest-level opt-in；不要新增第二套 authority。
 4. Custom UI component 是否允许触发 host I/O？建议不允许隐式触发，所有操作复用现有 command policy。

## 9. 当前决策状态

当前结论：

- **审计完成；**
- **存在真实调用方和真实缺口；**
- **不建议直接实现或直接移植 upstream；**
- **是否实现 Custom UI 仍待单独产品/架构讨论；**
- **在上述问题明确前，G 保持 implementation deferred；**
- **本审计没有修改代码，也没有改变现有协议。**

下一步应单独决定以下两条路径之一：

### 路径 A：关闭通用 Custom UI

把 `pi-chat` 的必要 TUI 交互逐个改写为当前已有的 `select`、`confirm`、`input`、`editor`、`notify` 和 loader 语义；不增加通用 TUI renderer。

### 路径 B：创建 Custom UI spec 后再实现

先冻结 capability、显示位置、single-pending、TTL、cancel、owner/runtime binding 和 render model，再拆分为协议、extension bridge、前端 panel、runtime cleanup 和安全测试几个独立变更。

本文不替 Dr. Lin 选择路径 A 或路径 B。
