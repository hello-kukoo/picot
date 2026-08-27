# Picot Native Runtime 迁移设计（embedded-server 退役）

> 状态：**修订草案，阻塞项待拍板**。本稿取代此前 P0–P8 直接实施版本。
> 修订 R3.1（2026-08-27）：在 R3 基础上同步实施计划审计结论——固定 `shared/mutation-types.json` 的 14 项当前 baseline 与单一来源地位；细化 OAuth native process generation 生命周期；将入/出站载荷边界测试和 N-1 recovery release gate 写为验收要求。R3 的 Gate R、namespace、Operation Registry、turn-bound abort、P3 adapter、Cost compatibility 与 D1–D10 定案不变。
>
> **开工门槛：** Gate R、Gate A–D 全部通过、§16 的决策全部落定前，禁止开始任何会改变生产启动路径、WebView origin、认证链、spawn 路径或路由行为的实现。允许做仅验证现状的只读盘点与测试基建。
>
> 前置阅读：
>
> - `ARCHITECTURE.md`：现有三条通信路径、LAN/loopback 边界、窗口 owner、Pi launch 不变量；
> - `docs/engineering-lessons.md`：adapter cancellation、workspace transition、真实路径验收；
> - `docs/superpowers/specs/2026-08-26-workspace-registry-design.md`：workspace ID、注册表与 DB 迁移边界；
> - `src-tauri/src/{main.rs,window_owner.rs,broker_ws.rs,host_server.rs,host_router.rs,native_pi_manager.rs,runtime_coordinator.rs,pi_manager.rs,pi_rpc_bridge.rs}`；
> - `extensions/{embedded-server.ts,request-access.ts,picot-bridge.ts,path-safety.ts}`。

---

## 1. 结论、背景与范围

### 1.1 结论

Picot 的目标架构仍是正确的：**Rust host 作为唯一网络入口和授权边界；Pi 进程仅作为 stdin JSONL RPC runtime；`embedded-server.ts` 与 legacy `PiManager` 最终退役。**

此前设计将这条终态误写成可从“兼容反代 → origin 切换 → 路由逐迁 → 删除”线性推进的工程。代码审计证明该前提不成立：native runtime 目前是 debug-only 验证路径，native UI 非功能等价，host WS 未接入 Native owner capability，host 与 legacy broker 存在两套协议，且 `PiManager` 仍持有多数 launch/lifecycle 契约。

所以本设计改为：先完成四个前置 Gate，建立权威协议、身份、生命周期与 UI 策略，再进入分阶段迁移。**不以“能发一条聊天消息”视为 origin 迁移成功。**

### 1.2 当前双轨状态（截至本稿修订）

| 组件 | 当前作用 | 迁移意义 |
| --- | --- | --- |
| `extensions/embedded-server.ts` | Pi 进程内 HTTP/WS server、静态资源、API routes、聊天 RPC bridge、Pi API 调用 | 最终删除；它的每一个外部表面必须先迁移或显式退役 |
| `src-tauri/src/pi_manager.rs` | legacy Pi spawn、port 路由、agent root、extension/env 拼装、standby/ephemeral、health、Pi 子命令等 | 最终删除或拆分；不能仅复制主 session spawn |
| `src-tauri/src/broker_ws.rs` | 现生产 WebView 的 broker protocol v1；`VerifiedClientContext { Native, Remote }`；owner-scoped controls | 生产控制面的既有权威入口；要么迁入 host v2，要么在 host-origin 阶段继续运行并做适配 |
| `src-tauri/src/host_server.rs` | axum host；静态服务、`/health`、`/v2/ws`、`/v2/bootstrap`、remote pairing exchange | 仅 debug 且 `PICOT_RUNTIME=native` 时启动；非 release 生产入口 |
| `src-tauri/src/host_router.rs` | host protocol v2 frame router | 与 broker protocol v1 并存，当前仅区分 `Desktop/Remote`，不验证 desktop owner capability |
| `src-tauri/src/native_pi_manager.rs` | RuntimeTarget、in-memory tests、单条 native process spawn/event pump | 只覆盖最小 native path；不等价于 `PiManager` |
| `src-tauri/src/runtime_coordinator.rs` | target identity、状态、event sequence、idempotency cache | 有 8 态模型；尚未覆盖完整 crash/owner/lifecycle 契约 |
| `extensions/picot-bridge.ts` | thin Pi extension：navigateTree/reload/projectTrust | 终态保留；如需增能力必须另行审计 Pi extension API |
| `public/native/*` | host v2 的实验性 UI shell | 已由 `public/bootstrap-entry.js` 在 `/app/` 前缀条件加载；**不是完整 UI** |

### 1.3 当前 native runtime 可达性

```rust
fn native_runtime_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PICOT_RUNTIME").is_ok_and(|v| v.eq_ignore_ascii_case("native"))
}
```

因此，当前 release 100% 仍走 legacy stack。任何“终态已经部分上线”“P2 只需 feature flag”说法均不成立。把 host runtime 带入 release 本身是一个单独交付物，必须在 §13 的 rollout 中验证。

### 1.4 目标

1. **唯一网络入口**：Rust `HostServer` 服务桌面、配对 remote/LAN 的静态资源、HTTP 大 payload 与 WS；Pi 不监听 Picot HTTP/WS port。
2. **唯一 runtime manager**：所有 Pi runtime 由 native lifecycle manager 根据同一 launch contract 派生、观察、终止和回收。
3. **单 origin 路由**：桌面 WebView 使用 host origin；workspace/session 由 opaque ID 路由，不由 Pi port 或浏览器绝对路径表达。
4. **权限收敛**：Native desktop、paired remote、unpaired browser/LAN 的权限由 host 验证的 context 决定；浏览器载荷不携带权威 cwd、session path、OID、diff 或 owner。
5. **无功能缩水迁移**：任意启用 host-origin 的用户保持当前功能与关键错误语义；不把 UI 重写夹带进 runtime 迁移。
6. **可观测、可暂停、可回滚**：每阶段有 release-independent 验收、版本化 telemetry、真实升级/降级演练和停止条件。

### 1.5 非目标

- 不改 Pi stdin RPC wire format，除非 embedded Pi 版本升级单独决策；
- 不把 Rust 改造成 Pi runtime 逻辑复刻；Pi session/model/tool 语义仍归 Pi；
- 不在本稿中实现 workspace registry 的 UI/DB command。本稿只依赖它已提供的 canonical `workspaceId ↔ root` lookup；
- 不改变 session delete 的产品语义；当前 **trash-first + running protection** 必须保持；
- 不以 runtime migration 改写 UI 信息架构、视觉或交互；
- 不把 LAN 当作 CORS 问题；CORS 不是认证；
- 不在未经单独评审下扩大 `picot-bridge.ts` 权限面。

---

## 2. 终态架构与不变量

### 2.1 终态图

```text
┌──────────────────────────── Host origin ────────────────────────────┐
│ Desktop WebView / paired remote client                               │
│  existing shell: /workspaces/:wid/sessions/:sid                      │
│  experimental native shell: /app/workspaces/:wid/sessions/:sid       │
│  WS:     /v2/ws (canonical protocol)                                │
│  HTTP:   /v2/paste-offload, /v2/files/raw, /v2/session-export/:id   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ authenticated HostClientContext
┌──────────────────────────────────▼──────────────────────────────────┐
│ HostServer + HostRouter                                               │
│  - Desktop capability / remote device-token validation                │
│  - owner/workspace/generation derivation                              │
│  - authorization, target resolution, size limits, audit/log redaction│
│  - static assets + HTTP binary/download surfaces                      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ RuntimeTarget + canonical command
┌──────────────────────────────────▼──────────────────────────────────┐
│ NativeRuntimeManager + RuntimeCoordinator                             │
│  - launch contract, process/exit lifecycle                            │
│  - state/event sequencing, idempotency, reconnect/snapshot           │
│  - owner transition and ephemeral cleanup                             │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ stdin/stdout JSONL only
┌──────────────────────────────────▼──────────────────────────────────┐
│ Pi --mode rpc --extension picot-bridge.mjs                            │
│  - Pi runtime/session/model/tool behavior                             │
│  - thin bridge only; no Picot HTTP/WS/static server                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 不变量

1. **Pi runtime 不直接服务 Picot 网络面。** 终态无 `embedded-server.mjs`、无 Pi port origin、无 browser→Pi HTTP。
2. **唯一 canonical client protocol。** 不允许 P8 后同时保留未文档化的 broker v1 与 host v2 行为分叉。
3. **浏览器提交的 target 不是授权。** target 必须经过 host context 的 owner/workspace/generation 验证；不从 payload 信任 cwd、port、session path。
4. **desktop capability 与 remote device token 是不同凭证体系。** 前者是 per-window、内存态、可撤销；后者是配对 device 的持久凭证。不得复用 `/v2/auth/exchange`。
5. **workspace identity 的唯一真相是 registry/host metadata。** `workspaceId` 必须能解析到 canonical root；不能由 URL path、session header 或前端 cache 自行决定。
6. **删除仍 trash-first。** migration 不得升级为永久删除；runtime running protection、逐项结果、二次确认继续存在。
7. **settings 资源逐个保留现有副作用。** 例如 models save 后的 model registry refresh、skills proper-lockfile、secret file 0600、telegram secret redaction，均不能被“改成 Rust control”抹掉。
8. **所有大 payload 明确走 HTTP。** WS 不承担文件二进制/大粘贴/导出流；进度帧不等于无界 streaming channel。WS 物理帧上限（16 MiB，与 `MAX_RPC_FRAME_BYTES` 对齐）是传输层约束而非业务许可——v2 command 面另设 1 MiB 业务上限（§7.1）。
9. **每个 runtime 都受 launch contract 约束。** 主 session、dedicated、Side/Quick Chat、standby、Pi chat/Super Agent 等不得存在另一套未审计 spawn path。

---

## 3. Gate R、A–D：实施前置条件

> Gate 是设计和验证阶段，不是代码命名。每个 Gate 产出都必须 review 通过并成为后续实现的验收输入。

### Gate R — Workspace Registry / Preferences external readiness

本迁移依赖 2026-08-26 workspace registry 设计，但不拥有其 UI/DB 实现。此前把该依赖写在 D5/D10 而未标为阶段前置，会使 P1 的 `HostDataPlane` authority 收敛和 P3 的 release flag 无法排程。故 registry 是**外部交付 gate**，不是“迁到时再补”的 helper。

Gate R 的交付必须来自 workspace-registry 方案并在本分支可用，至少包括：

```text
workspace_id_for_canonical_root(root) -> WorkspaceId
canonical_root_for_workspace_id(wid) -> CanonicalRoot | not_registered
owner_current_workspace(owner) -> { wid, root, generation }
pref_get("runtime.native_origin") -> Option<bool>
```

要求：

- inverse lookup 只读、canonical、无浏览器 supplied root 回退；`HostDataPlane`、P1 target resolver 与 P3 flag reader 必须只能经该 contract 表达，不能继续持有启动期 `HashMap<wid, root>`，更不能以 URL path 或 browser root 作为 authority 回退；
- 明确 `~/.pi/tmp` / 未注册但存活 runtime 的身份、可见性与跨重启策略。它不得以临时 Map 变成跨窗口/跨重启 authority；
- owner current workspace 把 `wid/root/generation` 作为同一原子快照返回，不允许 host 分别读取 cwd、port、generation 后拼接；
- preferences 可在 Rust **launch time** 读取；flag 读失败时 fail closed 为 legacy origin；debug env 只能覆盖开发构建，不能成为 release storage；
- registry schema/version policy 与 N-1 binary 兼容策略已定义（见 §13.2）；
- Gate R 的 release must-run 覆盖：fresh DB、旧 DB 升级、缺 workspace、目录消失、未注册 tmp workspace、N→N-1 恢复。

#### Gate R exit criteria

- workspace registry 的 schema/API/测试已经合入或作为明确版本化依赖可用；
- HostDataPlane adapter、P1 target resolver 和 host flag reader 可仅以这些 API 表达，不需要裸 root map、URL path 或浏览器路径；
- 未注册 temporary runtime 的 identity、visibility 与 recovery policy 已定义并测试；
- N-1 schema compatibility/backup/recovery 方案已演练；
- P1、P3 的 dependency 列显式引用 Gate R。

### Gate A — 权威 surface / caller 迁移矩阵

#### 问题

此前仅枚举“29 个 API”，实际表编号为 30，且遗漏 Cost Dashboard、search、全局 AGENTS/APPEND_SYSTEM、embedded `/ws` 以及大量非 `/api/rpc` 调用方。手工列表不可作为 P8 删除依据。

#### 必须产出

生成版本化矩阵（建议 `docs/superpowers/specs/...-migration-inventory.md`，或纳入本文件附录），数据由脚本从下列入口提取、人工复核：

- `embedded-server.ts::handleApiRoute` 的 `method + normalized path`；
- `embedded-server.ts::handleCommand` 的 command、响应、stream event（注意：OAuth login 面——`get_oauth_login_capabilities` 等——是 `/ws` command 而非 HTTP 路由；提取脚本必须解析 command 分发结构，不可只 grep `urlPath ===`）；
- `/ws` upgrade 与 browser connection；
- `public/`、HTML、tests、外部脚本、LAN client 对 URL/command 的调用；
- `BrokerWs` 全部 controls；
- host v2 `runtime/data/host/auth` frames。

矩阵每行必须有：

| 字段 | 含义 |
| --- | --- |
| legacy surface | method/path 或 WS command/event |
| callers | 生产调用方；不得只写模块名 |
| legacy authority | Pi ctx、agent root、owner registry、payload 等 |
| current class | loopback / Native / Remote / LAN read-only / ephemeral forbidden |
| terminal surface | host HTTP / canonical WS / explicitly retired |
| terminal authority | owner-derived root、registry、runtime target、token binding |
| phase | 何时实施和何时删旧入口 |
| compatibility | response、error、async/progress、side effect 是否保持 |
| tests | 单元、integration、real Pi、manual / platform |
| deletion proof | 如何证明没有生产 caller |

#### Gate A exit criteria

- 所有 endpoint、WS command/event 与生产 caller 都有一行；
- `grep`/AST 输出与矩阵差异为零或已审计 exception；
- `host_data.rs` 已实现的数据能力标为“已实现”，不重复规划；
- P8 removal checklist 引用每行 ID，而非“grep 某一个字符串”；
- matrix review 人可从任一 caller 反向找到终态归宿。

### Gate B — canonical protocol、desktop capability、LAN deployment

#### 问题

当前有两套不等价协议：

| 协议 | 当前入口 | 版本 | 认证语义 |
| --- | --- | --- | --- |
| legacy broker | `BrokerWs` / `broker_control` | v1 | native owner capability 或 remote flow，产生 `VerifiedClientContext` |
| host runtime | `HostServer /v2/ws` | v2 | desktop hello 无 capability 验证；remote 验 device token |

P2 不得将它们混称“broker_control”。必须先决定 canonical protocol 与 adapter 生命周期。

#### 决策（本稿默认建议）

**Canonical protocol = host `/v2/ws` v2。** legacy broker v1 在过渡期仅作为已存在 controls 的 server-side adapter，不能让 host-origin WebView 同时自行连接两条未经统一授权的 WS。若实现成本证明 v2 接管 controls 不可接受，必须另起设计，明确“host origin + broker v1 adapter”如何认证、路由、升级和删除；不能隐式双连。

#### Desktop capability 设计

1. `open_workspace_window` 创建 owner 并 mint capability；此 capability **不使用** `RemoteAuth::exchange`。
2. capability record 至少绑定：
   `{ ownerId, windowLabel, workspaceId, workspaceGeneration, issuedAt, expiresAt? }`。
   capability 只能作为 owner lookup key，不能让 caller 自报这些字段成为授权依据。
3. capability 仅经 Tauri initialization script 注入 top-level host-origin document；不得出现在 URL/query/hash、日志、静态 HTML、HTTP response、clipboard、crash telemetry、remote bootstrap。
4. v2 hello：

```jsonc
{
  "type": "hello",
  "protocolVersion": 2,
  "clientType": "desktop",
  "clientId": "opaque-client-instance",
  "desktopCapability": "opaque-bearer"
}
```

1. host 验证 capability 后创建不可伪造的 `HostClientContext`：

```text
HostClientContext {
  class: NativeDesktop | PairedRemote | UnpairedBrowser,
  client_id,
  owner_id: Option<OwnerId>,
  workspace_id: Option<WorkspaceId>,
  workspace_generation: Option<u64>,
  device_id: Option<DeviceId>
}
```

1. capability 在窗口 destroyed、owner revoke、workspace generation 超出 scope、host restart 后失效。host restart 的桌面重载必须由 window lifecycle 重新注入新 capability；不持久化 capability。
2. navigation gate：同一 host origin 允许的仅为绑定 workspace ID 的路径前缀和明确 app-global path；`about:srcdoc`/`about:blank` 依当前安全规则受限允许。不得仅因“host 相同”允许任意 `/app/workspaces/:wid`。
3. `WindowOwnerRegistry` 必须显式增加 owner→workspaceId 及 generation lookup；不可把 `HostDataPlane` 的 `workspaceId→root` Map 误写成 registry 已有字段。

#### Remote / LAN deployment 设计

HostServer 当前只能 bind `127.0.0.1:0`。在 release 启用 LAN 前，必须单独实现和验证：

- bind policy：默认 loopback；用户显式启 LAN 后才 bind approved interface；
- QR URL、地址改变、端口占用、防火墙失败的 UI/error；
- `/v2/auth/exchange` 仅处理 pairing token→device token；token storage/revoke 保持 RemoteAuth 语义；
- pairing 前允许的 surface；配对后可见 runtime/workspace 范围；
- NativeDesktop / PairedRemote / UnpairedBrowser 的完整 command matrix；
- WebSocket subscription 必须在 subscribe 时验证 target visibility，不能只看 `subscriptions.contains(target)`；
- Host、Origin、CORS、DNS rebinding、proxy、non-loopback peer handling；
- owner disconnect、device revoke、network reconnect、runtime crash 后的安全行为。

默认权限基线：

| 操作类别 | NativeDesktop | PairedRemote | Unpaired browser/LAN |
| --- | --- | --- | --- |
| 静态资产、health | allow | allow | allow |
| 已授权运行时只读 snapshot/event | allow | 明确 allowlist 后允许 | deny |
| prompt/steer/abort | allow | 产品矩阵明确后允许 | deny |
| workspace/session route change | allow | 默认 deny | deny |
| Git、Terminal、system open、picker、package、skill install、config write、file write | allow + owner | deny | deny |
| 全局 registry/preferences | allow + owner | deny | deny |

#### Gate B exit criteria

- canonical protocol decision 及 v1 adapter/deletion strategy 已写入；
- capability lifecycle、wire schema、redaction、tests 已定；
- LAN deployment 和 command matrix 已定；
- host runtime subscription/target authorization 有可测设计；
- legacy `VerifiedClientContext` 与 `HostClientContext` 的迁移映射明确；
- no/invalid/expired/cross-owner/cross-workspace capability 与 remote impersonation tests 已列为必做。

### Gate C — Pi launch / lifecycle contract

#### 问题

`NativeLaunchSpec` 只表达最小 binary/cwd/session/extensions/PATH/version；`PiManager` 仍承担 agent root、secret、standby、ephemeral、health、clean-up、Windows 等关键职责。P8 不能靠“迁入残余能力”关闭这项风险。

#### 必须产出：launch contract

每个 runtime type 形成一行不可省略的 contract：

| Runtime type | cwd/session | extension set | required env | owner/generation | ready signal | stop/cleanup | special cases |
| --- | --- | --- | --- | --- | --- | --- | --- |
| primary workspace | canonical registry root / optional resume | `picot-bridge` + allowed user/project extensions | PATH、PI version、canonical agent root、static/resource locator、secret | owner + generation | RPC state/health equivalent | window exit / app exit | process crash/restart |
| dedicated session | owner workspace / session path | 同 primary | 同 primary | owner route | session bound | session close | switch/fork |
| Side Chat | canonical owner workspace / ephemeral session | approved extension set | ephemeral identity/profile | owner + generation | ready + profile applied | transition/close | max one / standby |
| Quick Chat | secure temp root / no session | no-tools restrictions | temp capability and 0700 root | owner + generation | ready | remove validated temp dir | replacement and standby |
| standby | matching intended cwd/flags | exact adoptable set | placeholder ephemeral binding | no public owner until adopted | ready | TTL/consume/kill | cannot leak placeholder |
| Super Agent / pi-chat | explicit source workspace/session | explicit | secrets/log redaction | documented | explicit | bounded cleanup | external service/process |
| Windows path variant | every above | every above | every above | every above | every above | job/process group | spaces, verbatim paths, child tree |

每行再记录：binary resolver、args ordering、session/no-session flags、stdio piping、stderr log handling、timeout、health/snapshot probe、exit observer、restart policy、telemetry fields、test fixture。

#### lifecycle requirements

- `bridge.next_frame() == None`、child exit、writer failure、protocol frame error 的 state transition 与 pending request rejection 必须一致；
- `RuntimeState` 采用现有八态：`Starting/Trusting/Ready/Working/Idle/Suspended/Crashed/Stopped`；状态表定义每个 transition 与触发事件；
- crash 不得只让 WS 无消息；必须广播 sequenced crash/snapshot-required 信号；
- workspace transition、owner revoke、window destroyed、app exit 的 stop order 必须避免 stale ephemeral、standby 或 secret handle；
- Windows 必须定义 process-group/Job Object；Unix 必须定义 process group 与 kill escalation；
- launch description tests 固定 args/env；真实 Pi smoke 覆盖每个 runtime type。

#### Gate C exit criteria

- 所有现有 `PiManager` spawn/call sites 归入一条 launch contract；
- native manager 有不依赖 legacy manager 的 launch description；
- child exit、crash、cleanup、Windows path、ephemeral replacement 都有 tests；
- `PI_CODING_AGENT_DIR`、skill-install secret、static assets、PATH、Pi version 等环境变量均有明确终态 owner；
- P8 删除 `PiManager` 的每个 symbol 有替代项和测试。

### Gate D — UI parity、origin 与发布策略

#### 决策（本稿默认推荐）

**P3 host origin 使用 existing shell：`/workspaces/:wid/sessions/:sid` → `public/index.html` + `public/app.js`。** 它不得使用 `/app/` 前缀。

理由：`bootstrap-entry.js` 当前把任意 `/app/` 路径导向 `public/native/app.js`，而 native shell 不是完整 UI。若 existing shell 继续使用 `/app/workspaces/...`，P3 会静默进入被冻结的 experimental shell，直接推翻 UI parity、回滚和验收前提。

路由命名空间固定如下：

| 路径前缀 | entry | 生命周期 |
| --- | --- | --- |
| `/workspaces/:wid/sessions/:sid` | existing `index.html` → `app.js` | P3–P8 production host-origin entry |
| `/app/workspaces/:wid/sessions/:sid` | `index.html` → `native/app.js` | experimental；不纳入 migration parity |
| `/app/settings` 等 native-only route | native shell | experimental；不承载 production settings |

`bootstrap-entry.js`、host static fallback、window URL、navigation allowlist、capability route binding、smoke fixtures 必须以这张表为单一来源。若日后 native shell 要成为 production entry，必须另立 UI parity 设计；不得修改此迁移的 D1 语义。

#### native shell 处置（迁移期冻结）

`bootstrap-entry.js` 的 `/app/` 分支在迁移期内标记 experimental：UI parity matrix **不包含** native shell；仅保留「加载不白屏」冒烟。P3–P7 的 PR 禁止向 `public/native/*` 增加功能（bug fix 除外，且须注明不扩大能力面）；native shell 的功能化是迁移完成后的独立项目。

#### UI parity matrix

无论选何种入口，host-origin flag 下以下能力必须逐项保持，且给出 caller、transport、manual/E2E 验证：

- 主聊天：prompt/steer/follow-up/abort/compact/model/thinking/slash commands；
- stream：message/tool/thinking/event ordering，reload/sequence gap snapshot；
- session：new/switch/fork/edit/tree/export/rename/delete trash-first/restore error；
- sidebar、Focus、workspace transition、file tree；
- file preview/editor/raw image/PDF/MarkItDown/conflict save；
- Git/Git History、Terminal、system open；
- Side Chat、Quick Chat、ephemeral owner lifecycle；
- settings：models/OAuth/skills/packages/config/AGENTS/APPEND_SYSTEM/chat/Telegram；
- cost/search/Super Agent; LAN/mobile where policy allows；
- i18n, theme, accessibility, keyboard/IME, startup/reconnect/error windows。

#### release / rollback policy

- feature flag 有唯一 source of truth：Gate R 交付后的 preferences `runtime.native_origin`。Rust 在 launch time 读取一次；读不到、DB schema 不兼容或值无效均 fail closed 为 legacy。debug env 仅可覆盖 debug/developer build，release 不读取它；
- flag 默认 false，先 dogfood，再 opt-in cohort；至少两个稳定 release 周期及完整 telemetry/bug 门槛才可考虑 default-on；
- telemetry 只记录 anonymized state：flag state、protocol version、route family、failure code、latency bucket；不得记录 capability、prompt、path、token；
- host runtime release artifact、embedded binary/resource resolution、code signing、Windows/macOS firewall 进入 release smoke；
- `/v2/rpc` 若提供外部兼容，必须有 deprecation header、usage counter、N-1 support 期限和最终移除公告；
- rollback = code artifact + user running-state strategy。明确已启动 runtime 怎么停/重启、旧版本怎样处理新增 DB/settings、旧 static cache 怎样失效；git tag 不是用户 rollback 方案。

#### Gate D exit criteria

- D1 固定 existing-shell 路线；production `/workspaces/` 与 experimental `/app/` namespace、window URL、navigation/capability allowlist 已由测试锁定；
- feature flag、release enablement、telemetry、roll-forward/rollback、N-1 策略已定；
- UI matrix 所有条目都有归属；
- release artifact smoke 已定义；
- 静态资源 `/v/{fingerprint}/` base 行为已验证：dynamic import、module assets、CSS、worker、root-relative API、download link 均正常。

---

## 4. Canonical protocol、状态与幂等

### 4.1 protocol v2 frame

本节仅在 Gate B 的 canonical v2 决策生效后适用。客户端不使用 legacy `broker_control` 作为 v2 名字；过渡 adapter 必须在服务端转换。

```jsonc
// desktop hello
{ "type": "hello", "protocolVersion": 2, "clientType": "desktop",
  "clientId": "...", "desktopCapability": "..." }

// paired remote hello
{ "type": "hello", "protocolVersion": 2, "clientType": "remote",
  "clientId": "...", "deviceToken": "..." }

// mutation request; host allocates operationId before Pi dispatch
{ "type": "runtime_request", "requestId": "...",
  "target": { "workspaceId": "...", "sessionId": "...", "instanceId": "..." },
  "idempotencyKey": "required-for-mutation",
  "command": { "type": "prompt", "message": "..." } }

// mutation acceptance; operationId is present for every mutation, including first acceptance
{ "type": "runtime_response", "requestId": "...",
  "acceptance": "accepted_pending|duplicate_pending|duplicate_completed",
  "operationId": "op-...", "response": { } }

// turn-bound abort; abort itself consumes no idempotency cache slot
{ "type": "runtime_request", "requestId": "...", "target": { "...": "..." },
  "command": { "type": "abort", "turnId": "turn-..." } }

// operation recovery; caller must be authorized for operation logical scope
{ "type": "operation_status_request", "requestId": "...", "operationId": "op-..." }

// runtime event. Terminal mutation event carries operationId; agent turn events carry turnId.
{ "type": "runtime_event", "target": { }, "sequence": 42,
  "operationId": "op-...", "turnId": "turn-...", "event": { } }

// request-local progress; not a replacement for runtime events
{ "type": "control_progress", "requestId": "...", "sequence": 1,
  "data": { "phase": "...", "percent": 0 } }
```

### 4.2 error code ownership

不以 §4 新枚举覆盖现有全部错误码。错误 code 归属：

| 层 | 复用/新增 code 示例 |
| --- | --- |
| frame/router | `handshake_required`, `protocol_mismatch`, `invalid_client_id`, `invalid_target`, `invalid_command`, `idempotency_key_required` |
| capability/auth | `unauthenticated`, `capability_expired`, `forbidden_class`, `owner_revoked`, `unauthorized_device` |
| runtime | `runtime_not_found`, `unknown_target`, `not_ready`, `runtime_crashed`, `duplicate_pending`, `duplicate_completed`, `operation_not_found`, `operation_expired`, `stale_turn` |
| path/data | `invalid_workspace`, `path_outside_workspace`, `invalid_path`, `not_a_directory`, `file_access_failed` |
| transport | `frame_too_large`（16 MiB physical frame only）, `command_too_large`（v2 business limit）, `event_sequence_gap`, `request_cancelled`, `upstream_unavailable` |
| migration | `unimplemented_route`（仅兼容层） |

Gate A matrix 为每个 endpoint 标明准确 code。前端只依赖 documented stable code；不得从 message 文本匹配。

### 4.3 RuntimeState 与 command admission

状态全集：

```text
Starting → Trusting? → Ready → Working ↔ Idle → Suspended → Ready
       └────────────────────────────────────────────→ Crashed → Stopped
Ready/Idle/Working/Suspended ── explicit stop ──→ Stopped
```

- `Starting`：process spawned，尚未完成 Pi runtime probe；
- `Trusting`：若 Pi/project trust interaction 等待 desktop owner；
- `Ready`：可接受 initial state/read requests；
- `Working`：agent turn 流式执行；
- `Idle`：可开始 mutation；
- `Suspended`：可恢复但不接受普通 mutation；
- `Crashed`：bridge EOF/child exit/protocol fatal 后，拒绝新 request；
- `Stopped`：host 有意终止或 cleanup 完成。

最低准入规则：

| command class | 允许状态 | 说明 |
| --- | --- | --- |
| snapshot/read state | Ready/Working/Idle/Suspended，Crashed 仅 cached snapshot | 不可在 Starting 隐式等待无限期 |
| prompt/steer/follow-up/fork/clone/navigate/compact/model change | Idle/Working，按 Pi command 细分 | mutation 必须 key |
| abort | Working 且 `turnId` 与 active turn 相等；Idle/已结束 turn 为 no-op | 绝不把旧 abort 转发给后继 turn；不占 mutation cache |
| trust response | Trusting 且 authenticated owning desktop | remote 不得响应 desktop dialog |
| stop | 非 Stopped | host lifecycle command |

每个具体 command 的例外在 Gate A matrix 声明。

### 4.4 Operation Registry、幂等与 turn-bound abort（已定案）

现有 `RuntimeCoordinator` 的 mutation deque 是 per-instance 临时去重缓存；它随 `unregister(instance)` 消失，不能承载断线、instance replacement、crash 或 operation 查询。v2 在 host 层新增 **Operation Registry**；它是逻辑 operation 真相，不是 Pi runtime 行为复刻。

#### Logical scope and record

Host 在接受每个 mutation 前分配 `operationId`，并创建：

```text
OperationScope {
  ownerId,
  workspaceId,
  sessionId,
  workspaceGeneration,
}
OperationRecord {
  operationId, idempotencyKey, commandType, scope,
  executionInstanceId, acceptedAt, expiresAt,
  state: Pending | Completed | Indeterminate | Expired | Revoked,
  turnId?: TurnId, terminalResponse?: Value, crashReason?: SafeErrorCode,
}
```

`instanceId` 是一次执行 attempt 的定位，不是 operation durable identity。仅 scope 完全匹配的 authenticated owner 可重放/查询 operation；remote access 必须由 Gate B 的 allowlist 显式授予。owner revoke、workspace generation change、TTL expiry 会使 record 变 `Revoked/Expired`，不得泄露旧 response。

#### Mutation replay and recovery

- mutation 请求必须有 UUID idempotency key；read 不带 key；host 在逻辑 scope 内去重；
- first acceptance 返回 `accepted_pending + operationId`；host 不因 WebSocket disconnect 取消它；
- 同 key、同 scope、`Pending` 重放固定返回 `duplicate_pending + operationId`；不提供“同连接等待首结果”分支；
- terminal Pi response 到达后，host atomically record `Completed`，并向原请求和有权限订阅者发送带 `operationId` 的 terminal frame；同 key 重放返回 `duplicate_completed + cached first response`；
- `operation_status_request` 返回 caller 可见的 `Pending/Completed/Indeterminate` record 摘要；`Expired/Revoked` 返回稳定 code，不能靠 event history 猜测；
- capacity、TTL、eviction 顺序、record persistence 范围必须在 Gate B 定义。最低要求：operation registry 生命周期独立于 execution instance；host restart 的 pending record 不得伪装为完成，应恢复为 `Indeterminate` 或明确不支持并 fail closed；
- **crash 时按完成度二分**：已收到 terminal response → `Completed`；否则 `Indeterminate` 并返回 `runtime_crashed`。客户端先拉 snapshot/operation status，再决定是否用**新 key**重发；UI 必须明示这可能双重执行。

#### Turn-bound abort

- 能启动/改变 agent turn 的 operation 会生成 `turnId`，并在 agent lifecycle event 中返回；host 保存 active `turnId → operationId` binding；
- abort 请求必须带 `turnId`，不带即 `invalid_command`；
- host 只在 `turnId == current active turn` 且 target/scope 匹配时向 Pi 转发；
- turn 已结束、Idle、Crashed 或 `turnId` 已被后继 turn 取代时，返回成功 no-op（可带 `stale_turn` disposition），绝不调用 Pi abort；
- abort 不占 idempotency cache 槽；同 turn 的重复 abort 可安全重发；它不能因断线重连中止新的 turn；
- client timeout 不等于 mutation/abort 取消；取消仅对明确可取消的 read/progress 生效。

必测：first/pending/completed replay、operation status authorization、instance replacement、TTL/eviction、host restart、crash indeterminate、A turn abort 断线→A结束→B开始→旧 abort重试、重复 abort、cross-owner turn ID。

---

## 5. 迁移矩阵基线（Gate A 必须取代为机器核验表）

以下表是已发现基线，**不是可据以删除的最终清单**。

### 5.1 embedded HTTP / static surfaces

| legacy surface | 终态候选 | 关键保留契约 |
| --- | --- | --- |
| static `/`, `index.html`, `cost.html` 等 | Host static service | versioned base、cache bust、现有 UI shell（默认路线） |
| `GET /api/health` | `GET /health` | host health 与 runtime readiness 分离；不可仍依赖 deleted `PiManager` |
| `POST /api/rpc` | WS `runtime_request` | command/response/event 完整映射；非大 payload |
| WS `/ws` | WS `/v2/ws` | event schema、broker routing、reconnect、owner context |
| `POST /api/paste-offload` | `POST /v2/paste-offload` | 4 MiB+ route limit、workspace-derived temp location、expiry/cleanup |
| `GET /api/files/raw` | `GET /v2/files/raw` | token/relative path、MIME allowlist、sandbox/nosniff/cache、abort |
| session export path endpoint | `GET /v2/session-export/{token}` | owner/root/generation/TTL/quota binding、Content-Disposition |
| `GET /api/files` | v2 data `list_files` | root derived from workspace ID, traversal/symlink containment |
| `GET/PUT /api/files/content` | v2 `file_read/file_write` | editable/type/size/conflict/mtime/atomic-write semantics |
| `GET /api/file-mentions` | v2 `file_mentions` | main runtime only, workspace race/abort/budget |
| `POST /api/open` | owner-only `open_in_app/open_external` | no shell injection, path authority |
| `GET /api/git-branch` | owner-derived `git_branch` | bounded runner, active workspace semantics |
| `GET /api/sessions` | v2 data `list_sessions` | workspace registry scope; ephemeral behavior |
| rename/delete/switch/export | controls + download token | Pi session authority, trash-first/running protection |
| `GET /api/search` | v2 data `search_sessions` | registered workspace scope, bounds, snippets |
| `GET /api/cost-dashboard` | v2 `cost_dashboard` compatibility operation | preserve `range/granularity/scope=all \| current/models`, payload/sort/cache semantics; current`HostDataPlane::cost_dashboard(wid)` is insufficient and must not silently narrow all→workspace |
| agent/models/chat config | resource-specific controls | settings lock/refresh/backup/0600 semantics |
| `/api/agents-md`, `/api/append-system-md` | `agent_text_file_get/put` controls | app-global agent root; not workspace cwd |
| telegram validate/bind/doctor | owner-only controls | secret redaction, external request timeout, 90s flow, 0600 config |
| skill install internal routes | existing native controls | loopback + secret defense in depth; source handle binding |
| super-agent projects/tasks | controls/data as matrix decides | task persistence, cross-runtime dispatch target authority |
| `/api/lan-qr`, instances, home, pi-version, workspace-info | host controls/data | class policy and source of truth |

### 5.2 Existing broker controls

Gate A must enumerate all registered controls, including but not limited to: session lifecycle, picker/system-open, skills/packages, session UI profile, runtime restart, updater, extension UI responses, every `ephemeral_*`, workspace transition prepare/commit/cancel, and window-close approval. A surface marked “already exists” is **not automatically migrated**: it must have a v2 mapping, authority proof and lifecycle test.

### 5.3 Frontend audit minimum

The migration inventory must include callers in at least:

- `public/app.js` (instances, workspace info, open/home/file mentions/git branch/paste/super-agent/rpc/session file/switch/health/LAN);
- `public/sidebar/index.js` (sessions/delete/rename/search/export/rpc);
- file browser, preview, renderers and PDF/image modules;
- `public/settings/config-gateway-legacy.js` and consumers；
- OAuth login 组件与流程（provider login、callback 窗口、ephemeral 分流）；
- `public/components/chat-settings-panel.js`, Super Agent components;
- `public/cost/dashboard.js`（必须记录 `range/granularity/scope/models` 参数、all/current scope、payload 字段、排序与 cache 语义；以同一 JSONL fixture 做 legacy/v2 逐字段比较）；
- `public/ephemeral-chat-view.js`;
- `public/super-agent/dispatch.js`;
- HTML static module entries and all relevant tests.

---

## 6. Revised implementation phases

> Every phase must pass its own tests before next phase. No phase changes user-facing UI behavior unless explicitly listed. “Revert” is not a sufficient rollback statement; see §13.

### P0 — Evidence and zero-behavior shared extraction

**Depends on:** Gate R + Gate A + Gate C design approved.

- Generate/commit migration inventory and a check that detects unmatched legacy surface/caller changes.
- Extract `pi_launch` pure helpers from legacy manager only after launch contract tells what must remain: args builder, binary resolver, safe extension path, stderr formatter/logger primitives, environment builder pieces.
- Make `shared/mutation-types.json` the single source for `host_router::is_mutation` and the native JS gateway; remove duplicate native list and add Rust↔JS parity tests. Current audited baseline is **14 mutation command types**; it is a test fixture baseline, not a permanent behavior or deletion metric. Unknown command default classification must be explicit and Gate A-reviewed.
- Correct all stale line references and counts in this document; line numbers are navigational hints, not acceptance criteria.

**Exit:** no production behavior change; `bun run test`, `bun run check`, `bun run check:rust`; launch description snapshots unchanged.

### P1 — Native lifecycle and operation substrate, still dark

**Depends on:** Gate R + Gate B + Gate C.

- Expand `NativeLaunchSpec`/manager to express full launch contract; no production routing yet.
- Add child exit observer, crash state/event, pending request failure, stop ordering, Windows process policy. EOF, child exit, writer failure and fatal protocol error must atomically set `Crashed`, mark in-flight operations `Indeterminate`, reject pending bridge requests and emit a sequenced crash/snapshot-required event.
- Implement §4.4 Operation Registry before v2 client consumption: logical scope, operation status request, terminal delivery, crash/restart/owner revoke/TTL behavior, turn IDs and turn-bound abort gate.
- Add owner/workspace/generation-aware target resolver backed by Gate R registry metadata.
- Replace `HostDataPlane`'s bare `workspace_roots: HashMap` constructor input with a registry-backed `canonical_root_for_workspace_id` lookup adapter; the bare Map must not survive as a second authority source (§9).
- Use `register_in_memory` for controls; real Pi smoke per runtime type.
- Host `/health` no longer has compile-time dependency on legacy `PiManager` APIs scheduled for deletion.

**Exit:** native manager can launch/stop all runtime types behind test-only/developer paths; operation registry/crash/turn-abort integration tests pass; no desktop user traffic moved.

### P2 — Canonical protocol and capability, dark + security test gate

**Depends on:** Gate R + Gate B + P1.

- Implement Desktop capability lifecycle and `HostClientContext`.
- Define/implement v2 canonical adapter for legacy controls, or implement v2 replacements per matrix. No implicit double-WS client.
- Enforce target authorization on runtime request, snapshot and subscription.
- Implement HTTP auth middleware only if a production HTTP compatibility path is needed. Otherwise P1 proxy remains internal-only.
- Add LAN bind/pairing implementation only after explicit product enablement; default remains loopback.

**Exit:** security matrix passes: invalid/expired/cross-owner/cross-wid/revoked capabilities; remote impersonation; target subscription leak; bare loopback HTTP; LAN policy. Feature remains unavailable to normal release users.

### P3 — Release host enablement and host-origin, existing UI shell

**Depends on:** Gate R + Gate D, P1, P2.

- Release-enable HostServer behind Gate R preferences flag; retain legacy origin as default.
- Production host window URL is `/workspaces/:wid/sessions/:sid`; host static service serves existing `index.html` and `public/app.js`. `/app/` remains frozen experimental native shell and is never selected by production flag.
- Create owner before window load, inject capability, attach navigation authorizer, bind host origin route to workspace ID.
- Deliver a **legacy UI transport compatibility adapter** before enabling flag: decide and test whether `public/app/websocket-client.js` is replaced, wrapped or protocol-adapted; map legacy broker v1 controls/events to canonical v2; replace/bridge query `brokerWs`; bind every retained `/api/*` fetch through authenticated owner-aware compatibility middleware. No old UI call may silently fall back to unauthenticated `/ws`, Pi origin, or a host 404.
- Adapter has its own contract tests: v2 hello/capability, reconnect, event ordering/sequence gap→snapshot, owner control, URL/base resolution, each retained API route, and query parameter removal strategy.
- Do not claim LAN support unless LAN deployment exit criteria pass.

**Exit:** flag on/off desktop smoke covers full UI parity matrix; `/workspaces/` resolves existing shell while `/app/` resolves experimental shell; no Pi-origin request is required for core runtime events. Flag off remains legacy-equivalent.

### P4 — Read/data and session migration

**Depends on:** Gate R + P3.

- Migrate data reads in matrix order: instances, sessions, search, **Cost Dashboard compatibility operation**, workspace info, pi version, home where justified.
- Cost Dashboard migration must preserve legacy `range`, `granularity`, `scope=all|current`, `models`, response fields, date/bucket behavior, sorting and cache invalidation. `HostDataPlane::cost_dashboard(workspaceId)` is not its direct replacement. Gate A fixture comparison must pass before old endpoint removal.
- Migrate session rename/delete/switch/export with owner binding and token download.
- Preserve trash-first, running protection, per-file result and session naming behavior.
- Do not map legacy `/api/workspace/open` to runtime spawn. Its replacement is owner-only system-open; a new runtime spawn command must have a distinct name and registry dependency. 候选名 `workspace_runtime_start`（终名在 Gate B 定案；不得复用 `workspace_open`），实现依赖 `canonical_root_for_workspace_id`。

**Exit:** response/error parity tests plus host-origin manual session/sidebar/export flows.

### P5 — File/config and OAuth migration

- File list/read/write/raw; enforce relative paths, canonical containment, symlink escape prevention, MIME/type/size/conflict semantics.
- Resource-by-resource config controls: agent settings, models, chat config, AGENTS/APPEND_SYSTEM. Define app-global vs workspace scope correctly.
- Preserve model refresh, backup, proper lock protocol, JSON validation, atomic writes, 0600 requirements and restart messages.
- **OAuth has sole phase ownership here.** Migrate `get_oauth_login_capabilities`, `start_oauth_login`, `cancel_oauth_login`, `get_oauth_login_status`, `logout_oauth_login` as v2 controls/events. Preserve owner + Pi-process-generation binding, device-code/progress only-owner delivery, expiry, cancel, connection/window destroy, runtime crash/reload cleanup, remote/ephemeral denial, credential redaction and post-login/logout catalog refresh. Do not defer OAuth behind a generic P7 chat-RPC statement.
- Rust OAuth manager must hold a monotonic process generation with semantics equivalent to legacy `oauthProcessGeneration`: spawn/probe success creates or advances generation; reload/restart advances it; bridge EOF, child exit/crash, owner/window destruction and explicit stop first revoke/abort prior-generation operations, then update runtime state. Stale-generation events are dropped and may be safely audited, never delivered or logged with credentials. Pi remains credential-store owner.

**Exit:** path/TOCTOU/security suite; file preview/editor manual flow; config side-effect regression tests; OAuth lifecycle matrix passes (start/cancel/expiry/disconnect/window-destroy/reload/EOF/crash/explicit-stop/restart/logout/catalog refresh, cross-owner, remote, ephemeral, stale-generation event suppression).

### P6 — Heavy integrations and HTTP binary paths

- paste-offload with route-level 4 MiB minimum limit and secure lifecycle;
- file mentions, git branch, skills endpoint removal after existing native controls satisfy contract;
- Telegram, Super Agent, workspace info, package/ephemeral integrations per matrix;
- migration of all remaining non-chat `/api/*` callers.

**Exit:** cancellation, source-handle expiry, token/secret redaction, external timeout and temp cleanup tests; relevant full suite.

### P7 — Chat RPC and event transport completion

- Migrate every legacy `/api/rpc`, `/ws`, cross-port and Super Agent runtime command to canonical v2 request/event protocol.
- Specify control progress ordering, max frame behavior, backpressure, abort, request cancellation and reconnect/snapshot fallback.
- If `/v2/rpc` compatibility endpoint is approved, publish support window, usage telemetry and deprecation behavior. It must not be a hidden permanent second RPC API.
- Remove compatibility entries only after inventory proves zero callers and parity/smoke tests pass.

**Exit:** real Pi smoke: prompt → stream → steer/follow-up → abort → compact → fork/tree → reconnect/sequence gap → crash response. No production caller reaches `embedded-server` directly.

### P8 — Release rollout, removal and documentation

**Preconditions:** flag cohort and stability criteria from §13 met; every Gate A row has deletion proof; and Gate R's schema recovery contract has a recorded real `N-1 → N → N-1` rehearsal covering DB backup/restore, session preservation, running runtime disposition, static cache and user-facing remediation.

- Remove proxy, legacy origin, `embedded-server.ts`, embedded server tests only after their behavior moved, `PiManager`, obsolete flags, deprecated endpoints and legacy gateway modules.
- Remove or retain `extensions/dist` artifacts explicitly: remove `embedded-server.mjs`; retain `picot-bridge.mjs`; decide `pi-chat.mjs` based on P6 final architecture.
- Rewrite `ARCHITECTURE.md`, README architecture sections, build instructions, capabilities and smoke instructions.
- Verify release artifacts on macOS and Windows with embedded Pi—not `$PATH` Pi.

**Exit:** `bun run test`, `bun run check`, `bun run check:rust`, `bun run build:extensions`; all real smoke matrices; release upgrade and rollback rehearsals; architecture docs reviewed.

---

## 7. HTTP binary, streaming and cancellation contract

### 7.1 Limits

| Surface | Limit/behavior |
| --- | --- |
| canonical WS physical frame | fixed `MAX_WS_MESSAGE_BYTES`（16 MiB，与 `MAX_RPC_FRAME_BYTES` 对齐）；所有入站 text frame 超限以 `frame_too_large` 关闭/拒绝；never silently truncate。物理帧上限不是业务许可 |
| v2 `runtime_request.command` | 默认 1 MiB，常量 `RUNTIME_REQUEST_COMMAND_MAX_BYTES`；prompt/steer 等超限返回 `command_too_large`，客户端改走 `/v2/paste-offload`。防止 ≤16 MiB 巨型 prompt 直达 Pi stdin |
| `data_request` / `host_request` | 每个 operation 在 Gate A matrix 声明固定 JSON 上限；不得以 generic 16 MiB 作为 file/config write 通道；大内容改 HTTP opaque upload/offload |
| `extension_ui_response` / OAuth response | 小固定 JSON 上限；超限 reject，不允许把配置/文件内容塞入 dialog response |
| generic host HTTP | 1 MiB current default unless route-specific override |
| paste offload | at least existing 4 MiB; explicit route-level override; no global accidental increase |
| file raw/export | stream from validated descriptor; avoid whole-file buffering |
| outbound runtime response/event | serialised-byte upper bound per frame；超限不发送半 JSON，返回/发出 `snapshot_too_large` 或 `response_too_large`，并给出 matrix 定义的 snapshot token、HTTP download 或 bounded summary fallback |
| outbound snapshot | 独立 lower bound；超过时使用 host-authorized snapshot/download token 或明确拒绝，不能依赖 broadcast backlog |
| control progress | 小固定 JSON 上限、request-local monotonic sequence；允许 coalesce/drop nonterminal progress，但 terminal response 不可丢 |

Gate B/P2/P3 compatibility integration tests must exercise every applicable limit at `limit - 1`, `limit`, and `limit + 1`, for inbound and outbound paths. They must additionally cover slow consumers, broadcast lag, cancellation and disconnect; passing a router unit test alone is insufficient.

### 7.2 HTTP routes

Every binary/download route must define:

- capability/device token extraction and target/owner binding;
- authorization before file open and re-validation when required;
- relative path or opaque token input only;
- TTL/quota/one-shot semantics for tokens;
- MIME allowlist, `X-Content-Type-Options: nosniff`, CSP/sandbox where applicable;
- Content-Disposition filename generation without header injection;
- Cache-Control;
- Range support decision (explicit support or explicit rejection);
- client disconnect → stream/task abort/descriptor close;
- TOCTOU strategy and Windows descriptor behavior;
- audit logs without raw paths/tokens.

### 7.3 Progress / ordering

`control_progress` is not an unbounded event channel. It must state requestId, monotonic progress sequence, bounded payload, terminal relation and cancellation behavior. Runtime events retain per-target event sequence. Client receiving `event_sequence_gap` must request a snapshot, not retry mutations blindly. Existing and compatibility clients must explicitly treat `event_sequence_gap` as a hydration trigger; a passive `snapshotRequired` flag without a consuming handler is insufficient.

---

## 8. Security model and authorization matrix

### 8.1 Authority derivation

```text
Desktop capability → HostClientContext.owner → registry workspace/generation
                 → canonical root + current runtime target
                 → operation-specific validation
```

No operation may invert this into `browser path/port/session → guessed owner`.

### 8.2 Paths

- Browser sends opaque ID or root-relative path only; absolute path rejected unless a specific legacy compatibility adapter validates owner-bound opaque handle;
- host canonicalizes root and candidate; rejects traversal, prefix siblings, symlink escape and directory/file mismatch;
- same-user TOCTOU limitations are documented, not falsely claimed solved;
- system-open accepts only host-authorized paths/URLs and never shells command strings.

### 8.3 Secrets

Never send to browser/log/telemetry: desktop capability, remote pairing/device token, skill install secret, OAuth credential, Telegram bot token, raw config secrets. Error messages must redact them. Telegram validation/bind needs independent rate/timeout/cancel semantics, not generic Git operation handling.

### 8.4 Audit tests

At minimum: target confusion, owner confusion, path traversal, symlink escape, stale download token, token replay, device revoke, capability leak through URL/log, remote control escalation, raw MIME confusion, cancellation and app restart/reconnect.

---

## 9. Workspace identity and transitions

This migration depends on the workspace registry design but does not implement its product UI.

Required API before host-origin routing is Gate R’s registry contract:

```text
workspace_id_for_canonical_root(root) -> WorkspaceId
canonical_root_for_workspace_id(wid) -> CanonicalRoot | not_registered
owner_current_workspace(owner) -> { wid, root, generation } // atomic snapshot
pref_get("runtime.native_origin") -> Option<bool>
```

These APIs are external dependencies, not placeholders to be introduced during P1/P3.

- workspace route `wid` must resolve before window navigation is authorized;
- session switch may remain same workspace without root refresh; cross-workspace transition increments generation and invalidates capability-bound ephemeral handles/source handles/download tokens as applicable;
- transition prepare/commit/cancel is a lifecycle protocol, not a front-end URL rewrite;
- nonregistered/default temporary workspace behavior must be explicitly documented—no transient untrusted `wid→root` Map becomes a new authority source.

---

## 10. Verification strategy

### 10.1 Test tiers

| Tier | Scope |
| --- | --- |
| pure/unit | router validation, capability parsing, launch descriptions, path helpers, state/idempotency |
| in-memory native bridge | host controls/runtime event, duplicate request, crash, target authorization; no real Pi spawn |
| HTTP/WS integration | capability middleware, proxy if retained, all inbound/outbound frame limits, streaming/cancel, subscription authorization, operation status, turn-bound abort |
| real Pi smoke | primary/dedicated/Side/Quick/standby, bridge extension, prompt stream, A abort→disconnect→B turn safety, restart/crash/indeterminate operation |
| desktop manual/E2E | UI parity matrix, navigation, IME, dialogs, Git/Terminal/settings |
| release artifact | bundled Pi, macOS/Windows, static fingerprint/cache, code signing/firewall/LAN if enabled |
| upgrade/rollback | N-1→N and N→N-1 according to compatibility policy |

### 10.2 Required commands

- focused Vitest/Cargo test first;
- `bun run test`;
- `bun run check` after `public/` or `extensions/` change;
- `bun run check:rust` after Rust change;
- `bun run build:extensions` when Pi extension build changes;
- full `bun run test` for loopback, filesystem, static serving, locale or lifecycle changes.

### 10.3 Performance baseline

Before P3 record exact environment: OS/version, hardware class, embedded Pi version, build mode, workspace/session count, total JSONL bytes, directory file count, cache state, sample size, warmup and percentile calculation.

Metrics:

- equivalent state read P50/P95;
- prompt → first text/event P50/P95;
- file list 1k entries;
- session list/search/cost scope stated explicitly;
- host RSS/process count; reconnect recovery time.

Thresholds are valid only against identical baseline workload. Suggested initial gate: equivalent P50 < +15%, P95 < +25%, prompt first-event P50 < +10%; any breach pauses migration and requires diagnosis.

---

## 11. Risk register and stop conditions

| Risk | Stop condition | Required response |
| --- | --- | --- |
| desktop capability bypass | any cross-owner/unauthenticated test passes | block P3; redesign Gate B |
| UI regression on host origin | any parity matrix critical path fails | disable flag; no routing expansion |
| launch gap | any runtime type has no native lifecycle smoke | block PiManager deletion |
| protocol split | host-origin browser needs undocumented second WS | block P3/P7; decide canonical adapter |
| LAN exposure | host bind/auth matrix incomplete | keep loopback only |
| data loss | delete stops trash-first/running guard | revert behavior; separate product RFC |
| endpoint omission | matrix/caller mismatch | block P8 removal |
| operation ambiguity | `operationId` cannot resolve by logical scope after instance exit/restart | block P2/P7 until Operation Registry contract passes |
| stale abort | an abort can target a different/newer turn | block P7 and disable host-origin mutation path |
| registry readiness | Gate R API/schema/recovery not delivered | block P1/P3; retain legacy authority |
| performance breach | metric exceeds threshold | optimize/diagnose before next phase |
| rollback failure | N-1 test cannot recover supported user | do not default-on or delete legacy |
| external protocol usage | deprecated endpoint usage nonzero at removal gate | extend support window or migrate caller |

---

## 12. Phase checklist

- [ ] Gate R workspace registry/preferences API, schema compatibility and recovery passed
- [ ] Gate A inventory generated, reviewed, checked against source
- [ ] Gate B canonical protocol/capability/LAN matrix approved
- [ ] Gate C launch/lifecycle contract approved
- [ ] Gate D UI/origin/release strategy approved
- [ ] P0 zero-behavior extraction passes all checks
- [ ] P1 all runtime type native lifecycle smoke passes
- [ ] P2 security and target authorization matrix passes
- [ ] P3 release host flag off/on full desktop parity passes
- [ ] P4 session/data behavior and delete/export contract passes
- [ ] P5 file/config side effects and security passes
- [ ] P6 heavy integration, cancellation and temp lifecycle passes
- [ ] P7 real Pi chat/reconnect/crash protocol smoke passes
- [ ] P8 cohort, N-1 rollback, deletion proof, release artifact validation passes

---

## 13. Rollout and rollback gates

### 13.1 Flag lifecycle

1. debug developer override may enable native runtime but does not define release behavior;
2. release flag is default false; read once at launch from documented store; report effective state safely;
3. dogfood → opt-in cohort → default-on only after two stable release cycles and exit metrics;
4. legacy remains available until P8 conditions; not merely until code compiles;
5. remove flag only after zero supported legacy users/endpoint usage according to published support window.
6. release flag reader is unavailable until Gate R schema/API is available; a missing/invalid preference or unsupported schema forces legacy origin and records only a redacted diagnostic code.

### 13.2 Rollback

For every phase answer before release:

- what feature flag route restores legacy behavior;
- whether running Pi processes must be drained/restarted;
- whether DB/settings are forward-compatible; if not, backup/restore tool and user warning;
- registry schema coordination: 08-26 registry v3 may cause an N-1 binary with lower `user_version` support to refuse startup. Before automatic upgrade, detect and record the N-1 compatibility decision. If incompatible, create and verify a pre-upgrade DB backup, ship a version-matched controlled restore/downgrade tool, preserve session files, and define recovery UX for restore failure, missing workspace and missing directory. A Git checkout is not a user recovery path;
- release rollout requires a recorded real `N-1 → N → N-1` rehearsal of that path before default-on or P8 deletion; generic upgrade smoke does not satisfy this requirement;
- whether static assets cache safely after binary downgrade;
- which release artifacts remain downloadable;
- what user-visible remediation is shown if auto rollback cannot preserve a session.

A Git revert/tag is developer source control only, not a rollback plan.

---

## 14. Documentation and ownership updates

P8 must update:

- `ARCHITECTURE.md`: process model, network paths, owner capability, LAN boundary, runtime lifecycle, static serving, verification contract;
- README architecture/development sections;
- build scripts/resources: embedded server artifact removal and bridge retention;
- capability/permission checks and security tests;
- `docs/engineering-lessons.md` when new cross-process or adapter lessons become release-blocking;
- `.memory/` via update-memory skill after verified implementation decisions.

---

## 15. Facts corrected from prior draft

- `public/native/*` has 10 modules and is conditionally imported at `/app/`; it is not a complete zero-reference UI.
- `HostServer` is debug + `PICOT_RUNTIME=native` only; release remains legacy today.
- host `/v2/auth/exchange` is remote pairing/device-token exchange, not desktop capability issuance.
- current HostRouter and BrokerWs are distinct v2/v1 protocols.
- `RuntimeState` has eight variants, including `Trusting`, `Suspended`, `Crashed`.
- host data plane already implements list files/sessions/search/cost primitives.
- embedded API inventory includes cost, search, global agent text files and `/ws`; API count must be generated, not remembered.
- legacy session deletion is trash-first, not permanent delete.
- legacy `/api/workspace/open` means system-open directory, not open/launch runtime.
- generic host body limit is 1 MiB; paste offload currently permits 4 MiB.
- `embedded-server` test/artifact removal count is not an acceptance metric; behavior migration proof is.
- `MAX_WS_MESSAGE_BYTES`（host_server.rs）与 `MAX_RPC_FRAME_BYTES`（native_pi_manager.rs）当前同为 16 MiB；这是 stdin 透传对齐的物理约束，业务上限另设（§7.1）。
- OAuth login（`get_oauth_login_capabilities` 等）是 embedded `/ws` command 面，不是 HTTP 路由。
- `bootstrap-entry.js` 当前以 `/app/` 前缀选择 native shell；故 production existing-shell host origin 必须使用独立 `/workspaces/` namespace（Gate D/P3）。
- 当前 RuntimeCoordinator mutation cache 是 per-instance deque；operation durability、crash/restart query 和 turn-bound abort 均由 §4.4 的新 host Operation Registry 承担，不能假定既有 cache 已满足。
- mutation command classification migrates through `shared/mutation-types.json`; current audited baseline is 14 command types, and JSON—not parallel Rust/JS lists—is the post-P0 authority.
- The implementation plan is a phase/work-package mapping of this specification; this specification remains contract authority. A plan must not silently settle protocol, authority, lifecycle or recovery behavior ahead of this document.

---

## 16. Required decisions before implementation

The following are implementation-blocking. Default recommendation is shown, but Dr. Lin must confirm or replace it.

| ID | Decision | Default recommendation | Blocks |
| --- | --- | --- | --- |
| D1 | P3 UI entry and namespace | Host `/workspaces/` serves existing `index.html`/`app.js`; `/app/` stays experimental native shell | P3 onward |
| D2 | canonical client protocol | Host WS v2; legacy broker v1 server-side adapter only during transition | P2 onward |
| D3 | desktop capability issuer | Window lifecycle mints per-window in-memory token; never remote exchange | P2 onward |
| D4 | LAN enablement | Loopback default; LAN is separate opt-in deployment phase | P2/P3 LAN claims |
| D5 | workspace identity source | Gate R registry API is prerequisite; no browser-provided roots or HostDataPlane map | P1/P2/P4 |
| D6 | settings scope | Agent root config remains app-global; workspace config only where Pi specifies | P5 |
| D7 | paste transport | permanent HTTP endpoint with route-level >=4 MiB limit | P6 |
| D8 | `/v2/rpc` compatibility | avoid unless external caller inventory proves need; if retained, versioned deprecation/support plan, and usage counters aggregate by anonymous client class only（禁止 per-user/per-token 维度，与 telemetry 脱敏一致） | P7/P8 |
| D9 | Super Agent cross-runtime | canonical RuntimeTarget through v2; no direct port fetch | P6/P7 |
| D10 | release flag storage/rollout | Gate R 交付的 `preferences.runtime.native_origin` 是唯一 release source；debug env 仅 developer override；schema-aware cohort gates | P3/P8 |

> After D1–D10 are resolved, update this document’s Gate/phase sections before code starts. Do not solve a decision silently inside an implementation PR.
