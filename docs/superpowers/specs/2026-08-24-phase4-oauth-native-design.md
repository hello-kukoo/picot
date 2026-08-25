# Phase 4：Codex OAuth — 原生架构适配设计稿

> 状态：**草案，待 Dr. Lin 评审后冻结**。
> 基线：v3 `docs/superpowers/specs/2026-08-16-oauth-model-auth-design.md`（a3515dd，已拷入本仓同路径）。
> 本稿只回答「v3 设计在 v3.3 原生架构如何落地」，不复述基线的 UX 细节；基线中与 loopback HTTP/WS 相关的传输章节由本稿替代。
> 评审修订（2026-08-24，全部经源码核查）：M1 修正 §4 LAN 远端风险理由；M2 补未知 operationId 语义；M3 补双消费者分发规则；N1 补事件信封完整形状；N2 补 CredentialSynchronizationError 透传规则；建议项：4b 增加真运行时冒烟、§5 增加与基线事件命名映射。

## 0. 已验证事实（免 Phase 0 重跑的依据）

| 事实 | 证据 |
| --- | --- |
| Pi 公开 seam：`ModelRuntime.login(providerId, "oauth", interaction)` / `checkAuth` / `logout` / `getProviderAuthStatus`；`AuthInteraction = { signal?, notify(event) }` | v3 Phase 0 探测审计（0.84.0）；目标嵌入 pi **0.84.2 ≥ 0.84.0**（scripts/pi-version.json） |
| bridge 进程内可创建 `ModelRuntime` | 目标 `extensions/picot-config.ts:389/:823` 已有 `ModelRuntime.create()` 先例（generate_session_title） |
| auth.json 写入先例（API-key 路径） | `picot-config.ts` `set_api_key`/`remove_api_key` → `setStoredApiKey`/`removeStoredApiKey` |
| UI 落点已区分 oauth/api-key provider | `public/native/settings/models-page.js:213-221`（authType/source === "oauth" 分支已存在） |
| desktop/remote client 区分 + 会话 owner 概念已存在 | `host_server.rs` `session_owners`、clientType(desktop/remote)、`dialog_owner_unavailable` 守卫 |

结论：**Phase 0 无需重跑**；实现从 Phase 1（UX + 协议接线）开始。若集成测试发现 0.84.2 seam 形状漂移，按基线 Phase 0 通过条件补一次探测并停在此 gate。

## 1. 决策点一：设备码轮询归属 → picot-bridge extension（pi 进程内）

v3 在 embedded-server（pi 进程内 extension）持有 operation 与轮询。目标架构的同位组件就是 **picot-bridge extension**：

- `login()` 的轮询由 Pi runtime 内部执行，bridge 只注入 `AuthInteraction.notify` 回调并把非敏感事件转发给 WebView；
- operation 状态机（starting → awaiting_device_authorization → polling → succeeded/failed/cancelled/expired）保存在 bridge 模块级内存 Map；
- 单 active operation、AbortSignal 取消、连接断开 abort 等生命周期约束照搬基线 §operation 生命周期。

**否决 Rust HostServer 方案的理由**：OAuth seam 在 pi 的 JS SDK 内（`@earendil-works/pi-coding-agent`），Rust 侧只有固定 stdio RPC 命令表（无 oauth），把轮询搬到 Rust 需要自研 device-code 协议客户端并自行处理 token exchange/persistence——直接违反「Pi 是 OAuth 唯一权威」原则。

## 2. 决策点二：token 存储 → Pi 全权持久化，Picot 零接触

沿用基线铁律：**Picot 不拥有 token、不读取 Credential 字段**。

- 登录成功 = `ModelRuntime.login()` 返回，Pi 已写入 `~/.pi/agent/auth.json`（SDK 文档 sdk.md:362/446 确认 OAuth tokens 存于 auth.json，由 ModelRuntime 管理）；
- 成功后仅调用 `registry.refresh()` + 既有的 `onModelConfigurationChanged()` 刷新目录（对齐 v3 刷新语义）；
- capability 查询用 `checkAuth`/`getProviderAuthStatus().configured`，不含任何 secret 形状。

**否决「复用 remove_api_key 删 OAuth」**：基线 Phase 0 明确要求验证独立 logout 语义；sdk.md:481 确认 `logout()` 是公开 API 且处理 catalog 一致性。`logout` 即登出（见决策点三）。

## 3. 决策点三：登出流程 → bridge `oauth_logout` op

移植 v3 95e7e0d 的登出部分：

- bridge 新增 `oauth_logout` op：校验 providerId ∈ {openai-codex} → `runtime.logout(providerId)` → `registry.refresh()` → 返回 `{ ok: true }`；
- 失败时返回稳定非敏感错误；UI 端「ChatGPT 已连接」卡片显示「断开」按钮，确认对话框后调用；
- 不复用 `remove_api_key`（credential 类型不同，且会绕过 Pi 的 catalog 同步语义）。

## 4. 决策点四（M1）：命令白名单 → 不引入新机制

v3 的 `protocol/picot-core-commands.json` 白名单服务于 remote/host 双通道。目标架构：

- **bridge 层白名单 = dispatcher 枚举本身**：`handlePicotConfig` 的 `switch (op)` 就是唯一入口，未列出的 op 落入 default 拒绝。新增 `get_oauth_login_capabilities` / `start_oauth_login` / `cancel_oauth_login` / `get_oauth_login_status` / `oauth_logout` 五个 case 即完成注册；
- **desktopOwnerOnly 等价物**：目标 `/v2/ws` 上 config-gateway 请求必须携带 foreground target（workspaceId/sessionId/instanceId），host_router 已强制 target 校验 + mutation idempotency；remote client 能否触达取决于其是否拥有订阅 target——与既有 dialog owner 模型一致。设计稿裁定：**OAuth 五个 op 在 bridge handler 内额外校验 `clientType === "desktop"` 不可行**（已核：`clientType` 仅存在于 WS hello 层，`host_server.rs:955`；prompt payload 仅 `{id,op,params}`，bridge 确实无从判断）。desktop-only 由**通道层 + 协议层双保险**保证：① 仅桌面窗口装配 OAuth UI 入口；② device flow 本身要求用户在浏览器人为确认——即便配对远端主动发 `start_oauth_login` prompt，也只能得到一个需要桌面用户亲自去浏览器批准的 userCode，token 落在桌面 auth.json，而能完成配对的远端用户本就拥有对等权限。注意：上游 `6e131de`（give paired remote/mobile clients full parity）已使「LAN 远端无法获得入口」不成立，故不得依赖该理由。此点为已知弱化，记录进 ARCHITECTURE.md 边界说明；如需硬校验，后续可在 host_router 为带 `oauth` 前缀的 `/picot-config` prompt 增加 clientType 断言（hello 层信息可用，列为可选加固项，默认不做）。

## 5. 事件流映射：v3 专用 /ws 直连 → config 通道多事件流

v3 用专用裸 WebSocket 做 ownerConnection 并流式下发 `oauth_event` 帧。目标的等价通道是 **config-gateway 的 notify 关联机制**：

```text
WebView                    Rust HostServer            pi (bridge)
   │ /v2/ws runtime_request     │                        │
   │ prompt "/picot-config      │── stdio RPC ──────────▶│ registerCommand
   │  {id,op:start_oauth_login}"│                        │ ModelRuntime.login(...)
   │◀── runtime_event ──────────│◀── ctx.ui.notify ──────│ notify({__picotOauth:id,event})
   │ （多次，流式）               │    （每次一个 JSON）      │ …device_code/progress/terminal
```

- bridge 每次 `ctx.ui.notify(JSON.stringify({ __picotOauth: id, ...event }))`；
- WebView 侧扩展 `consumeNotify` 家族：新增 `consumeOauthEventFrame`（识别 `__picotOauth` 前缀，转发给 OAuth 会话对象，不作为聊天消息渲染）。config-gateway 现有单次 resolve 逻辑不动——OAuth 用独立的 pending Map（`oauth-gateway.js` 新模块），复用同一 transport 往返；
- **owner 绑定语义**：notify 事件经 runtime_event 广播回流到订阅该 foreground target 的连接。同一 workspace+session 通常只有发起窗口订阅；多窗口同 session 时其他窗口也会收到帧——由 WebView 端以「仅当存在活跃 OAuth 会话 id 匹配时消费」收敛（无会话即丢弃，不渲染）。这与 v3 「连接对象即凭证」相比弱化为「target 订阅者可见」，敏感度可接受（帧内只有 userCode/verificationUri/进度消息，无 token；userCode 本就需用户手动输入到浏览器）。（已核：Rust 侧 `extension_ui_requires_owner` 仅对 select/confirm/input/editor 要求 owner，notify 不设门；runtime_event 发给所有订阅该 target 的连接——本稿弱化描述与代码一致。）
- 连接断开 abort：WebView `beforeunload`/adapter disconnect 时 fire `cancel_oauth_login`（best-effort）；bridge 侧同时保留 operation 超时兜底（对齐 expiresInSeconds）。
- **未知 operationId 语义**（对齐基线 processGeneration 防失忆）：bridge 的模块级 Map 在 pi 进程重启/extension reload 后失忆。`get_oauth_login_status`/`cancel_oauth_login` 遇到未知 operationId → 统一按 `{ state: "expired" }` 处理，UI 回到初始态。不做跨进程 operation 恢复。
- **双消费者分发规则**：app.js 的 runtime_event 分发点现为「先问 config 再问 oauth」的互斥路由——`consumeOauthEventFrame` 识别 `__picotOauth` 标记帧并消费（返回 true，后续消费者不得再处理）；其余帧交 `consumeConfigResponseFrame`。任一帧最多被一个消费者吞下，避免误吞。

### 命令/事件形状（与基线冻结协议一致，载体改为 config payload）

```ts
// op: get_oauth_login_capabilities → { providers: [{providerId:"openai-codex", deviceCode, configured}] }
// op: start_oauth_login {provider, method:"device_code"} → { operationId, state:"starting" }
// op: cancel_oauth_login {operationId} → {}
// op: get_oauth_login_status {operationId} → { state, message? }  // 未知 id → { state:"expired" }
// op: oauth_logout {provider} → {}

// 事件信封（ctx.ui.notify 实际载荷；id 即发起请求的 config id）:
{ __picotOauth: id, event: OAuthEvent }
// 其中 OAuthEvent（命名映射：基线 oauth_login_device_code → device_code，余类推）:
type OAuthEvent =
//  | { type: "device_code"; verificationUri: string; userCode: string;
//  |    expiresInSeconds?: number; intervalSeconds?: number }
//  | { type: "progress"; message: string }
//  | { type: "complete" | "failed" | "cancelled" | "expired"; message?: string };
```

错误净化规则照搬基线：无 header/token/query，超长截断，稳定 message。**另**：`login()/logout()` 在凭据已落盘但本地 catalog 同步失败时会以 `CredentialSynchronizationError` reject（sdk.md:481；字段 providerId/operation/credential/cause）——该错误经 op 错误契约透传给 UI，UI **不得自动重试**，须用户显式重发；

## 6. UI 映射

- 落点 `public/native/settings/models-page.js`（P3 已拆分，天然承接 v3 models-page 增量）：
  - provider 卡片经 capabilities op 决定显示「使用 ChatGPT 登录」/「ChatGPT 已连接」+「断开」；
  - 登录对话框状态表、倒计时、Open browser（复用 `open_external` op）、Copy code 全部照搬基线 §登录对话框；
- 新模块 `public/native/settings/models-oauth-login.js`（v3 同名 verbatim 移植 + gateway 调用替换）+ CSS 入 settings 域样式文件；
- 新模块 `public/native/transport/oauth-gateway.js`（pending Map + 事件分发 + 超时）。

## 7. 测试策略

- bridge：oauth operations 单测（fake ModelRuntime：seam 缺失 unsupported、事件序列、取消、双 start 冲突、错误净化）——对应 v3 oauth-login-operations.test.ts + pi-oauth-login-adapter.test.ts；**另加一次真运行时冒烟**：对内嵌 pi 实例调 `get_oauth_login_capabilities`（fake 测不出 0.84.0→0.84.2 的 seam 漂移，真机冒烟比等到 4d 手工验收发现漂移便宜）；
- WebView：models-oauth-login.test.js（状态机 UI）、oauth-gateway.test.js（pending 关联/超时/未知帧丢弃）、models-page.test.js（入口显隐）；
- i18n parity ×4；
- 手动验收：设备码全流程（浏览器授权→token 落盘→catalog 刷新→断开）；确认 LAN remote 无 UI 入口直接触发。

## 8. ARCHITECTURE.md 增量（随实现交付，不等收尾）

- OAuth 边界：bridge 是唯一 OAuth 权威代理；token 只存在于 pi 进程/auth.json；事件帧内容清单（非敏感）；
- owner 绑定的弱化说明与可选加固项（§4）。

## 9. 实施切分

| 步骤 | 内容 | 交付 |
| --- | --- | --- |
| 4a | 本设计稿评审冻结 | 文档 |
| 4b | bridge：operations + adapter + 5 ops + 单测 | extensions/* |
| 4c | WebView：oauth-gateway + models-oauth-login UI + models-page 接线 + i18n | public/native/* |
| 4d | 登出 + ARCHITECTURE.md 增量 + 全量验证 | 收尾 |

单 PR（4b+4c+4d 可内部分 commit），延续「一 phase 一 PR」约定。
