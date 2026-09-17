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
2. **冷启动进 landing**：不注册默认工作区、不预创建 session、不派生 Pi 进程，registry 在启动期零改动（2026-09-03「冷启动一律以 ~/.pi/tmp 为 workspace」决策已废弃）。owner 以 `TemporaryKind::Landing` 创建（label `native-landing`；canonical home 仅作 owner 记录占位，永不为 workspace 身份、scope 或授权输入）
3. 创建 `NativePiManager` + `HostServer`（loopback:0 绑定）
4. 打开 landing 窗口加载 `{origin}/`；WebView 在 bootstrap 期分叉加载 `landing.js`（仅构造 transport、sidebar 四 seam、transition controller、landing notice 与 landing 版 Quick Chat，不建任何 chat-lifecycle 对象）。首次进入工作区必为跨工作区原地切换（prepare → commit → navigate，overlay 换屏）；workspace 的 `same`/`cross` 分类按 owner 的 Registered 绑定派生，Landing owner 永不 same（即使占位 home 本身是已注册工作区）
5. landing owner 首次 commit 后重绑为 Registered owner；窗口销毁清理、New Session 菜单状态与 Cmd+N 派发一律按 owner 注册表记录判定，不按 label 前缀（label 终身不变，非状态信号）
6. workspace 权威性为 Registered-only：Git、terminal、文件/数据 scope、项目级 config/skills 与 Side Chat 拒绝 Landing/Temporary owner；Quick Chat 是唯一 landing 例外（自带一次性 temp cwd，显式准入路径单独测试）
7. 用户自 landing 经 sidebar 进入工作区：session 行选择 / 工作区 `+ New Chat`（零会话工作区唯一入口）/ 添加项目后导航 / Focus 四条 seam 全部路由到 `enterWorkspace`

## 网络路径

| 路径 | 协议 | 授权 | 用途 |
| --- | --- | --- | --- |
| `/` | HTTP GET | desktop capability init script（owner 感知由 `/v2/ws` hello 承担） | native 冷启动 landing 页；非 native 浏览器行为不变 |
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

### 工作区会话目录

Pi 进程内部会将 canonical workspace path 映射到确定性 session bucket（例如 `~/.pi/agent/sessions/--<canonical-path-with-separators-folded-to-dash>--`）：

```text
~/.pi/agent/sessions/--<canonical-path-with-separators-folded-to-dash>--
```

workspace 注册时，Picot 将 `session_bucket` 留空；注册成功后，当前窗口必须先通过 owner-bound 的 `workspace_target_prepare(forceNewSession: true)` 创建一个新的主 Pi runtime，再 commit transition 并导航到该 session。目标页面首屏会先渲染 route 对应的 provisional session，避免 bucket 尚未由 snapshot 写回时显示空行；Pi runtime 的 `get_state.data.sessionFile` 是唯一 bucket 来源，正常 runtime 的 `runtime_snapshot_request` 走 Pi 权威写回路径；不再启动无 owner 的探测进程。已有 registry row 再次 register 也创建新 session。临时 session 必须先绑定正式 session id，再保存 Pi 返回的 bucket。Picot 不根据 workspace 路径计算 bucket，也不扫描全局 sessions root 发现 bucket。SQLite 只持久化 workspace registry（`workspace_id`、canonical path、display/pin/open 状态和 Pi 返回的 `session_bucket`）及 preferences；不持久化 session visibility、subagent classification 或 session-count cache，也不再创建或保留废弃的 `session_sidebar_visibility` 表。浏览器 cookie 中的 sidebar/navigation cache 只是跨路由首屏加速，可能过期或丢失，不能作为权限、workspace 身份或 session 列表的权威来源。bucket 缺失或 bucket 目录不存在表示 0 session，不移除 workspace；首次加载 registry 时，`workspace.list` 检查每个 canonical path 是否仍为目录，只删除已消失的 registry row，不删除物理目录或 session 文件。

Sidebar session discovery follows Pi `/resume`: one registered workspace bucket is enumerated. The `workspace_sessions` full-read path parses JSONL files concurrently (up to 10 workers per bucket; at most two such scans host-wide). `workspace_sessions(countOnly: true)` only reads directory entries and returns the exact `.jsonl` file count without parsing contents; a full read returns the exact count of successfully parsed sessions. Each valid session is retained; `parentSession` is used only to build cross-file parent/child relationships, not to hide or classify sessions. `pi-subagents_launch_metadata` no longer has a special visibility rule: Normal, Focus, search, list, and workspace batch deletion treat that file as an ordinary session. Search reads each candidate JSONL in one streaming pass.

Normal and Focus share `public/sidebar/session-tree-model.js`: missing parents and malformed cycles are promoted/broken without dropping files, then flattened with Pi-style branch prefixes. Normal shows five sessions initially per expanded workspace and adds ten per request; Focus uses the same five/ten pagination. Normal loads registry history lazily on expansion; Focus ensures the selected workspace history when entered. Session selection is not a registry data refresh: same-workspace selection updates the active row and chat history without a WebView reload, while cross-workspace selection prepares/commits a new runtime and navigates to its host-origin route. `focusWorkspaceId` is carried only when the target canonical cwd matches the focused workspace and is removed for cross-workspace or unknown navigation.

已知实现边界：host-wide 的两个完整扫描 permit 当前只包住 `workspace_sessions`；兼容/独立的 `list_sessions` 与 `search_sessions` 仍各自 `spawn_blocking`，不共享该上限。sidebar 的 registry count warmup 由 WebView 对所有 registry rows 并行发起，冷启动通过 `requestIdleCallback({ timeout: 800 })` 调度，空闲不足时也会在该上限到期后执行。它们是性能债务，不是 session 数据一致性或授权依据；若扩大 workspace 数量或搜索频率，应先将这些路径纳入统一 scan scheduler，再提高任何并发上限。

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
| `metadata_store.rs` | SQLite 工作区注册 + preferences；每个注册项持久化单个 Pi `session_bucket`，仅由 Pi `get_state.data.sessionFile` 的父目录写入；sidebar 只读该 bucket，不扫描全局 Pi sessions。schema 兼容契约：接受 user_version ≤ 6（Corp v4–v6 表归 Corp 构建，public 只读不建），public 迁移只完成 v1–v3 并只盖 v3 戳；public-owned `session_bucket` 列按存在性增量补齐，绝不改 Corp 版本戳 |
| `window_owner.rs` | 窗口 owner 注册与 capability |
| `remote_auth.rs` | 远程设备配对与 device token |
| `ephemeral_registry.rs` | Side/Quick chat 生命周期 |
| `git_service.rs` | owner-scoped Git status, diff, history, and commit operations |

| `pi_launch.rs` | 启动契约共享基底（binary/args/env/extensions） |
| `telemetry.rs` | D10 匿名遥测 schema（Stage 0 接线） |
| `process_tree.rs` | 进程树管理（Unix pgid / Windows Job Object） |

## Settings 数据面（/picot-config 桥）

Settings → Models/Configuration 的 catalog、API key、models.json、OAuth 操作不再走静态 `host_models` 读盘路径，而是通过 `extensions/picot-bridge.ts` 注册的 `/picot-config` 命令在 Pi 进程内执行：WebView 以 `runtime_request(prompt)` 发起，结果经 `ctx.ui.notify` 的 `__picotConfig` 帧按 request id 回关（`public/settings/config-gateway.js`）。模型 catalog 与认证状态读 Pi live `modelRegistry`，因此 shell 环境变量凭证（如 `ANTHROPIC_API_KEY`）能正确显示。Codex OAuth 走同一通道：login/logout 以 `oauth_logout`/`start_oauth_login` op 触发，事件以 `__picotOauth` 帧流式返回，前端在 runtimeEvent 分发前按 M3 互斥优先消费（`public/settings/oauth-gateway.js`）。Settings 的 skills inventory/mutation、默认 thinking level 也走 bridge。Settings → MCP 页（三层页签，pi-mcp-adapter 检测到才显示）同样走 bridge：`mcp_list_servers`/`mcp_save_server`/`mcp_delete_server`/`mcp_toggle_server` 四个 op（`extensions/mcp-settings.ts`）读写 adapter 的分层 mcp.json，只写 pi-owned 层（pi-global 与项目 `.pi/mcp.json`），enable/disable 复刻 adapter 的项目层覆盖语义（含 `.mcp.json` 下层判定、无变化跳写、空条目删除）。Settings → 已安装扩展详情页的 advisor 配置渲染器（`public/settings/package-extension-settings.js`）同样走 bridge：`advisor.config.get`/`advisor.config.set`（`extensions/extension-settings.ts`）读写 `~/.config/rpiv-advisor/advisor.json`，read-modify-write 保留未知键、tmp+rename 原子写 + best-effort 0600，模型列表与 effort 档位取自进程内 modelRegistry + pi-ai `getSupportedThinkingLevels`，生效时机为下次 session_start（advisor 每次 session_start 重读磁盘）。host 侧旧的静态 catalog、OAuth、skills inventory 路由已删除；`host_models.rs` 仅保留 ModelCache 与 settings.json IO。

Settings → 已安装扩展详情页的 pi-fff 配置渲染器（同文件 fff 条目）走 **host 控制面 op** 而非 bridge：`get_fff_config`/`set_fff_config`（`src-tauri/src/fff_config.rs`，main.rs 控制分发，Desktop+owner 门禁接受 landing owner）读写 `~/.pi/agent/pi-fff.json`（尊重 `PI_CODING_AGENT_DIR`）。get 计算逐字段 env > file > default 有效链与 shadow 集（host 进程 env 即内嵌 Pi 继承的 env；flag 检测放弃——内嵌 Pi 的 argv 从不含 `--fff-*`，终端 pi 逐实例不可观测，`flagShadowed` 恒空保持载荷形状），set 为单键 save-on-change：宽松读入后重建 schema 干净文件（additionalProperties:false，未知键丢弃、永不写出 invalid 文件），`reset` 写仅含 `$schema` 的最小文件，写经 `host_config::write_json`（proper-lockfile + tmp+rename + 0600）。走 host 意味着 landing 页（无 Pi 进程）也能配置 fff；文件编辑需重启 Picot 生效（fff 在模块加载时读一次配置）。

### Settings → Skills → Packages

Pi 的 package skill 配置属于 `settings.json` 的 `packages[]` entry，而非独立的 skill enabled 表。entry 可为 source 字符串，或带 resource filter 的对象：

```json
{
  "packages": [
    {
      "source": "npm:example",
      "skills": ["!skills/**", "+skills/foo", "-skills/bar"]
    }
  ]
}
```

`skills` 未定义表示该 package 的 skills 按默认规则加载；空数组 `[]` 表示不加载该 resource type。普通 pattern 选择匹配资源，`!pattern` 从集合排除，`+path` 强制精确包含，`-path` 强制精确排除且有最终优先级。pattern 相对 package root 匹配 skill directory/`SKILL.md`。因此单个开关写入精确 `+relativePath` 或 `-relativePath`，不应将 UI 的 enabled state 持久化为另一套配置格式。

global `~/.pi/agent/settings.json` 与 trusted project `<workspace>/.pi/settings.json` 均可声明 package。project 普通 entry 按 identity 覆盖 global entry；匹配 global source 的 project `autoload:false` entry 是 delta：继承 global source/installed root，并以 project resource filter 覆盖 effective state。未受信任项目不得读取或写入 project package settings。

Picot 的 Packages tab 由 `public/settings/package-skills-tab.js` 渲染；它经 `/picot-config` 的 `list_package_skill_inventory` 取得 `extensions/package-skill-inventory.ts` 解析出的 effective package candidates 和 enabled state。单项切换发送 `set_package_skill_enabled`，bridge (`extensions/picot-config.ts`) 在同一 scope 的 settings 文件上使用 settings lock 与 atomic write 更新 `packages[].skills`，随后返回重算后的 inventory。该修改只影响后续 Pi resource discovery，响应携带 `runtimeRestartRequired: true`；当前 runtime 不热重载 skills，用户须新建 session 或重启 Pi 后生效。

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
