# Gate C：Pi 启动与生命周期契约（逆向证据稿）

> 状态：evidence-based reverse engineering。本文只记录当前仓库可验证行为与明确缺口，**不是终态实现设计**。
> 盘点日期：2026-08-28。证据来源：`src-tauri/src/pi_manager.rs`、`native_pi_manager.rs`、`runtime_coordinator.rs`、`pi_rpc_bridge.rs`、`main.rs`、`ephemeral_registry.rs`、相关单元测试，以及 Gate C 设计（`docs/superpowers/specs/2026-08-27-native-runtime-migration-design.md` §3 Gate C）。
>
> 结论先行：legacy `PiManager` 才是当前完整启动/清理契约；`NativePiManager` 只实现最小 RPC 子进程路径。不能把两者视为等价实现。当前 native runtime 仅 `cfg!(debug_assertions) && PICOT_RUNTIME=native` 可达，release 仍走 legacy 路径（`main.rs::native_runtime_enabled`）。

## 1. 证据边界与术语

- **legacy runtime**：`PiManager` 派生 `pi`，给它 `--extension embedded-server`、`--mode rpc`，Pi 进程内 extension 再监听 HTTP/WS port。
- **native runtime**：`NativePiManager` 派生 `pi`，通过 `PiRpcBridge` 使用 stdin/stdout JSONL；设计目标是不加载 `embedded-server`，但当前启动入口仍由 `PiManager::native_launch_spec` 解析 binary/bridge。
- **runtime identity**：native `RuntimeTarget { workspaceId, sessionId, instanceId }`；legacy 主要以 port、session path、内部 process identity 路由。
- **generation**：ephemeral/owner transition 的防陈旧清理字段；legacy `PiManager` process identity 是单独的递增 `u64`，不是 workspace generation。
- **ready**：legacy 以 HTTP endpoint 可访问作为启动就绪；native 当前无实现级 ready probe，仅 coordinator 初始状态 `Starting`。

本文区分：

- **已证据化**：代码/测试直接证明。
- **推断**：由多个实现点组合得出，但没有单一正式接口保证。
- **证据缺口**：当前实现没有证明，迁移不得填入想当然的行为。

## 2. Runtime 类型契约矩阵

| Runtime type | 当前 cwd / session | 当前 extension set | 当前 args/env | owner/generation | ready | stop/cleanup | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| primary workspace（legacy） | `open_workspace_core(cwd, session_path)`；cwd 由调用方传入，session 可选；`PiManager::spawn` 保存 cwd | 必需 `embedded-server.mjs`；始终尝试 `picot-bridge.mjs`；cwd 命中 Super Agent 路径时再尝试 `pi-chat.mjs` | `--extension embedded-server --mode rpc`，可加 `--session path`；无 `no-session/no-tools`。env 见 §4 | owner 在 `open_workspace_window` 创建；legacy process 以 port/identity 管理 | `wait_for_pi_health(port, 30)` → `/api/health`；可选再等 `/api/sessions` 4s | window destroy：dedicated → primary kill → broker unregister；app exit `kill_all` | 完整 legacy 证据 |
| primary workspace（native debug） | `setup_native_runtime` 固定 `ensure_picot_tmp_root()`；fresh session，`session_path=None`；当前不是 registry workspace | `NativeLaunchSpec` 仅 `picot-bridge`；不加载 embedded server；native shell URL 当前是 `/app/...` | `--extension picot-bridge --mode rpc`；`PATH`、Pi version；缺 canonical agent root/static locator/secret | 随机 `native-*` workspace ID、`temporary-*` session ID、随机 instance ID；HostDataPlane 另持 cwd map | 无 HTTP probe；spawn 后立即创建 native window；coordinator=`Starting` | native window destroy 调 `stop_workspace(workspace_id)`；只 stop runtime | debug-only 实验路径；已有随机 ID/map 与 Gate R contract 冲突 |
| default startup tmp | legacy `cmd_retry_startup` 与 native setup 都取 `ensure_picot_tmp_root()`；未注册设计要求 | legacy 仍 embedded server；native 为 picot-bridge | fresh/no explicit session；legacy `PI_STUDIO_*`；native 当前字段见上 | legacy owner 可标 `DefaultStartup`；native 随机 workspace ID 但不是 registry authority | legacy `/api/health`；native 未定义 | window/app lifecycle；tmp root 不应作为 registry row | `~/.pi/tmp` 共享规则有代码证据；native identity policy 未闭环 |
| dedicated session（legacy） | `spawn_session_dedicated(workspace_port, session_file, cwd)`；explicit session path；同 session file 复用 port | 同 primary：embedded server + optional bridge + conditional pi-chat | 同 primary，`--session <file>` | `session_ports`、`workspace_dedicated` map；以 workspace port 归属 | `spawn_session_process_core` 等 `/api/health` 最多 15s | window destroy 先 `kill_workspace_dedicated`；清 route/map | native 对应物未实现 |
| Side Chat（legacy ephemeral） | workspace cwd；no explicit session，实际通过 `--no-session`；tools enabled | 启动复用 legacy full extension set；env `PI_STUDIO_EPHEMERAL_KIND=side-chat` 等 | `--no-session`，不加 `--no-tools` | `EphemeralRegistry` owner 分区，Side quota=1；generation + transition generation | standby 使用 TCP listener 可连接；同步创建路径沿实际 caller 的 health/ready 逻辑，需 Gate A caller 复核 | transition/owner cleanup 生成 lease；broker 先禁 upstream/revoke route，再 kill；standby 可取消/过期/采用 | owner/quota/generation 有证据；native Side Chat 缺完整 spawn path |
| Quick Chat（legacy ephemeral） | `create_quick_chat_temp_dir` 在 canonical `~/.pi/tmp` 下创建 token 化 child；no session | legacy embedded server，picot bridge 尝试加载；no tools | `--no-session --no-tools`；ephemeral markers；skill secret/agent root | owner 分区最多一个；child path+token 仅 host 内记录，不进浏览器 | standby 以 TCP listener；具体 ephemeral create ready 需调用矩阵复核 | token/path/symlink/root containment 校验后 `remove_dir_all`；owner/window/exit/standby cleanup | child cleanup 证据较完整；native Quick Chat 未实现 |
| standby（legacy） | Side：目标 workspace cwd；Quick：预创建独立 temp cwd；两者按 `(cwd,no_tools)` 匹配 | 与被 warm 的 legacy runtime 相同；Quick/Side 环境 marker 使用 placeholder `standby`, generation 0 | `--no-session`，Quick 再 `--no-tools`；spawn 后最多 30s TCP ready | `standby_warming` lease generation；pool 无 public owner；adoption 后 caller 绑定 | TCP connect `127.0.0.1:port`；再检查 exact process identity | cancel/TTL(300s)/natural exit/window/app cleanup；Quick child token cleanup | warm/adopt/obsolete prevention 有测试 |
| Super Agent / pi-chat | `is_super_agent_workspace_path(cwd, super_agent_home_candidates)` 命中才加载 pi-chat；session 仍由 legacy spawn caller 决定 | embedded server + pi-chat + picot bridge | 无独立 `PiSpawnSpec`；pi-chat 仅 legacy conditional extension | owner/session route 依 legacy；Telegram secret 在 pi-chat 侧 | legacy health | legacy process lifecycle；外部 Telegram flow 不等于 runtime cleanup | native path无 pi-chat 等价实现证据 |
| Windows path variant | legacy 对 binary/static/cwd/extension/agent root 去 `\\?\`；native 无等价规范化 | 同上 | legacy `CREATE_NO_WINDOW`；native 同样只隐藏 console | 无 Job Object | 同平台 health/bridge 语义 | direct child kill only | Job Object/process-tree 是证据缺口 |

### 2.1 当前实现不等价点

1. `PiManager::native_launch_spec` 只解析 binary、bridge、cwd、session、PATH、Pi version；`NativeLaunchSpec::command_description` 只生成 PATH/Pi version 两个 env。
2. legacy `build_spawn_environment` 注入 canonical `PI_CODING_AGENT_DIR` 与 `PI_STUDIO_SKILL_INSTALL_SECRET`，并拒绝 caller 覆盖 agent root；native spec 没有这两个字段。
3. legacy 可条件加载 `pi-chat`，native launch description 不表达 Super Agent/Telegram extension。
4. legacy 有 port、health、stderr logger、process exit watcher、standby pool、dedicated session；native manager 没有 health/port、standby、dedicated、exit watcher。
5. `setup_native_runtime` 使用随机 native workspace ID 与裸 `HashMap<workspace_id, cwd>`，而 Gate R 要求 `OwnerWorkspaceSnapshot` 与 Registered-only v2 target；这是已知 Gate R 缺口，不得在契约中伪装为完成。

## 3. Binary、cwd、session 与参数顺序

### 3.1 Binary resolver

**legacy 证据（`PiManager::resolve_bundled_pi`）：**

1. `PI_BIN` 非空且为文件时优先（测试/手工 smoke escape hatch）。
2. `<static_dir parent>/pi/pi[.exe]` 为 bundle 路径。
3. debug 才回退 `<repo>/src-tauri/resources/pi/pi[.exe]`。
4. 不存在时返回包含尝试路径的错误；不调用 `$PATH` 上的 pi。

**native 证据：** `setup_native_runtime` 先构造 `PiManager`，调用 `native_launch_spec`，所以当前 native binary resolver 仍复用上述 legacy resolver。未来独立 native manager 的 resolver 尚不存在。

### 3.2 Path normalization

legacy 对 Tauri resource 的 Windows extended-length `\\?\` 前缀做 `strip_verbatim_prefix`，应用于 binary、static dir、cwd、extension、agent root。理由由代码注释与测试说明：embedded Bun/Pi 在 Windows arm64 上可能因该前缀崩溃或无法解析 module。native `NativeLaunchSpec` 直接使用 `PathBuf::to_string_lossy()`；没有独立 Windows path normalization 证据。

### 3.3 Args

legacy `build_pi_args(extension_path, spec)` 固定顺序：

```text
--extension <embedded-server>
--mode rpc
[--no-session | --session <session-path>]
[--no-tools]
```

legacy desktop spawn 随后追加 optional `--extension <pi-chat>`，再追加 optional `--extension <picot-bridge>`。因此实际 extension 参数顺序为 embedded server → pi-chat（仅 Super Agent）→ picot bridge。

native `NativeLaunchSpec::command_description` 固定顺序：

```text
--extension <each spec.extensions entry>
--mode rpc
[--session <session-path>]
```

它没有 `--no-session` / `--no-tools` 表达能力；native Side/Quick/standby/dedicated 参数组合未被实现或测试覆盖。当前 native launch test 只证明没有 TCP port 参数、包含 `--mode rpc` 与 explicit `--session`。

### 3.4 cwd/session semantics

- legacy process `current_dir` 是 spec cwd；`PiProcess.cwd` 保留原始 `spec.cwd`，用于 registry touch。主 session window 创建后以该 cwd 作为 owner workspace display/authority 输入。
- explicit session path 只由 host caller 传给 `--session`；Pi 负责 session 内容与切换语义。
- `new_session` / `switch_session` / `fork` 等 session behavior 通过 Pi stdin RPC；fork 不换 port，switch/new session 的 broker route 由 host 更新。
- dedicated process 将 session file→port 缓存在 `session_ports`，并按 workspace primary port归组清理。
- Quick Chat child 是 cwd 隔离目录；当前代码注释明确其 `--no-tools` 时 cwd 只是 scratch space。
- native 初始 runtime 固定 default tmp + fresh session；native formal session bind 仅在 `NativePiManager::bind_session_id` 的 coordinator in-memory path 有证据，不代表生产 session creation 已接通。

## 4. Environment contract

### 4.1 Legacy required/derived env

| Variable | Evidence | Secret / redaction |
| --- | --- | --- |
| `PATH` | `build_augmented_path()`；启动前 `fix_path_env::fix_all_vars()`；append tool dirs | 可记录 path diagnostics，但不应进入 telemetry；当前日志会打印 path diagnostics，需审计敏感段 |
| `PI_STUDIO_STATIC_DIR` | legacy spawn；embedded server 静态资源定位 | 非 secret；路径日志当前存在 |
| `PI_STUDIO_PORT` | 每个 legacy Pi 监听 port | 非 secret但属于内部 routing；不应成为 native authority |
| `PI_STUDIO_PI_VERSION` | `locked_pi_version()`，编译时读取 `scripts/pi-version.json` | 非 secret |
| `PI_CODING_AGENT_DIR` | `resolve_pi_agent_root()` 创建并 canonicalize；`build_spawn_environment` 最后注入；caller 覆盖拒绝 | 路径为敏感环境信息；不能返回 browser/telemetry |
| `PI_STUDIO_SKILL_INSTALL_SECRET` | `PiManager::new` 生成 32-byte random URL-safe secret，注入每个 legacy Pi | **secret**：代码要求永不日志化/序列化/暴露 browser；契约必须 0600/内存仅限 host→Pi |
| `PI_STUDIO_EPHEMERAL_KIND` | Side/Quick/standby marker | 非 secret；不含 owner/capability |
| `PI_STUDIO_EPHEMERAL_INSTANCE_ID` | ephemeral marker | 当前注释要求不含 capability/owner token |
| `PI_STUDIO_EPHEMERAL_GENERATION` | ephemeral generation marker | 非 secret；是 stale cleanup identity |
| `HOME`（Windows fallback） | 若 host `HOME` 缺失，从 `USERPROFILE` 或 `HOMEDRIVE+HOMEPATH` 注入 | 路径敏感；当前 info log 会打印值，需纳入 redaction 审查 |

`run_pi_command_at` 是另一个 child path：注入 `PATH` 与 `PI_CODING_AGENT_DIR`，不使用 runtime server env；它用于 package management，不能被误归入 interactive runtime launch。

### 4.2 Native current env

`NativeLaunchSpec::command_description` 仅返回：

```text
PATH=<spec.path_env>
PI_STUDIO_PI_VERSION=<spec.pi_version>
```

`spawn` 另外设置 `current_dir`, stdin/stdout/stderr pipes；没有 `PI_CODING_AGENT_DIR`、static locator、skill secret、ephemeral markers、HOME fallback 或 Super Agent marker。此差异是 Gate C 必须解决的明确证据，不是默认继承可接受的替代：`PI_CODING_AGENT_DIR` 的 canonical/unique invariant 已写入 `ARCHITECTURE.md`。

### 4.3 Canonical agent root invariant

legacy：创建目录 → canonicalize → Windows 去 verbatim prefix → 注入 `PI_CODING_AGENT_DIR`；同时拒绝 `PiSpawnSpec.environment` 提供同名变量。这样 Pi 无参 `SessionManager.listAll()` 与 Picot session tree 使用同一 agent root。

native：没有该 env，也没有 `NativeLaunchSpec` environment 字段。**证据缺口/阻断项：** native runtime 如何读取同一 canonical root、如何拒绝 caller override、如何保证所有 runtime type 一致，尚未实现或测试。

## 5. Extension set contract

### 5.1 Legacy

- `embedded-server.mjs`：硬依赖；找不到时 spawn fail-fast。它提供 `/api/*`、`/ws`、静态 server，并在 Pi 同进程调用 Pi API。
- `picot-bridge.mjs`：尝试对每个 desktop spawn 加载；缺失只 warning，session-tree navigation 退化。
- `pi-chat.mjs`：仅 cwd canonical path 命中 Super Agent workspace 时加载，避免多个进程竞争 Telegram updates；缺失 non-fatal。
- 用户/global/project extensions：Pi 自身的 extension discovery/load 行为仍存在；当前 `PiManager` 代码只显式解析上述 Picot-owned extensions。完整用户 extension set 的实际 Pi precedence/flags 需 Pi binary smoke 与 Gate A inventory 复核。

### 5.2 Native

当前 `native_launch_spec` 只显式传 `picot-bridge`。这符合“Pi 不直接监听 Picot HTTP/WS”的目标，但 native manager 没有表达：

- allowed user/project extension set；
- Super Agent `pi-chat`；
- startup/Side/Quick 的 extension policy差异；
- extension path safety/precedence 的独立 resolver。

Gate C 结论：native extension set 必须成为显式 launch contract，不可从 legacy embedded extension loader 侧推。

## 6. Stdio、readiness 与 RPC bridge

### 6.1 Legacy stdio

legacy `PiManager::spawn_with_spec_inner`：stdin/stdout/stderr 全部 piped。

- stdin：保存 `ChildStdin`，`send_rpc` 序列化为一行 JSON + `\n`，写入并返回 write error。
- stdout：逐行读取；无法解析 JSON 的行直接跳过；可解析 payload 通过 `RpcOutput` broadcast。此路径不是 embedded server 的主要事件转发路径，但用于 host 观察 response/model cache。
- stderr：独立线程逐行读取，最多按行传入日志 `[pi-desktop] pi stderr port=...`；读取错误 warning。
- EOF/自然退出：`watch_process_exit` 每 250ms `try_wait`，以 `(port,pid,identity)` 精确匹配后从 map 删除并 broadcast `ProcessExit`。

### 6.2 Native `PiRpcBridge`

`attach` 要求 stdin/stdout/stderr 全 piped：

- writer thread 从 bounded mpsc channel 取 Value，JSON stringify + newline + flush；write/flush 失败时 thread break，但没有直接向 coordinator 发 fatal event 的接口。
- stdout reader thread 读取 bytes，按 newline 分帧；CRLF 去 `\r`；超过 `max_frame_bytes` 的整行转成 oversized sentinel；EOF 或任意 read error 直接结束。
- async parser：oversized → `BridgeFrame::ProtocolError`；invalid JSON → `ProtocolError`；有 matching `id` → resolve pending request；`extension_ui*` → ExtensionUi；其余 → Event。
- parser loop 结束时 drain pending request，统一发 `BridgeError::ProcessClosed`。
- stderr reader 每行最多 4096 chars，放入 bounded diagnostic channel；`NativePiManager` 当前没有消费/广播该 diagnostic channel。

### 6.3 Fatal protocol / EOF 当前行为

`NativePiManager::start_event_pump` 对 `ProtocolError` 只包装成普通事件 `{type:"protocol_error",message}`，继续 event pump；`bridge.next_frame()==None` 时 while 结束，**没有**：

- 设置 coordinator `Crashed`；
- 生成 sequenced crash/snapshot-required event；
- 将 runtime 从 registry 移除；
- 标记 pending operation `Indeterminate`；
- 区分 protocol fatal、EOF、child exit、writer failure。

这是 Gate C 明确的证据缺口。Gate C 设计要求这些触发一致 state transition 与 pending request rejection；当前只有 pending bridge requests 会在 parser EOF 被 reject。

### 6.4 Readiness

legacy：

1. spawn；
2. sleep 500ms 并 `check_exited` fast-fail；
3. `wait_for_health(port,30)` 请求 `/api/health`；reqwest client `.no_proxy()`；status <500 即视为成功；
4. 可选 `/api/sessions` endpoint warm-up 4s；
5. broker register/window open。

standby：`spawn_standby` 通过 TCP connect `127.0.0.1:port`，最多 30s，再确认 exact process identity；这不是 `/api/health` 语义。

native：无 `/health` 或 RPC state probe；spawn 成功后直接 `open_native_workspace_window`。`RuntimeState::Starting` 只有 coordinator 状态，没有从 Pi frame 到 Ready 的实现。**Ready signal 是证据缺口。**

## 7. State、owner/window transition 与 stop ordering

### 7.1 Native coordinator state

`RuntimeState` 已定义八态：`Starting/Trusting/Ready/Working/Idle/Suspended/Crashed/Stopped`。当前实际 transition 证据：

- register → caller 指定 `Starting`（real spawn）或 `Ready`（in-memory test）；
- event `agent_start` → `Working`；
- `agent_settled`/`agent_end` → `Idle`；
- `resume` 可把 `Suspended` runtime 替换为新 instance 的 `Starting`；
- `stop` unregister，但没有先把 state 设为 `Stopped` 的 observable event；
- Trusting/Suspended/Crashed 在真实 process pump 中没有完整触发路径。

Mutation dedupe 是 per-instance `VecDeque`，capacity 至少 1；unregister 后丢失。这与迁移 spec 要求的 host Operation Registry 不同，不能作为 durable crash/reconnect contract。

### 7.2 Owner/window creation

legacy `open_workspace_window`：

1. canonicalize cwd（失败时 fallback lexical PathBuf）；
2. 从 MetadataStore 尝试只读 workspace ID；
3. `create_owner_with_workspace(label,cwd,port,origin,workspace_id,DefaultStartup)`；
4. 生成 capability；通过 Tauri initialization script 注入；
5. navigation 以 owner registry 的 exact origin/pending transition 校验；
6. build WebView。

native `setup_native_runtime`：先建立 HostServer + runtime，再 `open_native_workspace_window`；当前 native window 无 capability initialization script，也使用 `/app/workspaces/:wid/sessions/:sid` experimental namespace。Gate D 已规定 production 应使用 existing `/workspaces/:wid/sessions/:sid`，但当前实现仍是 `/app`，属于未完成迁移证据。

### 7.3 Transition/owner cleanup

legacy window destroy 的代码顺序（`handle_window_destroyed`）：

- native label：`NativePiManager::stop_workspace` 后 return；没有 owner/ephemeral/skill source cleanup 共同路径。
- legacy workspace label：kill dedicated；kill primary；broker unregister port；revoke skill source port。
- owner cleanup：按 owner generation leases 处理 ephemeral route；clear/revoke相关 owner state；最终 owner revoke（后续代码需与完整函数继续核验）。

`EphemeralRegistry` 通过 owner + instance + generation + port/child identity 做 cleanup lease；broker 在 kill child 前先 disable/unregister dedicated ephemeral upstream，避免 reconnect loop 复活。transition 的 Side Chat cleanup 按 `transition_generation`，Quick Chat replacement 先创建 candidate，成功后再处理 old record。

**全局 stop order 的正式规范仍缺：** app exit 中 native `stop_all` 与 legacy `kill_all_standby`/manager cleanup 的跨模块顺序需继续审计；native stop 是否等待 child exit、是否清理 pending UI/operations、是否撤销 capability，当前无完整契约。

## 8. Crash、restart、EOF 与 rollback

### 已证据化

- legacy immediate exit 在 startup health 前由 `check_exited` 发现并返回 status；stderr 已由 pipe logger 记录。
- legacy natural exit 发 `ProcessExit`；broker/ephemeral caller 可按 exact process identity 清理。
- legacy `SIGKILL` 不触发 `RunEvent::Exit`，架构文档明确可能留下 orphan Pi/port。
- native bridge EOF 会 reject pending bridge requests；native event pump 随后静默结束。
- native `RuntimeCoordinator::resume` 只提供内存状态下 suspended→新 instance 的原语。

### 证据缺口

- legacy 是否对所有 `ProcessExit` 自动 restart：未发现统一 restart policy；不能假定自动重启。
- native child exit observer、crash event、snapshot-required、restart backoff、operation indeterminate：未实现。
- window reload/reconnect 后 native runtime adoption/recovery：未实现。
- host restart 后 runtime 是否重建、旧 operation 如何标记：未实现。
- rollback 时已启动 child、新增 settings/schema、静态 cache 的处理：属于 Gate D/P8，当前文件未证明。

## 9. Ephemeral、standby、Side/Quick Chat 生命周期

### 9.1 Legacy state machine evidence

`EphemeralRegistry` owner 分区：Side/Quick 各自 record；Side quota=1，Quick 同时最多一个。状态：`Creating → Ready ↔ Streaming → Closing`，并含 `Replacing`/`Failed`。所有 public mutation 先校验 owner、instance、generation。

创建/替换关键规则：

- reservation 先占 quota，再 spawn/health；失败必须释放 reservation 与 temp resource；
- Quick replacement 同时保留 old `Replacing` 与 new `Creating`；candidate 失败时恢复 old；
- cleanup lease 绑定 port、pid、child identity、transition generation、temporary directory/token；
- owner/window close 将记录置 `Closing`，然后 host 清 route/kill child/remove temp；
- standby warm 有 generation lease，transition cancel 不得把旧 worker 的 child park 回 pool；TTL 300s；自然 exit 与 app exit 清 Quick child。

### 9.2 Native gap

当前 native manager 没有 standby pool、ephemeral registry integration、Quick child creation/cleanup、Side quota、owner route、temporary runtime policy。现有 legacy helper/tests 可作为行为证据，但不能证明 native 已实现。Gate R 还要求 default startup tmp 与 Quick child 都是 `Temporary`，不得伪造 workspace ID；当前 native 随机 `native-*` ID 违反该 authority contract。

## 10. OAuth generation cleanup

仓库 architecture/spec 记录 Pi-owned OAuth seam：`ModelRuntime.login(providerId,"oauth",interaction)`，capabilities/start/cancel/status/logout 需要 desktop-owner-only、绑定 Pi process generation，token 不出 WebView。

本次目标 Rust 文件中未找到 OAuth runtime operation implementation；`main.rs` 无 OAuth handler，`host_server.rs` capability response 当前明确 `oauth: false`。因此：

- **当前可证据化：** native host 不提供 OAuth；不会从这些文件推导 token persistence、cancel、generation cleanup。
- **证据缺口：** OAuth operation 与 runtime generation 的绑定、owner revoke/cancel、child exit cleanup、logout credential deletion、crash recovery。
- 不得把 `PI_STUDIO_EPHEMERAL_GENERATION` 或 coordinator instance ID 宣称为 OAuth generation；两者没有代码绑定。

## 11. Platform process-tree policy

### Windows

`PiManager` 与 `NativePiManager` 都仅设置 `CREATE_NO_WINDOW (0x08000000)`，防止 GUI app 派生 console window。没有发现 Pi child 的 Job Object 创建、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、AssignProcessToJobObject 或 descendant termination。`terminal_manager.rs` 有独立 Job Object 实现，但不能推断 Pi runtime 已复用它。

**Contract gap：** native/legacy Pi runtime 必须定义 Job Object ownership、spawn failure rollback、kill escalation、handle close 顺序；当前只能记录“direct child hide-console”。

### Unix

目标设计要求 process group + kill escalation，但 `pi_manager.rs` 的 Pi spawn 没有 `pre_exec(setpgid)` 或 `killpg`；`pi_rpc_bridge.rs` 也没有。`git_service.rs`/`git_pi_runner.rs` 的 Unix process-group 代码属于其他子进程，不能移植为 Pi 证据。

**Contract gap：** Pi process group/session 创建、SIGTERM→deadline→SIGKILL、descendant cleanup、group identity validation 均未实现。

## 12. Secrets、logs 与 redaction

已证据化：

- skill install secret 由 `OsRng` 生成，注入 Pi；architecture 要求不日志化/序列化/暴露 browser；
- ephemeral env marker 明确不携带 capability/owner token；
- `PiRpcBridge` stderr diagnostic 有 4096-char 单行上限，但不做 token/path redaction；
- legacy stderr logger 将原始 stderr 行写入 error log；startup error 传入 bootstrap window URL query（`main.rs::open_bootstrap_window`），需防止错误内容含 secret；
- native launch error 只包含 spawn error，stderr diagnostics 当前未并入 window/error event。

风险/缺口：

1. 日志可能包含 cwd、HOME、PATH、extension path；当前若干 `log::info!` 会打印它们。
2. `format_pi_stderr_log_line`/native diagnostics 没有统一 redactor。
3. capability、OAuth token、skill secret 的全链路“禁止日志/URL/telemetry/crash”没有统一测试。
4. stdout invalid JSON 的 error message 可包含上游 parser 文本；需分类后再向 client 暴露。

## 13. Gate C 必须锁定的终态契约（待实现，不冒充现状）

以下项目来自 Gate C spec，当前尚未全部被代码证明：

1. 每种 runtime type 使用统一 `LaunchDescription`：binary resolver、ordered args、canonical cwd/session/no-session/no-tools、explicit extension set、required env、owner/generation binding。
2. native 不能依赖 legacy manager 的 launch side effects；尤其是 agent root、secret、path normalization、Super Agent policy。
3. ready 必须是可验证 RPC state/health equivalent；spawn success 不是 Ready。
4. EOF、child exit、writer failure、fatal protocol frame 必须原子进入 `Crashed`，reject pending，mark operations indeterminate，发 sequenced crash/snapshot-required event。
5. stop order：停止 admission → revoke route/subscription/capability → cancel/settle UI/operation handles → disable upstream → terminate process tree → await/reap → delete ephemeral child → unregister state；每一步要有 exact identity/generation guard。
6. Windows Job Object、Unix process group/escalation 必须是 Pi runtime 自己的实现/测试，不借用 terminal/git runner 的间接证据。
7. temporary default tmp 与 Quick child 必须是 `Temporary` snapshot；Registered-only v2 route/target 不得接纳它们。
8. OAuth generation cleanup 必须由实际 OAuth implementation 与 Pi process generation 共同证明；当前 `oauth:false` 是未实现，不是 allow。
9. crash/restart/reconnect/rollback 必须定义 durable operation 与 user-visible snapshot semantics；当前 per-instance mutation deque 不够。

## 14. Test matrix

| Area | Legacy current evidence | Native current evidence | Gate C required test |
| --- | --- | --- | --- |
| args order | `pi_manager` `build_pi_args` tests；extension append tests | `NativePiManager` launch description test | every runtime type exact argv snapshot；extension order/flags |
| binary/path | resolver tests、Windows strip comments | reuses PiManager resolver indirectly | standalone native resolver；spaces/Unicode/`\\?\` paths |
| agent root | env tests reject override + canonical root | absent | canonical root injected all types; override rejected; session list same tree |
| env/secret | ephemeral marker + install secret tests | PATH/version only | required env allowlist; secret never log/URL/frame; redaction fixture |
| extension set | embedded hard fail, bridge optional, pi-chat conditional | bridge only | primary/dedicated/Side/Quick/standby/Super Agent set snapshots |
| ready | health, endpoint warmup, standby TCP | absent | real Pi RPC readiness; timeout/fatal startup; no false Ready |
| stdout protocol | legacy JSON line observation | bridge unit + real subprocess | EOF, malformed, oversized, fatal frame, writer failure; pending rejection |
| stderr | port-context logger | bounded diagnostic channel unused | redaction, bounded output, bootstrap error safe |
| child exit | exact `(port,pid,identity)` watcher | no watcher | crash event, state, operation indeterminate, stale child cannot kill replacement |
| stop | legacy window/app/standby cleanup tests | `stop_workspace/stop_all` basic | ordered stop trace; await/reap; repeated stop; owner revoke |
| process tree | no Pi group/Job evidence | no Pi group/Job evidence | Windows Job Object; Unix process group and escalation |
| session | primary/dedicated/fork/switch callers | temporary bind unit test only | real Pi primary/dedicated/fresh/no-session/fork/switch |
| Side Chat | quota/lease/standby tests | absent | native owner quota, transition cleanup, standby replacement |
| Quick Chat | 0700/token/symlink/root cleanup tests | absent | native child create/delete, root delete guard, restart no adoption |
| OAuth | host advertises false; no Rust flow | absent | capability/start/cancel/status/logout × generation/owner/crash |
| Windows | hide console/path normalization | hide console only | spaces, HOME, job tree, binary/extension path |
| Unix | direct child kill only | direct child kill only | process group kill and descendant cleanup |
| rollback | no runtime rollback implementation | debug-only flag | N/N-1 DB/settings, running child, cache, flag fail-closed |

## 15. Evidence-gap register

| ID | Gap | Why material |
| --- | --- | --- |
| C-GAP-01 | Native agent root/static/secret env absent | session identity and internal install auth can diverge |
| C-GAP-02 | Native ready signal absent | window can open before runtime is usable |
| C-GAP-03 | Native child exit/EOF/writer/protocol fatal not stateful | silent dead runtime; pending operations ambiguous |
| C-GAP-04 | Native manager lacks dedicated/Side/Quick/standby launch paths | launch contract not universal |
| C-GAP-05 | Pi Windows Job Object absent | descendant leakage on stop/crash |
| C-GAP-06 | Pi Unix process group absent | same leakage on Unix |
| C-GAP-07 | OAuth Rust lifecycle absent and host reports `oauth:false` | no generation cleanup or token flow evidence |
| C-GAP-08 | native random workspace ID + root map bypasses registry authority | Temporary incorrectly looks like Registered target |
| C-GAP-09 | owner/window native destroy returns before common cleanup | capability, ephemeral, pending state may outlive window |
| C-GAP-10 | no unified redaction contract/tests | secrets/path/error leakage risk |
| C-GAP-11 | no restart/rollback policy | release migration cannot be safely reversed |
| C-GAP-12 | legacy user/project extension loading precedence not fully extracted here | extension set parity cannot be claimed from explicit flags alone |

## 16. Verification record

只读检查完成：

- 阅读 Gate C 设计、native migration plan、migration inventory、`AGENTS.md`、`ARCHITECTURE.md`、`docs/engineering-lessons.md`。
- 检查 `pi_manager.rs`、`native_pi_manager.rs`、`runtime_coordinator.rs`、`pi_rpc_bridge.rs`、`main.rs`、`window_owner.rs`、`host_server.rs`、`host_router.rs`、`ephemeral_registry.rs` 相关实现与测试。
- 检查当前 working tree；保留所有既有 dirty code/spec/tool 文件，未修改 Rust/JS production code。
- 未运行写入型命令；未运行完整测试套件。本文为文档交付，未声称测试通过。

## 17. 推荐 Gate C exit review 顺序

1. 先 review C-GAP-01/02/03：它们决定 native manager 是否能承担 runtime authority。
2. 再 review C-GAP-04/05/06/08/09：覆盖全部 runtime type、process tree、temporary identity、owner stop order。
3. 以 §14 matrix 建立 failing tests，再实现最小 launch/lifecycle substrate。
4. 真实 embedded Pi smoke 覆盖 primary、dedicated、Side、Quick、standby 与 Windows/Unix；测试环境无法提供的平台证据必须标记为未验证，不得以 compile 替代。
5. Gate C 通过前，不删除 `PiManager`、不改变 production origin/route，不把 debug native flag 宣称为 rollout。
