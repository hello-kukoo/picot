# Picot corp：钉钉 dws 认证接入设计（dws auth login 的 GUI 化）

**日期：** 2026-10-02
**状态：** 设计稿（交 Picot corp 团队实现）
**证据基线：** dws 仓库 `DingTalk-Real-AI/dingtalk-workspace-cli@7de51a8`（2026-09-23）；Picot 主仓 `picot-v3@eb71ffd` 的 MCP OAuth 登录实现（`src-tauri/src/mcp_login_runner.rs` + `public/settings/mcp-login-dialog.js`）

## 1. 背景与动机

企业员工要在 Picot 的 agent 会话中使用钉钉能力（消息、文档、日历、审批、数字员工等）。钉钉官方路径是 dws CLI（DingTalk Workspace CLI）：agent 经 bash 调 `dws xxx` 命令，技能文档由 `dws skill setup` 安装到各 agent 的技能目录（含 `.pi/agent/skills`）。

全部 dws 命令的门槛是一次性的 `dws auth login`。本设计把它做成 Picot corp 设置页里的一个登录入口——员工在 GUI 里完成一次，全机 dws 命令即可用，agent 无感。

## 2. dws 侧事实（代码级证据，行号基于 7de51a8）

钉钉走的是**「CLI 统一登录态」**路线，与 per-server MCP OAuth（pi 的 `mcp-auth.json` 那类）无关：

| 事实 | 证据 |
| --- | --- |
| 登录命令族：`dws auth login / logout / status`，另有 `auth exchange`（AuthCode 换发） | `internal/app/auth_command.go:91,117,515,558` |
| 登录模式：OAuth loopback（默认，开浏览器）/ `--device` 设备码 / `--token`（PAT，非交互）/ `--client-id --client-secret` | `internal/app/auth_command.go:117-218` |
| 凭据产物：`TokenData{access_token, refresh_token, …}` → AES-256-GCM 加密写 `~/.dws/.data` + OS keychain（服务 `dws-cli`，账户 `auth-token`，多组织 `auth-token:<corpId>`） | `internal/auth/secure_store.go:52,84`；`internal/keychain/keychain.go:27-35` |
| 状态查询：`dws auth status --readonly --format json`——只读本地快照，**不取认证锁、不刷新、不写入**（并发轮询安全） | `README_zh.md:291-295` |
| 钉钉托管 MCP 的鉴权：dws 拿 keychain 的 access_token 作 Bearer 调 `*.dingtalk.com` 网关，**任何 MCP 服务器都不走标准 MCP OAuth 流** | `internal/publishedmcp/client.go:52`；`internal/transport/client.go:62,874-877`；`docs/auth-exchange.md:54-56` |
| 技能安装原生支持 pi：`dws skill setup` 的目标目录表含 `.pi/agent/skills` | `internal/skillpaths/paths.go:57` |

## 3. 非目标（已拍板）

- **不进 MCP 设置页**、不做 MCP 自动发现——钉钉 MCP 经 dws 命令间接触达，pi 的 mcp.json 不出现钉钉条目
- **不直连** `mcp.dingtalk.com`——pi 侧零改动，令牌不进 pi 的 auth.json / mcp-auth.json
- 不在 Picot 内封装 dws 业务命令——那是技能文档（skills）的职责

## 4. 架构

与 codex OAuth 对比定调：codex 走 pi 会话内 `ModelRuntime.login`（pi 认识该 provider）；dws 是**外部 CLI，pi 一无所知**——正确先例是主仓刚落地的 **MCP OAuth 登录**（宿主 spawn 外部二进制、上抛授权 URL、轮询状态、令牌落外部自己的仓）。corp 版复用同一骨架。

```
corp 设置页「钉钉」卡片 ── host op ──> dws_auth_runner (Rust, 新)
                                          ├── dws auth status --readonly --format json   （状态）
                                          ├── dws auth login [--device]                  （登录）
                                          ├── dws auth logout                            （登出）
                                          └── dws skill setup --target pi                （可选一键装技能）
WebView 对话框（复用 mcp-login-dialog 骨架）：URL + 打开浏览器 + 状态轮询 + 取消
凭据：只存在 dws 自己的 ~/.dws/.data + OS keychain —— Picot 永不触碰
```

### 4.1 检测与状态

- 二进制定位：按序探测 `PICOT_DWS_PATH` 环境变量 → PATH 上的 `dws` → 企业托管安装的固定路径（corp 策略配置）。找不到 → 卡片显示「未安装 dws」，登录入口禁用。
- 状态：`dws auth status --readonly --format json` 解析登录态（已登录/未登录/组织名/用户名/过期）。**注意该 JSON 无契约保证**（见 §7 风险 1）——解析须容错：关键字段缺失视为「状态未知」而非报错。
- 多组织（多 profile）：dws keychain 按 `auth-token:<corpId>` 支持多组织；P0 只认当前默认 profile，卡片显示组织名；profile 切换器为 P2。

### 4.2 登录流

- **默认流**：spawn `dws auth login`（无参数）→ dws 自己起 loopback 回调并打开系统默认浏览器 → Picot 从 stdout 解析授权 URL（dws 打印的登录 URL）在对话框中同步展示可点链接（后备）→ 轮询 `auth status --readonly` 至登录态翻转 → 成功。
- **设备码流**（SSH/远程桌面友好）：spawn `dws auth login --device` → 解析 stdout 的设备码 + 验证 URL → 对话框展示（复制按钮 + 打开按钮）→ 同轮询。
- stdin 置 null、stdout 逐行、退出码映射成功/失败——与主仓 `mcp_login_runner.rs` 完全同模式。
- 超时：登录默认 300s（可配）；取消 = kill 子进程组。

### 4.3 登出与技能安装

- 登出：`dws auth logout`，完成后刷新状态。
- 登录成功后卡片提供「安装钉钉技能到 Pi」按钮：`dws skill setup --target pi`（幂等，重装即更新）；完成后提示重启会话可见新技能。

### 4.4 Host op 契约（对齐主仓 `mcp_login_*` 命名风格）

```
dws_auth_status {}              → {ok, installed, authJson?, parseError?}
dws_login_start {mode}          → {ok, operationId} | {ok:false, error}   （mode ∈ browser|device）
dws_login_cancel {operationId}  → {ok, cancelled:true}
dws_login_status {operationId}  → {ok, status, url?, deviceCode?, error?}
dws_logout {}                   → {ok}
dws_install_skills {}           → {ok}
```

操作生命周期沿用主仓 `oauth_manager.rs` 语义：owner-bound（Desktop）+ generation + 上限 + 过期清扫；同一时刻仅一个登录 operation。状态推送事件 `dwsLoginUpdate`（WS 帧），对话框以 1s `dws_login_status` 轮询兜底——与主仓 MCP 登录的事件/轮询双通道一致。

### 4.5 企业 SSO 联动（P2，corp 独有价值）

Picot corp 已有钉钉扫码 SSO（公司统一认证平台）。dws 的 `--token`（PAT）与 `auth exchange`（AuthCode）是**非交互**入口：若 corp 认证平台能在 SSO 会话中换发钉钉 OAuth 令牌或 AuthCode，Picot 可在员工登录 Picot 时静默执行 `dws auth login --token <…>`——员工扫一次码，dws 无感就绪。可行性取决于 IdP 侧能否签发钉钉 OAuth 认的凭据，列为开放问题（§9）。

## 5. 主仓可移植资产（corp 团队按需摘取，基线 eb71ffd）

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 外部二进制 spawn runner（参数构造/URL 行解析/退出码映射/TTL 缓存） | `src-tauri/src/mcp_login_runner.rs` | 直接改名套用 |
| OAuth 操作生命周期（owner+generation+complete API） | `src-tauri/src/oauth_manager.rs` | 复用语义 |
| 登录进度对话框骨架（URL/打开浏览器/轮询/取消，无设备码段） | `public/settings/mcp-login-dialog.js` | 复刻，设备码模式下加 code 展示 |
| WS 事件桥 + transport 类型化 op 模式 | `public/app/websocket-client.js`、`public/app/transport.js` | 照抄接入 |

## 6. 安全边界

1. 令牌只存在于 dws 加密仓与 OS keychain；Picot 全链路只见状态 JSON 与授权 URL，**不读、不存、不转发任何凭据**。
2. `--readonly` 状态查询不触发 dws 的认证锁与刷新，轮询无副作用。
3. 授权 URL 与设备码属非密数据，可进 WebView；与主仓 codex/MCP 登录同一纪律。
4. 二进制定位来自环境变量/PATH/企业策略配置三处，不接受任意路径参数注入。

## 7. 风险

1. **dws 输出无契约**：`auth status --format json` 与登录 stdout 的 URL/设备码行都没有稳定性承诺，dws 升级可能改文案/字段。缓解：解析容错 + 关键行正则宽松化 + 冒烟用例锁行为； corp 构建可钉 dws 版本范围。
2. **keychain 并发**：`auth status` 即使 `--readonly`，keychain 读取仍可能等待 dws 自己的锁（README:292）。缓解：状态查询带超时；登录操作进行中暂停状态轮询。
3. **多组织**：P0 单 profile；员工多组织切换是 P2。
4. **dws 缺失/半装**：二进制在但 keychain 权限被拒（企业策略禁 keychain）——dws 支持 `DWS_DISABLE_KEYCHAIN=1`（README:319），登录路径行为差异需冒烟覆盖。

## 8. 验证计划

- Rust 单测（fake `dws` 脚本，模式抄主仓 mcp_login_runner 测试）：状态解析、三种登录模式的参数与 stdout 解析、退出码映射、并发 start 拒绝、超时与取消。
- 前端 vitest：卡片状态渲染、对话框 browser/device 两流、登出、技能安装按钮。
- 真机冒烟：真实 `dws auth login`（浏览器流 + 设备码流各一遍）→ `auth status` 翻转 → `dws skill setup --target pi` 后 Picot 新会话技能可见 → 登出后状态回落。
- SSO 联动（P2 落地时）：IdP 换发令牌端到端 + 过期续签。

## 9. 开放问题（corp 团队开工前确认）

1. IdP 换发：公司统一认证平台能否签发钉钉 OAuth 认的 PAT 或 AuthCode？（决定 P2 可行性）
2. dws 分发：企业统一推送安装，还是 Picot 内置引导下载？二进制定位策略以哪个为准？
3. corp 设置页现有结构中「钉钉」卡片的落位（与既有 SSO 入口并列还是合并成一个「企业身份」区）。
