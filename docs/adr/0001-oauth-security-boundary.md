# ADR 0001: OAuth 凭据安全边界（Codex 设备码登录）

- 状态：Accepted
- 日期：2026-08-24
- 关联：`docs/superpowers/specs/2026-08-24-phase4-oauth-native-design.md`（含评审修订 M1–M3/N1–N2）、v3 基线 `docs/superpowers/specs/2026-08-16-oauth-model-auth-design.md`

## 背景

Phase 4 为 Settings → Models 增加应用内 ChatGPT (openai-codex) 设备码登录。v3 通过 embedded-server 的专用 `/ws` 直连实现 owner 绑定；原生架构无 loopback HTTP/WS，传输面重新映射为 `/picot-config` bridge 通道。

## 决策

1. **Pi 是 OAuth 唯一权威**。设备码签发、轮询、token exchange、刷新与持久化全部由 pi 进程内 `ModelRuntime.login/logout` 完成。Picot（WebView / Rust Host / bridge 胶水）不读取、不存储、不转发任何 token 或 Credential 字段。
2. **bridge 是唯一 OAuth 操作代理**。operation 状态机保存在 `extensions/oauth-login-operations.ts` 的进程内内存 Map；单 active operation；AbortSignal 贯穿取消链。
3. **事件帧内容白名单**：跨进程流向 WebView 的只有非敏感载荷——`verificationUri`、`userCode`、可选 `expiresInSeconds/intervalSeconds`、进度消息、终态名。错误消息经双向净化（bridge `sanitizeOAuthError` + dialog `sanitizeDialogMessage`）：剥离 Authorization/Bearer 头、token/key 键值对与 URL query，超长截断，空内容回退固定文案。
4. **desktopOwnerOnly 的等价保证（已知弱化）**：
   - 桌面窗口独占 OAuth UI 入口；
   - device flow 本身要求用户在浏览器人为批准——即便配对远端（上游 `6e131de` 后具备完全 parity）主动发起 `start_oauth_login`，得到的 userCode 仍需桌面侧用户亲自在浏览器完成授权，token 落在桌面 `auth.json`；
   - 多窗口同 target 时事件帧对订阅者可见，由 WebView 端「无活跃会话即丢弃」收敛；帧内容不含 secret，故可接受。
   - 可选加固（默认不做）：host_router 对含 oauth op 的 `/picot-config` prompt 增加 hello 层 clientType 断言。
5. **失忆语义（M2）**：bridge 内存 Map 在 pi 重启/extension reload 后清空；未知 operationId 的 status/cancel 统一按 `expired` 处理，UI 回初始态。不做跨进程恢复。
6. **同步失败透传（N2）**：`CredentialSynchronizationError` 以稳定 message 抵达 UI，禁止自动重试。

## 后果

- WebView/Rust 代码库中不存在 token 处理路径，攻击面收敛于 bridge 单文件。
- 远端配对客户端可触发登录流程但无法绕过浏览器人工授权步骤；该弱化已记录并有可选加固路径。
- ARCHITECTURE.md 尚未在本仓建立；本 ADR 即 Phase 4 的边界文档落点，后续若建根 ARCHITECTURE.md 应引用本 ADR。
