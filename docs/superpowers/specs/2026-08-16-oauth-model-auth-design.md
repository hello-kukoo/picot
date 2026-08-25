# Picot 模型 OAuth 认证设计

**状态：** 提案（Phase 0 + Phase 1 范围）
**日期：** 2026-08-16
**关联：** `docs/superpowers/plans/2026-08-16-oauth-phase-0-1.md`

## 目标

让 Picot 的 **设置 → 模型** 页面能够使用 Pi 已支持的 provider-owned OAuth 登录，而不让 WebView 读取、持久化、解析或日志化 OAuth token。

第一期目标仅覆盖：

1. **Phase 0 — capability spike：** 在嵌入式 Pi 进程中验证 Pi 0.84 的公开 OAuth login API 是否能驱动 OpenAI Codex provider 的 device-code 流程，并确认 credential persistence 与 catalog refresh 行为。
2. **Phase 1 — OpenAI Codex：** 将已经验证的 device-code 登录流程投影到 Picot Models 页面，支持启动、打开验证地址、复制 device code、等待进度、取消、成功刷新和失败重试。

## 非目标

- 不实现、复制、fork 或反向工程 OpenAI/Anthropic OAuth token exchange、PKCE、refresh 或 callback server。
- 不在 Rust、WebView 或 Picot 独立文件中直接读写 `~/.pi/agent/auth.json`。
- 不在 Phase 1 实现 Anthropic 的 browser callback / redirect URL paste UI。
- 不在 Phase 1 实现通用 `onSelect`、`onPrompt`、browser callback OAuth UI；这些是 Phase 2 的输入。
- 不改 Pi binary pin、Pi 的 `/login` TUI、`models.json` 格式、credential 优先级或 LAN read-only policy。
- 不把 OAuth token、refresh token、authorization code 或完整 redirect URL 写入 console、日志、session JSONL、localStorage、sessionStorage、telemetry 或 DOM attributes。

## 已验证事实

1. Picot 使用内嵌 Pi binary；Rust 不调用用户 `$PATH` 中的 `pi`。每个工作区的嵌入 server 是该 Pi 进程内加载的 extension（`extensions/embedded-server.ts`）。
2. `ModelRegistry` 与其 runtime credential store 属于 Pi process，跨 `new_session` / `switch_session` / `fork` 共享。现有 API-key 设置以 `registry.runtime.credentials.modify/delete` 写入 Pi 的持久 credential store。
3. 当前 `embedded-server.ts` 明确排除 OAuth，提示用户在 terminal 中运行 `pi /login`；这只是 Picot UI 的缺口，不是 Pi 本身不支持 OAuth。
4. 随包 Pi 0.84 文档说明交互式 `/login` 支持 ChatGPT Plus/Pro Codex 与 Claude Pro/Max；Pi 0.77 release notes 明确写明 Codex 支持 headless device-code login。这证明 Pi 的交互式产品能力，**不证明** embedded extension/SDK 存在可编程的宿主侧登录入口。
5. 随包 `custom-provider.md` 与 `extensions.md` 中的 `oauth.login(callbacks)` 是 `pi.registerProvider` 的 provider 实现接口：Pi 宿主把 `onAuth`、`onDeviceCode`、`onProgress`、`onPrompt`、`onSelect` 注入 provider，由 provider 调用。它不是 extension 发起 built-in provider 登录的公开 API。
6. Pi SDK 文档说明 credential mutation 成功后，本地 catalog/composition/availability snapshot 已同步；Picot 仍必须调用现有 `onModelConfigurationChanged()`，使当前 Models 页面、composer 和模型选择器刷新。

### 待 Phase 0 验证的 API 形状

Phase 0 必须在公开的 Pi 0.84 API 中找到一个**宿主侧** seam：它能以目标 provider 发起登录、注入自定义非敏感交互 callbacks，并接受 cancellation。随包 `sdk.md` 已把 `login()`、`logout()`、`setRuntimeApiKey()`、`removeRuntimeApiKey()` 列为公开的 `ModelRuntime` auth 操作（成功后本地 catalog/composition/availability 一致才 resolve，失败抛导出的 `CredentialSynchronizationError`），`getProviders()` + `checkAuth(provider.id)` 可读取 provider 的 auth 方法与状态，且 embedded server 已在通过 `registry.runtime` 触达同一 runtime；真正未被文档证实的只是 `login()` 的交互回调注入形状（无公开签名、随包无 `.d.ts`）。Phase 0 应把 `registry.runtime.login / logout / checkAuth` 列为首要 seam 候选并验证其回调形状；不得以 provider 注册接口、私有字段、反射或动态探测替代它。若找不到该 seam，结果必须是 `unsupported`，不进入 Phase 1。

## 基本原则与安全边界

### Pi 是 OAuth 唯一权威

Pi provider runtime 负责：provider discovery、OAuth URL/device code、token exchange、refresh、token persistence 与 provider catalog composition。

Picot 负责：把 Pi 的**非敏感交互事件**显示给当前 desktop owner，并将用户选择、取消或人工输入（后续 Phase）可靠路由回同一项 Pi login operation。

WebView 不拥有 token，也不需要知道 token 形状。

### desktop-owner-only

所有 OAuth 控制命令均须标为 `desktopOwnerOnly`：

- native owner 的当前 WebView 可以开始/取消登录并接收事件；
- LAN/mobile/remote client、未认证 client 及没有 desktop owner capability 的 client 一律拒绝；
- Quick Chat、Side Chat 等 ephemeral runtime 不得开始 OAuth；
- 同一 Pi process 内的 OAuth operation 必须绑定发起窗口 owner，不能广播到其他窗口。

### operation 生命周期

每个 OAuth operation 使用不可预测、仅在内存存在的 `operationId`，并绑定：

```text
ownerConnection (initiating UnifiedWS) + processGeneration + providerId
```

`ownerId` 不是现有的全局用户身份：它定义为发起 `start_oauth_login` 的那一条 `UnifiedWS` 连接的仅进程内对象身份。operation 保存该连接引用，比较 owner 时比较同一连接，而不接受客户端传入的 owner string。`processGeneration` 是 embedded-server global state 在 Pi process 创建和 extension reload 时递增的仅内存计数；operation 必须匹配当前 generation。连接关闭、Pi process 退出或 generation 改变时，server abort 对应 operation、从 active map 移除并清除 owner 引用，且不向已关闭连接发送事件。

Phase 1 的服务端 operation 状态为（`start_oauth_login` 成功响应直接返回 `starting`，不存在服务端 `idle` 态）：

```text
starting
  → awaiting_device_authorization
  → polling
  → succeeded | failed | cancelled | expired
```

约束：

- 一个 Pi process 同时最多一个 active OAuth operation；若已有 operation，第二次 start 必须返回稳定错误，不覆盖旧 operation。
- 仅拥有该 operation 的 owner 可以 cancel 或读取状态。
- owner 连接关闭、Pi process 退出、embedded extension reload、operation 超时均应 abort operation 并清理内存 state。
- 成功、失败、取消或过期后从 active map 移除。最后状态可短暂保留给当前 owner 以完成 UI 呈现，但不得保存 secret。

## Phase 0：能力验证

Phase 0 不是面向用户的功能，也不是动态私有 API 探测方案。目标是确定 Pi 0.84 中**稳定公开**的 adapter seam。

### 通过条件

在嵌入式 Pi process 内，以 `openai-codex` 为目标 provider，能够：

1. 发现该 provider 及其 OAuth/login capability；
2. 通过已证实的**宿主侧公开 API**启动 device-code login，并将自定义 callbacks 注入该调用；不能把 provider 注册侧 `oauth.login(callbacks)` 误作此入口；
3. 收到 verification URL、user code、`expiresInSeconds`、可选 `intervalSeconds` 与 polling progress（可通过 test seam 采集，不向用户展示）；
4. 将 abort signal 传入并使未完成流程可取消；
5. 在不读取 token 字段的条件下，确认成功后 `getProviderAuthStatus(provider).configured` 改变且 Pi persistence 已处理；
6. 验证 Pi 是否提供公开的 OAuth credential remove/logout 语义；不得假设现有 `remove_api_key` 可删除 OAuth credential；
7. 让成功 path 调用 Picot `onModelConfigurationChanged()` 后刷新当前 catalog；
8. 在 API 不存在、形状不符或 provider 未提供 device-code capability 时，明确报告“不支持当前嵌入 Pi runtime”，不落回 WebView token 实现。

### Phase 0 输出

- 一个由测试覆盖的 `PiOAuthLoginAdapter`，其实现只调用已证实的公开 Pi API；
- 记录精确 Pi package version、导出符号、参数/返回值与 cancellation 语义；
- 一个明确的 capability result：`supported`、`unsupported` 或 `provider-unavailable`；
- 一份更新后的 `ARCHITECTURE.md` OAuth 边界说明。

**Phase 0 结果：`supported`（2026-08-16）。** 探测审计见
`docs/superpowers/audits/2026-08-16-pi-oauth-capability-probe.md`。
已验证的公开 seam：`ModelRuntime.login(providerId, "oauth", interaction)`
（`@earendil-works/pi-coding-agent` 0.84.0，public class 方法）接受调用方注入的
`AuthInteraction`（`signal?: AbortSignal` + `notify(event)`），其中
`AuthEvent.device_code` 携带 `userCode/verificationUri/intervalSeconds?/expiresInSeconds?`，
`AuthEvent.progress` 携带非敏感消息；`checkAuth`/`getProviderAuthStatus`/`logout`
同样公开可用。adapter 与 Picot 均不读取 `Credential` 字段。

如果 Phase 0 得到 `unsupported`，实施停止：产品仅显示“当前嵌入 Pi 版本不支持应用内 OAuth；请在终端启动 `pi` 后使用交互式 `/login`”，不得启动 Phase 1。不得宣称或显示未经 Phase 0 验证的 `pi /login openai-codex` 参数形式。

## Phase 1：OpenAI Codex Device Code UX

### 入口

Models provider 卡片先通过本协议定义的只读 capability command 获取 capability。仅当其返回 `providerId === "openai-codex"`、`deviceCode === true` 且 `configured === false` 时，才显示：

```text
使用 ChatGPT 登录
```

当同一 capability 返回 `configured === true` 时，卡片显示“ChatGPT 已连接”而不是登录按钮。Phase 0 证明公开 OAuth remove/logout 语义后，Phase 1 才显示“断开”操作并调用该语义；若 Phase 0 结果为不支持断开，则 Phase 1 显示已连接态与“请在终端启动 `pi` 后使用交互式 `/login` 管理登录”的说明，不复用或猜测 `remove_api_key`。

普通 OpenAI API-key provider 保留原有 Set key 行为；不得把 API key 与 Codex subscription OAuth 混为同一 credential 类型。

### 登录对话框

启动后显示不可关闭的进度区域与可用 Cancel：

| 状态 | 内容 | 用户可操作 |
| --- | --- | --- |
| starting | “正在准备 ChatGPT 登录…” | Cancel |
| awaiting_device_authorization | verification URL、可复制 user code、"在浏览器完成授权后自动继续"、过期倒计时 | Open browser、Copy code、Cancel |
| polling | 保留 URL/code，显示 Pi 的非敏感进度消息 | Cancel |
| succeeded | “ChatGPT 已连接”，自动关闭并刷新 Models 页面 | Close |
| failed | Provider 返回的已净化错误 + Retry/Close | Retry、Close |
| cancelled / expired | 明确状态，不保留 code | Retry、Close |

`Open browser` 调用既有 native `open_external`，由系统默认浏览器打开 `https` verification URL。Picot 不内嵌 provider login page，也不使用 `window.open`。

### 刷新语义

OAuth adapter 成功时：

```js
await onModelConfigurationChanged?.();
await loadApiKeysPanel();
await loadInlineModelsEditor();
```

前两者分别保持全局模型目录和 Models 页面本地状态一致。失败、取消、过期不得刷新 catalog 或伪称已登录。

### 错误净化

向浏览器发送的失败信息必须：

- 包含可行动的、provider-safe message；
- 不含 Authorization header、access token、refresh token、authorization code、callback query string 或完整 URL query；
- 超长错误截断；
- 被记录为 operation status 的非敏感摘要，而不是原始 Error object。

## 事件与命令协议（Phase 0 后冻结）

下面是 Picot 内部目标协议；Phase 0 负责验证 Pi adapter，Phase 1 才将其接入 WebSocket command table。

### Commands

所有下列命令均为 `desktopOwnerOnly`；能力查询只读，但同样只对 native desktop owner 开放。Phase 1 不扩展现有 `buildModelCatalog` 的 `authType: "api-key"` 字段来猜测 OAuth 能力，而是使用明确、冻结的 capability 表面：

```ts
type OAuthCapabilitiesCommand = {
  type: "get_oauth_login_capabilities";
};

type OAuthLoginCapability = {
  providerId: "openai-codex";
  deviceCode: boolean;
  configured: boolean;
};
```

成功 response 为 `{ success: true, data: { providers: OAuthLoginCapability[] } }`。它仅报告 Phase 0 已验证的 provider/method；找不到公开 adapter seam、provider 不可用或 capability 不支持时，返回空列表或稳定的非敏感错误，不得合成 capability。

```ts
type OAuthStartCommand = {
  type: "start_oauth_login";
  provider: "openai-codex";
  method: "device_code";
};

type OAuthCancelCommand = {
  type: "cancel_oauth_login";
  operationId: string;
};

type OAuthStatusCommand = {
  type: "get_oauth_login_status";
  operationId: string;
};
```

`start_oauth_login` 的成功 response：

```ts
{
  success: true,
  data: { operationId: string, provider: "openai-codex", state: "starting" }
}
```

`cancel_oauth_login` 与 `get_oauth_login_status` 必须验证 caller `UnifiedWS` 对象与 operation 的 `ownerConnection` 相同，并确认 operation 的 `processGeneration` 仍为当前 generation。

### Owner-scoped events 与传输

桌面 WebView 现有的两条命令通道都不满足 owner 绑定：HTTP `/api/rpc` 为每个请求新建一次性 fake WebSocket（响应即丢弃），而 broker WebSocket 上的 `desktopOwnerOnly` 命令被服务端拒绝。因此 OAuth 会话必须使用专用的同源 `/ws` 直连：`models-oauth-login.js` 在启动登录前打开一条 `new WebSocket("/ws")`（桌面 WebView 的 origin 就是实例 server 的 loopback origin，loopback 检查天然通过；裸命令不经 `broker_command` 信封，不受 desktopOwnerOnly 的 broker 拦截），该连接即为 `ownerConnection`，命令下发与事件接收共用同一条连接。连接对象本身就是所有权凭证，无需任何 token。

OAuth 事件绝不使用广播 `/ws` event 路径，也绝不发给 broker。server 必须仅对发起 `start_oauth_login` 的 `ownerConnection` 调用既有 `sendTo(ws, frame)`，帧格式与命令 `{ type: "response", ... }` 并存：

```ts
{ type: "oauth_event", event: OAuthDeviceCodeEvent | OAuthProgressEvent | OAuthTerminalEvent }
```

连接 close handler 必须 abort 该连接拥有的 active operation；不得将 device code、verification URL、progress 或 terminal event 重发给新连接、其他窗口或 broker。

```ts
type OAuthDeviceCodeEvent = {
  type: "oauth_login_device_code";
  operationId: string;
  provider: "openai-codex";
  verificationUri: string;
  userCode: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
};

type OAuthProgressEvent = {
  type: "oauth_login_progress";
  operationId: string;
  message: string;
};

type OAuthTerminalEvent = {
  type:
    | "oauth_login_complete"
    | "oauth_login_failed"
    | "oauth_login_cancelled"
    | "oauth_login_expired";
  operationId: string;
  provider: "openai-codex";
  message?: string;
};
```

`expiresInSeconds` 和 `intervalSeconds` 均为可选、直接来自已验证的 Pi callback（Pi 的 `onDeviceCode` 参数中二者均可省略）：提供时 WebView 以本地倒计时显示剩余时间，不依赖跨进程绝对时钟；省略时隐藏倒计时并仅提示"在浏览器完成授权"。`oauth_login_expired` 是 `expired` 终态的唯一 terminal event，UI 收到后清除 URL/code 并呈现明确的过期状态。

Phase 1 does not implement `oauth_login_auth_url`, `oauth_login_prompt` or `oauth_login_select`; Phase 2 extends this union after Anthropic/browser-flow design is approved.

## Testing strategy

### Unit tests

- Adapter maps a verified Pi device-code callback sequence to events without persisting token data in Picot state.
- Start refuses wrong provider/method, unauthenticated desktop client, remote client and concurrent operation.
- Cancel aborts only the matching `ownerConnection` operation; connection close and process-generation change abort and clear it.
- Success calls `onModelConfigurationChanged()` exactly once; error/cancel/expired do not.
- Expiration emits `oauth_login_expired`; device-code event forwards optional `expiresInSeconds` and optional `intervalSeconds` without converting to an absolute timestamp, and the dialog hides the countdown when `expiresInSeconds` is absent.
- Capability command reports only Phase-0-verified device-code capability and configured status; it never infers OAuth from API-key catalog fields.
- Error sanitizer removes token-like query parameters and truncates raw text.
- Phase 0 verifies documented public OAuth remove/logout semantics before a disconnect UI is implemented.

### UI tests

- Models-page card reveals ChatGPT OAuth action only for returned capability with `configured === false`; configured state shows connected rather than a duplicate login action.
- Device-code dialog renders URL/code, starts its local countdown from `expiresInSeconds`, uses injected `open_external`, supports Copy and Cancel.
- Owner-scoped OAuth event frames are accepted only on the initiating connection; page reload/connection close cannot receive a prior operation's secret-bearing interaction values.
- Completion refreshes model catalog; error/retry remains deterministic.
- Page reload does not expose token or raw provider error in DOM.
- Every new OAuth UI i18n key is added in the same change to `public/locales/en.json`, `public/locales/es.json`, `public/locales/ja.json`, and `public/locales/zh.json`; run the locale-key parity test along with Phase 1 UI tests.

### Manual acceptance

With a ChatGPT Plus/Pro test account:

1. Start OpenAI Codex device-code login from Models.
2. Verify the browser URL and code match Pi-provided values.
3. Complete authorization.
4. Verify Models page reports configured and Codex models are selectable without app restart.
5. Quit/relaunch Picot and verify Pi recognizes the existing OAuth credential.
6. Revoke/cancel during polling and verify no configured state is claimed.

## Phase 2 decision gate

Anthropic starts only after Phase 1 is stable. It will use the same owner-bound operation model but adds `onAuth`, `onPrompt` and potentially `onSelect`. The exact redirect/paste flow is deferred because Phase 1 device-code support has no user-entered authorization-code payload and therefore has a smaller secret-exposure surface.
