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
2. **冷启动进 landing**：不注册默认工作区、不预创建 session、不派生 Pi 进程，registry 在启动期零改动（2026-09-03「冷启动一律以 ~/.pi/tmp 为 workspace」决策已废弃）。冷启动仍零派生；landing 配置面（Models/MCP/高级配置/软件包技能/advisor）按需懒派生 bridge 服务 runtime（`NativeRuntimeType::Config`：sessionless+toolless，cwd `~/.pi/tmp`，不注册工作区，global-only，经 `ephemeral_command` 通道定址，transition commit sweep 一并回收——见 `2026-09-18-landing-bridge-runtime-design.md` v2）。owner 以 `TemporaryKind::Landing` 创建（label `native-landing`；canonical home 仅作 owner 记录占位，永不为 workspace 身份、scope 或授权输入）
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
- **generation** 是单调递增的工作区代数——workspace transition 递增，旧代授权/操作/令牌全部失效；旧代 runtime 进程保留存活（upstream 语义：跨工作区切换不中断运行中的 turn），但因 wid/generation 失配被授权闸门拒之门外，返回原工作区时由 prepare rebind 到新代复用
- 远程设备经 `/v2/auth/exchange` 配对获得 device token（非 capability）

### 运行时事件可见性

任何已认证 desktop owner 可订阅任意 live runtime 的**事件流**（跨工作区侧栏绿/蓝点的数据源）；`runtime_request` 命令面仍要求 owner+workspace+generation 全匹配。阻塞型 `extension_ui_request`（select/confirm/input/editor）仅投递给 `authorize_target` 通过的订阅者，其余订阅者（以及 pending replay）不接收；`setWidget`/`notify` 等非阻塞 UI 事件与普通事件一样按订阅投递。

### 数据面 containment

`HostDataPlane` 强制所有文件**读写**操作限制在注册工作区根目录内：

- `safe_join(root, relative_path)` — canonicalize + symlink 检查
- `strip_prefix` 包含性（分隔符安全，兄弟前缀拒绝）
- atomic write + mtime conflict 检测

**列举 ≠ 读写（2026-09-19 @ 提及宽根）：** `file_mentions` 的**搜索列举**可按
用户前缀越出 workspace（desktop capability 专属 op；spec
`2026-09-19-file-mention-paths-design.md` 显式接受——与 Pi TUI 同机同用户语义
一致），而文件**读写** containment 完全不变。列举的搜索根按 query 前缀分级，
host 是唯一权威（WebView 只提交镜像声明供全等校验，不符即 `invalid_mention_query`）：

| 前缀 | 搜索根 | 声明 `{kind, value}` |
| --- | --- | --- |
| `@foo`、`@src/foo`、`@./foo` | 注册 workspace root | `{workspace, ""}` |
| `@../foo`（可多级，封底于根） | workspace 祖先目录 | `{absolute, 爬升路径}` |
| `@~/foo` | host 进程用户 home（`~` 仅 host 展开） | `{home, "~"}` |
| `@/foo`（仅 POSIX） | 文件系统根 | `{absolute, "/"}` |
| `@C:/foo`（Windows） | 盘符根（2s 可达性探测） | `{drive, "C:/"}` |
| `@//server/share/foo`（Windows） | UNC 共享根（2s 探测） | `{unc, "//server/share"}` |

词中 `..` 一律拒绝；递归下钻不越出声明的搜索根；预算（visited 10k / collected
200 / 返回 20 / 500ms / 深度 4）照抄 upstream 纪律。宽根 walk 在
`spawn_blocking` 中执行，不占异步 worker。

### Session 删除授权（per-path）

`session_delete_batch` control op 采用 Desktop+owner 身份门禁（`require_native_owner`）加逐路径校验，不依赖 owner 当前的 workspace 绑定：每个 path 必须存在于 `~/.pi/agent/sessions`、是可解析 header 的 `.jsonl`，且 header 记录的 cwd canonicalize 后命中注册 workspace root；运行中 session 另由 running 列表保护。这与 `workspace_sessions` data 路由的授权模型对齐：landing owner（无 workspace 绑定）能列出已注册 workspace 的 session，也就能删除它们；授权边界是 desktop owner capability，不是 workspace 绑定。被拒路径必须进入响应的 `errors` 数组而非静默丢弃——前端把「不在 errors 中」视为已删除，静默丢弃会伪造成功并让 session 在 refresh 后复活。

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

workspace 注册时，Picot 将 `session_bucket` 留空；注册成功后，当前窗口必须先通过 owner-bound 的 `workspace_target_prepare(forceNewSession: true)` 创建一个新的主 Pi runtime，再 commit transition 并导航到该 session。目标页面首屏会先渲染 route 对应的 provisional session，避免 bucket 尚未写回时显示空行；Pi runtime 的 `get_state.data.sessionFile` 是唯一 bucket 来源，不根据 workspace 路径计算 bucket，也不扫描全局 sessions root 发现 bucket。bucket 写回有两条路径：每次正式 spawn（`workspace_target_prepare`、`workspace_open`、`restart_runtime`）成功后，host 会起一个 detached 任务直接向新 runtime 发送 `get_state` 并写回 bucket——Pi 在 session 创建时就分配持久化文件路径，因此 spawn 后首个 `get_state` 即携带它，landing 添加项目后无需任何 WebView 动作即可完成登记（否则冷启动会话计数会因快照时机错失新会话而归零）；正常 runtime 的 `runtime_snapshot_request` 代理路径仍是兜底。不再启动无 owner 的探测进程。已有 registry row 再次 register 也创建新 session。临时 session 必须先绑定正式 session id，再保存 Pi 返回的 bucket。SQLite 只持久化 workspace registry（`workspace_id`、canonical path、display/pin/open 状态和 Pi 返回的 `session_bucket`）及 preferences；不持久化 session visibility、subagent classification 或 session-count cache，也不再创建或保留废弃的 `session_sidebar_visibility` 表。浏览器 cookie 中的 sidebar/navigation cache 只是跨路由首屏加速，可能过期或丢失，不能作为权限、workspace 身份或 session 列表的权威来源。bucket 缺失或 bucket 目录不存在表示 0 session，不移除 workspace；首次加载 registry 时，`workspace.list` 检查每个 canonical path 是否仍为目录，只删除已消失的 registry row，不删除物理目录或 session 文件。

Sidebar session discovery follows Pi `/resume`: one registered workspace bucket is enumerated. The `workspace_sessions` full-read path parses JSONL files concurrently (up to 10 workers per bucket; at most two such scans host-wide). `workspace_sessions(countOnly: true)` only reads directory entries and returns the exact `.jsonl` file count without parsing contents; a full read returns the exact count of successfully parsed sessions. Each valid session is retained; `parentSession` is used only to build cross-file parent/child relationships, not to hide or classify sessions. `pi-subagents_launch_metadata` no longer has a special visibility rule: Normal, Focus, search, list, and workspace batch deletion treat that file as an ordinary session. Search reads each candidate JSONL in one streaming pass.

Sidebar scans are bounded IO, not linear file reads: each session JSONL is read through a 64 KiB head window (session header entry, first user message, validity counts, at most 2 000 lines) plus a 256 KiB tail window (newest settled `session_info` name, parsed backwards from EOF). A settled name farther than the tail window from EOF degrades to no name; a preamble longer than the head window degrades to no first-message preview — both accepted degradations. This is a deliberate deviation from upstream's linear scan (which shares the same unbounded worst case), aligned with Paseo's production-verified session-descriptor windows; rationale in `docs/superpowers/specs/in-progress/2026-09-20-session-scan-bounded-io-design.md`.

Normal and Focus share `public/sidebar/session-tree-model.js`: missing parents and malformed cycles are promoted/broken without dropping files, then flattened with Pi-style branch prefixes. Normal shows five sessions initially per expanded workspace and adds ten per request; Focus uses the same five/ten pagination. Normal loads registry history lazily on expansion; Focus ensures the selected workspace history when entered. Session selection is not a registry data refresh: same-workspace selection updates the active row and chat history without a WebView reload, while cross-workspace selection prepares/commits a new runtime and navigates to its host-origin route. `focusWorkspaceId` is carried only when the target canonical cwd matches the focused workspace and is removed for cross-workspace or unknown navigation.

已知实现边界：host-wide 的两个完整扫描 permit 当前只包住 `workspace_sessions`；兼容/独立的 `list_sessions` 与 `search_sessions` 仍各自 `spawn_blocking`，不共享该上限。sidebar 的 registry count warmup 由 WebView 对所有 registry rows 并行发起，冷启动通过 `requestIdleCallback({ timeout: 800 })` 调度，空闲不足时也会在该上限到期后执行。它们是性能债务，不是 session 数据一致性或授权依据；若扩大 workspace 数量或搜索频率，应先将这些路径纳入统一 scan scheduler，再提高任何并发上限。

### 子进程注册表与孤儿清扫

pi runtime 的存活不依赖 Picot 的 teardown：`pi` 在 stdin EOF 时退出，但卡死的 runtime 读不到 EOF，而 Picot 被 SIGKILL/崩溃时根本不会执行清理。因此每次 spawn 成功后，host 把 `{pid, 启动时间}` 写入 `~/.pi/picot-runtimes/<supervisor-pid>.json`（`child_supervision.rs`），正常 stop 时删除对应条目、全部清空时删除文件。启动时 `sweep_orphans()` 扫描该目录：supervisor 进程已不存在且条目 pid 仍存活、且 OS 报告的启动时间与登记值一致的条目，才按进程组 `SIGKILL`，随后删除该注册表文件——启动时间是必需的身份校验，避免 pid 复用后误杀无关进程。SIGTERM/SIGINT/SIGHUP 另有信号兜底（`RunEvent::Ready` 时安装），走与正常退出相同的 `stop_for_app_exit()` + 清注册表路径；SIGKILL 无法捕获，正是清扫要覆盖的场景。进程组/Job Object 的终止语义仍由 `process_tree.rs` 负责，本注册表不重复实现。

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
| `pi_path.rs` | 内置 Pi 系统级 PATH 开关（`pi_path_status`/`pi_path_configure` 控制op）：POSIX marker 块管理 rc 文件、Windows HKCU 用户 Path + WM_SETTINGCHANGE；desktop-native owner、release-only、启动自愈，偏好键 `pi.pathEnabled` |
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
| `metadata_store.rs` | SQLite 工作区注册 + preferences；每个注册项持久化单个 Pi `session_bucket`；正式 spawn（`workspace_target_prepare`、`workspace_open`、`restart_runtime`）后由 host 主动 `get_state` 写回，`runtime_snapshot_request` 作为兜底；写入内容仅为 Pi `get_state.data.sessionFile` 的父目录，sidebar 只读该 bucket，不扫描全局 Pi sessions。schema 兼容契约：接受 user_version ≤ 6（Corp v4–v6 表归 Corp 构建，public 只读不建），public 迁移只完成 v1–v3 并只盖 v3 戳；public-owned `session_bucket` 列按存在性增量补齐，绝不改 Corp 版本戳 |
| `window_owner.rs` | 窗口 owner 注册与 capability |
| `remote_auth.rs` | 远程设备配对与 device token |
| `ephemeral_registry.rs` | Side/Quick chat 生命周期 |
| `git_service.rs` | owner-scoped Git status, diff, history, commit, and push operations；push 与写操作共享 per-root 写槽，认证严格非交互（GIT_TERMINAL_PROMPT=0 + askpass 抑制 + SSH BatchMode），超时 120s 后按进程组终止 |

| `pi_launch.rs` | 启动契约共享基底（binary/args/env/extensions） |
| `telemetry.rs` | D10 匿名遥测 schema（Stage 0 接线） |
| `process_tree.rs` | 进程树管理（Unix pgid / Windows Job Object） |
| `child_supervision.rs` | 运行时注册表 + 启动孤儿清扫 + 终止信号兜底（复用 process_tree 的终止语义） |

## Widget mirror registry

The main chat mirrors Pi `setWidget` payloads through `public/ui/widget-mirror-registry.js`. Ambient panels are keyed by the pushing runtime identity, so switching sessions hides inactive runtime panels and restores them when that runtime returns. Registered renderers such as rpiv-todo may consume tool results and history replay; unknown widget keys use a tolerant preformatted text panel. Blocking questionnaire UI is intentionally separate in `public/ui/questionnaire-card.js` because it has a one-shot lifecycle and must own cancellation and response draining. The card renders inline at the tail of the `#messages` stream (re-anchored there by a MutationObserver; Esc only while focused inside the card), not as a window modal. Because runtimes survive session switches, that card state (plus any walker requests already in flight) parks in `public/ui/background-questionnaire-store.js` keyed by session file / runtime id instead of being destroyed: a backgrounded runtime's `extension_ui_request` queues there with a sidebar unread badge, and the foreground mirror-sync path rebuilds the card and replays the queue when the user returns to that session.

The datarx-safety-guard bash approval (`public/ui/safety-guard-dialog.js`) instead renders **inline in the live turn that triggered it** — `createTurnSection`'s `card` slot, between the rail and the answer, so a required decision never sits inside the rail's collapsible disclosure — and only falls back to the `#dialog-container` modal when no live turn can host it (replayed background request, transcript re-render, abort). `closeLiveTurn` re-homes a still-pending card into the modal before the transcript drops its host turn: destroying the card would leave that runtime waiting on `extension_ui_response` forever, and answering `cancelled` on its behalf would silently Block.
Its Esc is card-scoped rather than document-level: an inline card shares the page with the composer and the stop button, and a page-level Esc must not be hijacked into a silent Block. The questionnaire card (`public/ui/questionnaire-card.js`) is inline for the same reason and pins itself to the stream tail with a `MutationObserver`; the approval card instead lives in its turn's slot, so the two cannot fight for the last position when both are pending.


## Settings 数据面（/picot-config 桥）

Settings → Models/Configuration 的 catalog、API key、models.json、OAuth 操作不再走静态 `host_models` 读盘路径，而是通过 `extensions/picot-bridge.ts` 注册的 `/picot-config` 命令在 Pi 进程内执行：WebView 以 `runtime_request(prompt)` 发起，结果经 `ctx.ui.notify` 的 `__picotConfig` 帧按 request id 回关（`public/settings/config-gateway.js`）。模型 catalog 与认证状态读 Pi live `modelRegistry`，因此 shell 环境变量凭证（如 `ANTHROPIC_API_KEY`）能正确显示。Codex OAuth 走同一通道：login/logout 以 `oauth_logout`/`start_oauth_login` op 触发，事件以 `__picotOauth` 帧流式返回，前端在 runtimeEvent 分发前按 M3 互斥优先消费（`public/settings/oauth-gateway.js`）。Settings 的 skills inventory/mutation、默认 thinking level 也走 bridge。Settings → MCP 页（三层页签，pi-mcp-adapter 检测到才显示）同样走 bridge：`mcp_list_servers`/`mcp_save_server`/`mcp_delete_server`/`mcp_toggle_server` 四个 op（`extensions/mcp-settings.ts`）读写 adapter 的分层 mcp.json，只写 pi-owned 层（pi-global 与项目 `.pi/mcp.json`），enable/disable 复刻 adapter 的项目层覆盖语义（含 `.mcp.json` 下层判定、无变化跳写、空条目删除）。Settings → 已安装扩展详情页的 advisor 配置渲染器（`public/settings/package-extension-settings.js`）同样走 bridge：`advisor.config.get`/`advisor.config.set`（`extensions/extension-settings.ts`）读写 `~/.config/rpiv-advisor/advisor.json`，read-modify-write 保留未知键、tmp+rename 原子写 + best-effort 0600，模型列表与 effort 档位取自进程内 modelRegistry + pi-ai `getSupportedThinkingLevels`，生效时机为下次 session_start（advisor 每次 session_start 重读磁盘）。host 侧旧的静态 catalog、OAuth、skills inventory 路由已删除；`host_models.rs` 仅保留 settings.json IO。

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

### 项目信任（trust.json）

Pi 以 `~/.pi/agent/trust.json`（键为 canonical 路径，值为 true/false/null）决定是否加载项目本地 `.pi/` 资源（skills/prompts/extensions/settings.json 等）。RPC 模式无 UI 询问、Picot 的 `project_trust` extension 分支返回 `undecided`、Pi 对「ask 且无 UI」的兑底是不信任，因此 Picot 必须自己建立信任决定：

- **写入点**（`src-tauri/src/project_trust.rs`，均为 best-effort，失败仅 `log::warn` 不阻断）：①`workspace.add` 控制面 op 成功后，按返回的 `canonicalPath` 写入；②`pi_launch::native_launch_spec`（open_workspace / restart_runtime / workspace transition 的统一封装）在 spawn 前写入。通过 Picot 添加或打开已注册 workspace 即显式信任手势，会覆盖该路径的显式 `false`。ephemeral/quick/side-chat runtime 走 `native_launch_spec_for`，**不**写信任（临时目录保持隔离）。
- **写入协议**：复刻 Pi 的 proper-lockfile 语义——`create_dir`（原子 EEXIST，绝不可用 `create_dir_all`）在 `trust.json.lock` 目录上获取锁，10s mtime 过期阈值，20ms 重试、上限 750 次，`remove_dir` 释放；read-modify-write 保留其他条目，键排序 + 2 空格 JSON + 尾随换行与 Pi 的 `writeTrustFile` 逐字节一致，tmp+rename 原子落盘。
- **查询语义**：`skill_scope_context` 改用 `is_project_trusted`，对齐 Pi 的 `findNearestTrustEntry`——从项目根向上找最近的 true/false 条目（更近的显式 `false` 覆盖受信父目录），null/缺失继续上溯，无条目则不信任。

## Office 文件原生预览（anydoc）

选中候选 Office 文件（后缀 `doc/docx/rtf/odt/ppt/pptx/odp/xls/xlsx/ods` 共十种）时，`file_read` 走内嵌 `anydoc` crate（精确 pin `=0.2.4`，MIT）的原生转换分支，产物为只读 Markdown（`previewStatus:"ready"` + `renderAs:"markdown"`）。安全与资源边界：

- **输入上限分层**：普通读保持 8 MiB（`host_files::read`）；仅候选分支经 `read_with_cap` 用 32 MiB 专用上限。
- **输出上限**：转换 Markdown 超 2 MiB UTF-8 即失败（远低于 WebSocket 响应上限的 JSON 转义最坏情形）。
- **并发**：进程级两枚信号量 permit；请求先过 permit 才读盘/检测/解析，permit 随 blocking 闭包持有到缓冲区全部离开作用域。第三份并发请求只会等待，不占输入内存。提高上限需先做 macOS/Windows 双平台峰值 RSS 基准。
- **授权跨长任务**：`PreviewScope`（owner/workspace/generation）在 permit 等待前、permit 到手后、解析完成后三点重校验；workspace 转场中途落地则丢弃结果返回 `unauthorized_target`，绝不返回旧内容。
- **无硬取消**：进程内解析不可强停；浏览器 abort 只是忽略响应，不释放运行中转换的 permit。需要硬超时/硬取消时必须改为可杀死的隔离 worker 进程。
- **错误去敏**：adapter（`anydoc_preview.rs`）持有封闭错误码枚举，AnyDoc 细节（part 名、限额、路径、字节、Display 文案）不出模块、不进日志（host 只可记录固定码）；浏览器只见通用 `conversionFailed`。`ConvertError` 为 `#[non_exhaustive]`，通配分支只映 `Internal`。升级 anydoc 版本须重审依赖树 + 全错误码契约测试。
- **fail-closed**：候选后缀但内容检测为 PDF → `conversionFailed`，绝不改道 PDF 原始路由；检测出的非 Office 格式（EPUB/CSV 等）同样拒绝。
- **图片策略**：转换文档的 Markdown 渲染只接受 base64 栅格 data URI（png/jpeg/gif/webp），其余来源（SVG/远程/相对/未知 MIME）替换为本地化文本 `files.preview.converted.remoteImageHidden`。
- **无网络/无 OCR**：不调用 AnyDoc 托管 OCR/API key/任何网络路径；PDF 留在既有 PDF 预览路由。

## Provider 配额探针（Usage → 提供方配额）

`extensions/provider-quota.ts` 在 pi 进程内对已配置 provider 的用量端点做只读探针（spec 2026-09-22，端点语义照抄 opencodex 生产实现）。边界：

- **按 canonical baseUrl 选择，不按 provider id**：探针注册表只认固定 host 集合（chatgpt.com / api.z.ai / open.bigmodel.cn / opencode.ai / api.deepseek.com / minimax.io / minimaxi.com / moonshot.ai / moonshot.cn / ollama.com）；baseUrl 不匹配不发包（防把 key 发到仿冒 host）。
- **凭据不出 pi 进程**：api-key 走 `readStoredCredential`；models.json 自定义 provider 读条目 `apiKey`；openai-codex 走 `ModelRuntime.getAuth`（OAuth 刷新归 pi，失败报 `needs_login`）+ `readStoredCredential` 补 accountId。返回 WebView 的只有归一化配额数字与封闭错误码。
- **探针纪律**：`redirect:"error"`、8s 超时、256KB 响应体上限；瞬时失败（429/5xx/超时）保留 last-good 行 30 分钟，`response_unusable` 丢弃旧行；进程内缓存 TTL 5 分钟 + in-flight 去重，`force` 跳过。
- **Codex 重置额度双通道（不可逆操作）**：WebView → Rust 账本 `reset_credit_open`（sqlite 记 pending，operationId 即上游幂等键 `redeem_request_id`，未决行复用不开新单）→ pi 内 `consume` POST → Rust `reset_credit_settle`（settled/ambiguous）。启动清扫 60s 前的 pending 行为 abandoned；ambiguous 行下次重开对话框时先 `inspect` 对比 `available_count` 再决定重放同 id。账本表 `reset_credit_operations` 为 public-owned、existence-based 建表（session_bucket 先例，不动 Corp 拥有的版本戳）。
- **owner 门禁**：`reset_credit_open/settle` 与 `cost_dashboard` 同款——已认证 desktop owner、landing 可见。

## 浏览器面板与元素标注（browser pane）

右侧 file-preview 面板的 `browser` tab 在主窗口内叠加 `tauri::webview` child webview（spec 2026-09-22，需 `unstable` feature；`window.add_child(builder, position, size)` 创建即定位）。安全边界：

- **外部 webview 无 capability 初始化脚本**——它不是 owner，没有任何 host 控制权；`on_new_window` 一律 Deny。
- **URL 白名单**：仅 http(s) 且 origin ≠ host origin（`browser_pane.rs::pane_url_allowed`）；file:/自定义 scheme 拒绝。`on_navigation` 运行时同策略，防外部页跳回 host 窃取窗口上下文；userinfo 不是 host 旁路（`http://x@evil.com` 的 host 就是 evil.com，属普通外部页）。
- **布局同步**：pane 容器 ResizeObserver → rAF 合并 → `browser_pane_set_rect`（logical 坐标）；宽/高 < 2px 隐藏原生视图。tab 切换走 hide（webview 存活）；tab 关闭才 destroy。窗口销毁时 `destroy_all_for_window` 清映射，label 可复用。
- **eval 桥**：`browser_pane_eval` = Rust `eval_with_callback` + try/catch 包装（Windows 异常被平台吞掉，靠包装脚本返回 `{ok:false,error}` 传回）+ 5s oneshot 超时；pane 锁作用域块级收束（MutexGuard 不得跨 await）。
- **元素选择器**（`public/browser-pane/element-selector.js`，Paseo 移植）：IIFE 注入 + `window.__picotSelectorResult` 200ms 轮询 + session token 防串台 + Esc 取消 + 30s 超时；增强 `closest('[data-path]')` 采集 `docPath`。officecli watch 页面 `data-path` 与 `officecli set/add` 坐标同源——标注即**可执行修改坐标**（`<office-element>` 附件含 `suggested: officecli set …`）；普通网页走 Paseo `<browser-element>` 格式。附件以文本块进 composer（`#message-input`），用户可改后再发送。
- **officecli watch 生命周期**（`officecli_watch.rs`）：canonical 路径去重（同文件多 tab 共享一个 watch）；空闲端口分配；stdout 解析 `Watch: http://localhost:PORT`（15s 启动超时）；stop 走 SIGTERM→2s→SIGKILL；app 退出 `stop_all` 清场。`watch mark` 服务端打标（刷新不丢）。Rust 侧 watch 与 pane 均 owner 门禁 data op。
- **入口分工**：office 文件点击 → anydoc markdown 预览（快、零依赖）→「内置浏览器打开」按钮 → `officecli_watch_start` → browser tab（保真 + 标注 + agent 闭环）。无 officecli 时按钮报 `officecli_missing` toast。
- **不做（一期）**：元素截图、普通网页徽标 overlay、历史/书签、agent 反向自动化（Paseo 22 命令，三期）。

## 兼容路由（P8 删除候选）

`/api/*` compatibility routes maintain existing shell behavior on host origin. Each route uses owner capability authorization. Runtime traffic must use `/v2/*` and `/v2/ws`; retained HTTP routes are explicit compatibility or retirement responses, never Pi-origin forwarding.

## 静态资源

构建产物按内容指纹版本化：`/v/<fingerprint>/...`，`Cache-Control: no-store` 防止 auto-update 后 WebView 缓存旧 release。

## 安全边界

1. **Loopback 默认**：HostServer 默认只绑 loopback；`mobile.lanAccessEnabled` 显式开启后才绑全部网卡（D4 移动接入；缺省一律 loopback，配对 token 仅桌面端可铸造）
2. **Owner capability**：每个桌面窗口持唯一 32 字节随机 capability
3. **Workspace containment**：所有文件读写限制在注册根目录内；`file_mentions` 的列举按上表根分级可越出（仅 desktop，读写不受影响）
4. **Generation 失效**：workspace transition 使旧代授权、操作与导出令牌全部失效；旧代 runtime 进程保留存活但不可达（授权闸门拒收），至窗口销毁/owner 撤销/app 退出、显式 restart（`restart_runtime` 控制面命令，Registered owner 经 Settings 触发）或返回 rebind
5. **跨 workspace 事件可见性**（2026-09-20 拍板）：持有 desktop capability 的本机窗口可订阅任意 live runtime 的全部非阻塞事件（消息正文、tool 输出、widget、notify）；阻塞式 `extension_ui_request`（select/confirm/input/editor）仍只投 `authorize_target` 通过的订阅者。desktop capability 只由原生窗口 owner registry 铸发，LAN 配对设备（Browser 类客户端）拿不到。
6. **匿名遥测**：仅 allowlisted 粗粒度字段，无 per-user/per-token 维度
