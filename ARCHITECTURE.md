# Picot 架构（Native Runtime 迁移后）

> 本文档描述 native runtime 迁移完成后的架构。
> 迁移历史与决策记录见 `docs/superpowers/specs/2026-08-27-native-runtime-migration-design.md`。

## 一句话概览

Picot 是一个 Tauri 桌面应用，为每个工作区派生一个 headless `pi` 进程（`--mode rpc`），通过 Rust 宿主进程（HostServer）管理生命周期、授权和数据面，前端 WebView 经 v2 WebSocket 协议与运行时通信。

## 进程模型

```text
┌─────────────────────────────────────────────────┐
│  Tauri App (Rust)                               │
│  ┌───────────┐  ┌─────────────────────────────┐ │
│  │  WebView  │  │  HostServer (axum, loopback)│ │
│  │  (index)  │◄─┤  /v2/ws  /v2/bootstrap      │ │
│  │           │  │  /workspaces/:wid/:sid      │ │
│  └───────────┘  │  /api/* (compat, owner-aware)│ │
│                 └──────────┬──────────────────┘ │
│                            │ stdin/stdout RPC   │
│                 ┌──────────▼──────────────────┐ │
│                 │  pi --mode rpc               │ │
│                 │  --extension picot-bridge.mjs│ │
│                 │  (per workspace)             │ │
│                 └─────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 三个进程角色

1. **Tauri 主进程（Rust）**：窗口管理、系统对话框、terminal、窗口 owner 注册。每个注册工作区派生一个 native pi 进程。
2. **HostServer（Rust, axum）**：loopback-only HTTP/WS 服务器。管理 runtime 生命周期（`NativePiManager`）、操作注册表（`OperationRegistry`）、授权（`WindowOwnerRegistry` capability）、数据面（`HostDataPlane` workspace containment）。
3. **pi 子进程（Bun standalone）**：headless `--mode rpc`，加载 `picot-bridge.mjs` 扩展与 pi core API 通信。

## 启动流程（native runtime）

```rust
// main.rs: setup_native_runtime
fn native_runtime_enabled(app) -> bool {
    cfg!(debug_assertions) && env::var("PICOT_RUNTIME").is_ok_and(|v| v == "native")
}
```

1. 检查 `PICOT_RUNTIME=native`（debug 构建限定）
2. 解析注册工作区根目录（`MetadataStore` / `WindowOwnerRegistry`）
3. 创建 `NativePiManager` + `HostServer`（loopback:0 绑定）
4. 通过 `pi_launch::native_launch_spec_for` 组装启动输入（binary/args/env/extensions）
5. `manager.spawn(target, spec)` 派生 pi 进程
6. WebView 加载 `origin/workspaces/:wid/sessions/:sid` 进入 existing shell

## 网络路径

| 路径 | 协议 | 授权 | 用途 |
| --- | --- | --- | --- |
| `/v2/ws` | WebSocket v2 | desktop capability（hello 握手） | 前端 ↔ 运行时通信 |
| `/v2/bootstrap` | HTTP GET | desktop capability（header） | 获取 RuntimeTarget |
| `/workspaces/:wid/:sid` | HTTP GET | 路由参数校验 + bootstrap 鉴权 | existing shell 入口 |
| `/api/*` | HTTP GET/POST | desktop capability（`x-picot-desktop-capability` header） | 兼容路由（owner-aware） |
| `/health` | HTTP GET | 无 | 宿主存活探针 |
| `/v2/session-export/:token` | HTTP GET | 一次性令牌（owner + generation 绑定） | 会话导出流 |
| `/v2/paste-offload` | HTTP POST | desktop capability | ≥4 MiB paste 卸载 |
| `/v2/auth/exchange` | HTTP POST | 配对令牌（5 分钟 TTL，一次性） | pairing token → device token |
| `/v2/mobile/status` | HTTP GET | device token（Bearer） | 配对设备只读状态（v1 仅 liveness） |
| `/pair.html` | HTTP GET | 无（pairing 前唯一 surface） | 手机配对页 |

### 兼容路由的唯一实现规则

`/api/*` 兼容条目是**冻结集合**：只允许继续服务已在 host 内实现的路由，不再新增 handler。
需要新能力时一律接 v2 面（`data_request` 数据 op 或 `broker_control` 控制 op），由
`host_router` 的 `current_registered_context` 做代数复核；在 HTTP 侧另写一份 handler 会
造成两份契约（已发生过的错位见 `docs/superpowers/specs/2026-08-30-p8-deletion-proof-audit.md`）。

已被 native 取代或 scope 移除的入口保留显式失败，避免静默 fallback：

| 状态 | 条目 | 响应 |
| --- | --- | --- |
| 退役（D8） | `/api/rpc` | `410 Gone` + `Deprecation: true` + 匿名 client-class 计数 |
| 已有 v2 等价 op | `/api/files/content` `/api/files/raw` `/api/file-mentions` `/api/paste-offload` `/api/open` `/api/git-branch` | `410 Gone`（`api_gone`）；前端改走 `file_read`/`file_raw`/`file_mentions`/`/v2/paste-offload`/`open_in_app` |
| scope 移除（P5/P6） | `/api/models-config` `/api/agent-config` `/api/agents-md` `/api/append-system-md` `/api/chat-config` `/api/chat-telegram/{op}` `/api/skill-install-{links,scan}` `/api/super-agent/{projects,tasks}` `/api/lan-qr` | `410 Gone`（`api_gone`） |

删除前置条件不变：D10 Stage 2+ 遥测需显示这些条目在两个稳定 release 周期内零命中。

**LAN 边界**：HostServer 默认仅绑定 `127.0.0.1`（loopback-only）。用户在 设置 → Mobile Access 显式开启后（`mobile.lanAccessEnabled`，重启生效），host 绑定 `0.0.0.0`，移动端经 `/pair.html` 用桌面铸造的配对令牌换 device token；配对后 v1 仅开放只读状态，读写面仍为 desktop capability 专属（Gate B 远程矩阵未实现前不开放）。

## 授权模型

### 窗口 Owner 注册

```text
WindowOwnerRegistry
  ├── create_owner_with_workspace(label, root, origin, wid) → (OwnerId, capability)
  ├── authenticate(capability) → Option<OwnerId>
  ├── owner_current_workspace(owner) → OwnerWorkspaceSnapshot
  │     Registered { wid, root, generation }
  │     Temporary { kind }
  │     NoWorkspace
  └── validate_workspace_transition_generation(owner, gen)
```

- **capability** 是 32 字节 URL-safe 随机值，仅发放给 desktop 窗口
- **generation** 是单调递增的工作区代数——workspace transition 递增，旧代 runtime/操作/令牌全部失效
- 远程设备经 `/v2/auth/exchange` 配对获得 device token（非 capability）

### 数据面 containment

`HostDataPlane` 强制所有文件操作限制在注册工作区根目录内：

- `safe_join(root, relative_path)` — canonicalize + symlink 检查
- `strip_prefix` 包含性（分隔符安全，兄弟前缀拒绝）
- atomic write + mtime conflict 检测

## 运行时生命周期

```text
spawn → Starting → Ready → Working ↔ Idle → Stopped
                ↘ Crashed（EOF/child-exit/writer-fail/frame-fatal）
                ↘ Suspended（resume → Starting with new generation）
```

### 操作注册表（OperationRegistry）

- 逻辑 scope `(owner, workspace, session, generation)`
- 幂等键去重：`accepted_pending` / `duplicate_pending` / `duplicate_completed`
- crash/restart → Pending → Indeterminate（不可重放）
- turn-bound abort：事件泵绑定 `turnId → operationId`（RPC response 不携带 turnId）

## 模块清单

| 模块 | 职责 |
| --- | --- |
| `host_server.rs` | axum 服务器、路由、v2 WS 协议、兼容路由 |
| `host_router.rs` | v2 hello 握手、客户端注册、帧路由 |
| `host_data.rs` | 数据面（list/read/write/containment/cost/export 令牌） |
| `host_files.rs` | 文件读写安全（symlink/TOCTOU/atomic/0600） |
| `host_config.rs` | 设置/agent 文本文件（proper-lockfile） |
| `host_capability.rs` | capability 存储（mint/validate/revoke） |
| `native_pi_manager.rs` | 运行时生命周期管理、操作注册表集成 |
| `runtime_coordinator.rs` | 运行时状态机、turn 绑定、事件序列 |
| `operation_registry.rs` | 幂等操作注册表（scope/TTL/eviction/revoke） |
| `oauth_manager.rs` | OAuth 操作生命周期（generation 绑定） |
| `paste_offload.rs` | paste 临时文件（TTL/quota/symlink/.gitignore） |
| `transport_limits.rs` | 帧/响应/事件/快照/进度大小限制 |
| `cost_compat.rs` | cost-dashboard payload parity |
| `metadata_store.rs` | SQLite 工作区注册 + preferences；schema 兼容契约：接受 user_version ≤ 6（Corp v4–v6 表归 Corp 构建，public 只读不建），public 迁移只完成 v1–v3 并只盖 v3 戳 |
| `window_owner.rs` | 窗口 owner 注册与 capability |
| `remote_auth.rs` | 远程设备配对与 device token |
| `ephemeral_registry.rs` | Side/Quick chat 生命周期 |
| `git_service.rs` | owner-scoped Git status, diff, history, and commit operations |

| `pi_launch.rs` | 启动契约共享基底（binary/args/env/extensions） |
| `telemetry.rs` | D10 匿名遥测 schema（Stage 0 接线） |
| `process_tree.rs` | 进程树管理（Unix pgid / Windows Job Object） |

## 兼容路由（P8 删除候选）

`/api/*` compatibility routes maintain existing shell behavior on host origin. Each route uses owner capability authorization. Runtime traffic must use `/v2/*` and `/v2/ws`; retained HTTP routes are explicit compatibility or retirement responses, never Pi-origin forwarding.

## 静态资源

构建产物按内容指纹版本化：`/v/<fingerprint>/...`，`Cache-Control: no-store` 防止 auto-update 后 WebView 缓存旧 release。

## 安全边界

1. **Loopback-only**：HostServer 拒绝非 loopback 绑定
2. **Owner capability**：每个桌面窗口持唯一 32 字节随机 capability
3. **Workspace containment**：所有文件操作限制在注册根目录内
4. **Generation 失效**：workspace transition 使旧代 runtime/操作/导出令牌全部失效
5. **匿名遥测**：仅 allowlisted 粗粒度字段，无 per-user/per-token 维度
