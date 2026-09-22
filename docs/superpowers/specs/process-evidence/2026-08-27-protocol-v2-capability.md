# Gate B：Protocol v2、Capability、Target 与 LAN Contract

> 状态：evidence-based Gate B contract。本文只记录仓库已实现事实、已批准决策、迁移期约束与证据缺口；不把设计目标写成当前实现。
> **Gate B-design：CLOSED at CP1（2026-08-29，Dr. Lin 签署；纪要 `2026-08-29-cp1-review.md`）。** 关闭仅固化设计为实现输入；B-GAP-01–14 全部保持 mandatory implementation acceptance，随归属 phase exit 关闭（§13/§14）。
>
> 证据快照：2026-08-28。主要来源：`docs/superpowers/specs/implemented/2026-08-27-native-runtime-migration-design.md`（Gate B、§4、§7–§10、D2/D4）、`2026-08-27-migration-inventory.md`、`2026-08-27-launch-contract.md`、`src-tauri/src/host_router.rs`、`host_server.rs`、`broker_ws.rs`、`native_pi_manager.rs`、`runtime_coordinator.rs`、`command_policy.rs`、`window_owner.rs`、`metadata_store.rs`、`remote_auth.rs`、`main.rs` 及其测试。

## 1. 结论与边界

### 1.1 已批准决策

| 决策 | 状态 | 本文约束 |
| --- | --- | --- |
| D2 canonical protocol | 已拍板（2026-08-28，带重开条件） | canonical client protocol 是 Host `/v2/ws`；legacy broker v1 只允许作为服务端 adapter 过渡，host-origin UI 不得隐式双连两条 WS。若 Gate B 证明 v1 adapter 成本不可接受，才重新提交 D2。 |
| D3 desktop capability | 已拍板 | window lifecycle 生成每窗口内存 capability；不走 RemoteAuth exchange，不持久化。 |
| D4 LAN | 已拍板（2026-08-28） | 默认 loopback；LAN 是单独 opt-in deployment phase。Gate B 不得宣称当前支持 LAN。 |
| D5 workspace identity | 已拍板 | `Registered` registry workspace 才能成为 v2 target/route/scope；`Temporary` 不得伪造 workspace ID。 |

### 1.2 当前能力不能冒充终态

当前 HostServer 已有 v2 HTTP/WS 骨架、16 MiB WebSocket physical limit、1 MiB generic HTTP body limit、v2 frame routing、RemoteAuth pairing、runtime event sequence 与 static fingerprint。当前仍缺：desktop hello capability 校验、HostClientContext、target authorization、durable operation registry、完整 lifecycle/crash policy、Registered-only admission、业务 payload limits、背压/cancel contract、LAN bind policy。

当前 `HostRouter` 只按 `clientId` 记录 `Desktop`/`Remote`，`desktop` hello 不要求 `desktopCapability`；`HostServer` 对 remote 验证 device token，但对 desktop 不验证 capability；subscription 先写入集合，再以 runtime existence/owner map 处理，不能视为终态授权实现。当前 host data plane 仍由 `HashMap<workspaceId, PathBuf>` 构造，不能视为 registry authority。

## 2. Terminology 与 authority chain

```text
Desktop capability / remote device token
        ↓ host-side authentication
HostClientContext
        ↓ owner + current workspace snapshot
Registered { wid, canonical root, generation }
        ↓ target resolver
RuntimeTarget { workspaceId, sessionId, instanceId }
        ↓ operation-specific validation
runtime/data/host action
```

禁止反向授权：browser path、port、session、instance、workspace ID 或自报 owner 不得推导权限。`instanceId` 是一次 execution attempt 身份，不是 durable operation 身份；`workspaceGeneration` 是 transition binding，不是 capability 自报值。

Gate R 要提供下列单一、原子 API；在这些 API 可用前，P1/P2/P3 不得以临时 map 取代：

```text
workspace_id_for_canonical_root(root) -> WorkspaceId | not_registered
canonical_root_for_workspace_id(wid) -> CanonicalRoot | not_registered
owner_current_workspace(owner) -> OwnerWorkspaceSnapshot

OwnerWorkspaceSnapshot =
  Registered { wid, root, generation }
  | Temporary { root, generation, temporaryKind }
  | NoWorkspace
```

`Temporary` 包括默认 `~/.pi/tmp` 与 Quick Chat child。它没有 durable wid；除显式批准的 temporary policy 外，target、route、capability scope、operation scope 一律 fail closed。当前 native setup 使用 `native-<UUID>` + RAM `HashMap`，这是已记录的 Gate R/Gate C 缺口，不是可接受终态。

## 3. v2 wire contract

### 3.1 Frame envelope

所有 v2 WS frame 是 JSON object。除 hello 外，须有非空 `requestId`；host 生成并验证 correlation，不信任客户端把 response 当 request。未知 frame、缺字段、错误类型返回 documented stable error code，不按 message 文本作客户端分支。

```jsonc
// desktop hello: capability 只由 host initialization script 注入内存文档
{
  "type": "hello",
  "protocolVersion": 2,
  "clientType": "desktop",
  "clientId": "opaque-client-instance",
  "desktopCapability": "opaque-bearer"
}

// paired remote hello: device token 与 desktop capability 是不同凭据
{
  "type": "hello",
  "protocolVersion": 2,
  "clientType": "remote",
  "clientId": "opaque-client-instance",
  "deviceToken": "opaque-device-token"
}

// runtime mutation/read request
{
  "type": "runtime_request",
  "requestId": "request-id",
  "target": {
    "workspaceId": "registered-wid",
    "sessionId": "session-id",
    "instanceId": "execution-instance-id"
  },
  "idempotencyKey": "uuid-for-mutation",
  "command": { "type": "prompt", "message": "..." }
}

// runtime snapshot/capabilities request
{
  "type": "runtime_snapshot_request",
  "requestId": "request-id",
  "target": { "workspaceId": "...", "sessionId": "...", "instanceId": "..." }
}

// host/data request; operation is separately authorized
{
  "type": "host_request|data_request",
  "requestId": "request-id",
  "operation": "documented-operation",
  "target": { "workspaceId": "..." }
}

// target subscription; authorization occurs before subscription is stored
{
  "type": "runtime_subscribe",
  "requestId": "request-id",
  "target": { "workspaceId": "...", "sessionId": "...", "instanceId": "..." }
}

// host-origin operation acceptance
{
  "type": "runtime_response",
  "requestId": "request-id",
  "acceptance": "accepted_pending|duplicate_pending|duplicate_completed",
  "operationId": "operation-id",
  "response": {}
}

// sequenced runtime event
{
  "type": "runtime_event",
  "target": { "workspaceId": "...", "sessionId": "...", "instanceId": "..." },
  "sequence": 42,
  "operationId": "operation-id",
  "turnId": "turn-id",
  "event": {}
}

// request-local progress; not runtime event stream
{
  "type": "control_progress",
  "requestId": "request-id",
  "sequence": 1,
  "data": { "phase": "...", "percent": 0 }
}
```

当前 `HostRouter` 已实现 `hello` version=2、client type、client ID、route class、target shape、mutation idempotency-key presence；它尚未证明 credential binding、target scope、command size 或 capability lifecycle。

### 3.2 Hello lifecycle

1. WS 首帧必须是 `hello`，且 `protocolVersion == 2`。
2. `clientId` 必须非空；client instance ID 不等于 owner/device identity。
3. `desktop` 必须携带 capability；host 用 capability index 找到 window owner。缺失、错误、过期、已撤销 capability 不得降级为 remote 或 anonymous browser。
4. `remote` 必须携带 RemoteAuth 发出的 device token；pairing token 只能用于 `/v2/auth/exchange` 一次性换 device token，不得直接作为 WS bearer。
5. handshake 成功才创建 `HostClientContext` 并发送 `hello_ack`。当前 HostServer 对 remote device token 已有验证；desktop capability 校验尚未接入，`HostRouter::connect` 当前只做类型记录。
6. client disconnect 清理 connection-local subscriptions；owner revoke、window destroy、workspace generation transition 还必须撤销相应 host capabilities/handles/operations，不能只断 socket。

`hello_ack` 不回显任何 credential、root、token 或未授权 target。认证错误使用稳定 code：`handshake_required`、`protocol_mismatch`、`invalid_client_id`、`unauthenticated`、`capability_expired`、`owner_revoked`、`unauthorized_device`。

## 4. Desktop capability lifecycle

### 4.1 Issuance、binding、transport

`open_workspace_window` 必须先创建 owner，再加载文档。capability record 至少绑定：

```text
{ ownerId, windowLabel, workspaceId?, workspaceGeneration,
  issuedAt, expiresAt? }
```

实际 `WindowOwnerRegistry` 已实现随机 32-byte capability、capability→owner index、owner/window/cwd/port/origin/generation 保存、revoke 删除 index、atomic `owner_current_workspace` snapshot、transition generation。`create_owner_with_workspace` 可表示 `Registered`/`Temporary`，但 native setup 当前没有使用该 owner lifecycle；`open_native_workspace_window` 路径仍是明显缺口。

Capability：

- 只作为 host lookup key；caller 自报 workspace/owner/generation 不能替代 record；
- 只经 Tauri initialization script 注入 top-level host-origin document；
- 不得进入 URL/query/hash、静态 HTML、HTTP response、clipboard、crash telemetry、remote bootstrap、日志；
- host restart 后旧 capability 失效，重载 window 重新注入；不持久化；
- window destroyed、owner revoke、scope/generation 失效时撤销；
- navigation authorization 必须同时检查 origin 与 owner 的 pending/current route，不能只因“同 host origin”放行任意 workspace path。

当前 `capability_initialization_script` 注入 loopback document 的 global，且不进入 URL；`authorize_navigation` 有 exact-origin/pending navigation 检查。当前 native setup 无 capability 注入的证据，且生产 host-origin namespace 尚未接通（D1 要求 `/workspaces/`，当前 native window 使用 `/app/`）。

### 4.2 HostClientContext

认证后 host 内部创建不可伪造 context：

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

`UnpairedBrowser` 可访问的仅是明确批准的公开健康/静态 surface；不得因为 TCP peer 是 loopback 或 CORS 命中而获得 owner 权限。CORS 不是认证。当前 v2 HostRouter 没有此 context，只有 `ClientKind`；这是 **B-GAP-02** 实现缺口（owner：P2.2 context/auth tests），不阻塞 Gate B-design 关闭（§14）。

## 5. Remote device token 与 desktop capability distinction

| 项目 | Desktop capability | Remote device token |
| --- | --- | --- |
| issuer | window lifecycle / host owner registry | `/v2/auth/exchange` 后 RemoteAuth + metadata store |
| 用途 | 证明当前 WebView 属于某 native window owner | 证明 paired device |
| scope | owner、current workspace、generation、window | device；runtime/workspace visibility 另由产品 allowlist 决定 |
| 生命周期 | window destroy、owner revoke、host restart、scope invalidation | metadata revoke、device lifecycle、host policy |
| 传输 | Tauri init script 注入；不在 URL/HTTP body | remote hello bearer；exchange request 只带 pairing token/device ID |
| 可否互换 | 不可 | 不可 |
| 当前实现 | registry issuance/lookup 有；v2 HostServer 验证未接入 | pairing exchange、hash-backed storage、authorize/revoke 有；LAN bind 未实现 |

Remote 不得冒充 desktop owner、响应 desktop trust dialog、访问 picker/system open/config write/file write/Git/Terminal/package/skill install 或全局 registry/preferences，除非未来产品矩阵对某项作明确 allowlist；默认全部 deny。

## 6. Target admission 与 command policy

### 6.1 Registered-only policy

目标解析必须按 authenticated context → `owner_current_workspace` → registry inverse lookup 完成：

- v2 `RuntimeTarget.workspaceId` 必须是已登记 wid；root 从 registry 派生；
- `sessionId`、`instanceId` 必须属于该 workspace，且 instance 当前存在；
- 客户端提交的 root、port、session path、cwd、owner、generation 只作输入校验，不能成为 authority；
- workspace transition 前后 generation 必须匹配；跨 workspace commit 原子更新 owner snapshot，并使旧 scope/handles 失效；
- stale、unknown、cross-owner、cross-workspace、cross-generation target fail closed；
- subscription 在验证 target visibility 之后才写入 connection state；不能只检查 `subscriptions.contains(target)`。

当前 `HostServer` subscription 仅验证 `RuntimeTarget` 形状，再用 runtime target 和 `session_owners` map 处理；当前 `HostRouter` 不知道 owner/workspace scope。当前 native manager 的 `target_for_session*` 只扫内存 runtime map，不能提供 Registered admission。

### 6.2 Temporary policy

`Temporary` 不是 Registered 的弱版本：

| Temporary runtime | v2 target admission | 允许行为 |
| --- | --- | --- |
| default startup `~/.pi/tmp` | 不进入 Registered target/route/scope；无 synthetic wid | 仅显式 default-startup/legacy policy；未定义则拒绝 |
| Quick Chat child | 不进入 Registered target；child token/path host-only | 仅 owner-bound ephemeral adapter；跨 owner/transition/restart fail closed |
| Side Chat | 不进入 Registered target；owner/generation bound | 仅显式 ephemeral policy；remote/LAN 默认拒绝 |
| temporary → formal session bind | 不能直接改写 authority | 只能由 host/Pi 产出已验证 formal session，再通过原子 binding/target update；旧 temporary handle 失效 |

`command_policy.rs` 已对 temporary command 做 manifest 分类：未知命令与 session lifecycle 默认拒绝，desktopOwnerOnly 需 authenticated desktop owner；该策略只覆盖 legacy broker temporary command admission，不能替代 v2 target authorization。`RuntimeCoordinator::bind_session_id` 有 in-memory 原语，但不等于生产 Registered registry binding。

### 6.3 Command class baseline

| command/data class | NativeDesktop | PairedRemote | Unpaired browser/LAN |
| --- | --- | --- | --- |
| static assets、health | allow | allow | allow（仅公开 health/asset） |
| 已授权 runtime snapshot/event | allow，按 owner + target | 仅明确 allowlist | deny |
| prompt/steer/follow-up/abort | allow，target + state/turn 校验 | 默认 deny；产品 allowlist 后才允许 | deny |
| session/workspace route change | allow | default deny | deny |
| Git、Terminal、system open、picker、package、skill install | allow + owner | deny | deny |
| config/file write、OAuth controls | allow + owner + generation | deny | deny |
| global registry/preferences | allow + owner | deny | deny |
| pairing create/exchange | host policy；不泄露 desktop capability | exchange flow | unpaired 仅按 pairing surface policy |

具体命令必须回填 Gate A 每个 ID 的 authority、terminal、error、side effect 与测试；本表不是允许未列命令的兜底。

## 7. Operation、idempotency、sequence、reconnect

### 7.1 Operation identity

Host 在接受 mutation 前分配 `operationId`，不使用 `instanceId` 作为 durable identity：

```text
OperationScope { ownerId, workspaceId, sessionId, workspaceGeneration }
OperationRecord {
  operationId, idempotencyKey, commandType, scope,
  executionInstanceId, acceptedAt, expiresAt,
  state: Pending | Completed | Indeterminate | Expired | Revoked,
  turnId?, terminalResponse?, crashReason?
}
```

Mutation 必须有 UUID idempotency key；read 不带。同 scope + same key：首次 `accepted_pending`；pending replay `duplicate_pending`；completed replay `duplicate_completed` + cached first response。不同 scope 即使 key 相同也不得命中。abort 不占 mutation cache slot。

当前 `RuntimeCoordinator` 只有 per-instance `VecDeque` 去重，unregister 后丢失；`NativePiManager::request` 在 duplicate 时返回 pending error 或 cached result，但没有 `operationId`、scope、TTL、restart recovery。它不能满足本节。

### 7.2 Crash、reconnect、restart

- terminal Pi response 已到达 → `Completed`；否则 runtime crash/bridge EOF/writer failure/protocol fatal → `Indeterminate` + safe `runtime_crashed`；
- disconnect 不取消 operation；重连 client 必须通过授权 scope 查询 `operation_status_request`；
- host restart 后 pending record 必须恢复 `Indeterminate` 或明确 fail closed，不得伪装完成；
- owner revoke、generation change、TTL expiry → `Revoked`/`Expired`，不得泄露 cached response；
- client 收到 `event_sequence_gap` 必须请求 snapshot，不能盲目重放 mutation；
- runtime event sequence 按 target 单调递增；terminal event 带 operationId，turn lifecycle 带 turnId；
- active turn 绑定 `turnId → operationId`。abort 必须带 turnId，target/scope/current active turn 不匹配时只做成功 no-op/stale disposition，绝不转发给后继 turn。

当前 host event broadcaster 有 lag → `event_sequence_gap` 错误，native coordinator 有 per-instance sequence；但 operation registry、crash event、snapshot-required、turn-bound abort 尚未实现。

### 7.3 Reconnect order

1. 重新 hello/authenticate；
2. 从 owner/registry 取得 current workspace + generation；
3. 重新授权 target subscription；
4. 收到 snapshot（含 sequence/state）后再消费增量；
5. 查询 pending/indeterminate operations；不因 UI timeout 自动重发 mutation。

不得用旧 capability、旧 device token、旧 generation 或旧 target 强制恢复。

## 8. v1 adapter mapping

### 8.1 Adapter rule

D2 规定 v1 仅为 server-side transition adapter。adapter 接收 legacy `broker_control`/legacy event，先把已认证 legacy `VerifiedClientContext` 转成内部 `HostClientContext`，再映射到 canonical v2 handler；不能让 v2 client 使用 `broker_control` 作为新协议名字，也不能创建第二套授权规则。

| legacy surface | v2 mapping | 必须保持 |
| --- | --- | --- |
| `broker_control` session lifecycle | `runtime_request` 或 host lifecycle operation | owner/route/generation、Pi side effect、error、progress、reconnect |
| legacy Pi events / `broker_event` | `runtime_event` | target、sequence、unknown-event tolerance、gap→snapshot |
| legacy `send_user_message`/prompt | `runtime_request.command.prompt` | idempotency、operation acceptance、stream event ordering |
| legacy abort | v2 turn-bound abort | old turn 不得中止 new turn |
| legacy snapshot/mirror sync | `runtime_snapshot_request` + `runtime_snapshot` | authoritative leaf/state/messages/stats 与 sequence |
| legacy HTTP data routes | v2 `data_request` 或 retained authenticated compatibility route | path/root authority、limits、errors、cancellation |
| legacy native controls | `host_request` | Native owner only；Remote/LAN 不得绕过 |
| legacy `/api/rpc` | only if D8 approved: versioned compatibility endpoint | deprecation header、N-1 window、anonymous client-class counters、最终 removal |

Legacy `VerifiedClientContext` 已在 `broker_ws.rs` 中区分 native capability owner 与 remote flow；当前 broker command handler 仍覆盖大量 controls。`HostClientContext` 尚未实现，因此上述 mapping 是 approved contract，不是已完成 parity。任何 mapping 必须逐项引用 Gate A ID，不得用“generic forward”隐藏权限差异。

### 8.2 Adapter deletion

迁移期间 adapter 只能在 canonical handler 之后做转换；不得把 host-origin UI 改成同时连接 host v2 与 legacy broker v1。P7/P8 删除前必须有 caller scan、AST/deletion proof、compatibility telemetry（若 D8 retained）、real Pi smoke、zero supported legacy caller 证据。D8 仍由 Gate A external caller 结果决定，本文不替 D8 拍板。

## 9. Limits 与 binary transport

### 9.1 Physical limits

| Surface | 当前证据 | v2 contract |
| --- | --- | --- |
| canonical WS inbound frame | `HostServer::MAX_WS_MESSAGE_BYTES = 16 MiB`，axum `max_message_size` | 16 MiB physical frame；超限 `frame_too_large` 并拒绝/关闭，不截断 |
| Pi stdin RPC frame | `NativePiManager::MAX_RPC_FRAME_BYTES = 16 MiB` | physical alignment only；不代表业务 prompt 可达 16 MiB |
| generic host HTTP body | `DefaultBodyLimit = 1 MiB` | 1 MiB default；route-specific override 必须显式 |
| runtime command payload | 未实现独立检查 | `RUNTIME_REQUEST_COMMAND_MAX_BYTES = 1 MiB`；超限 `command_too_large`，prompt 改用 paste-offload |
| paste-offload | legacy inventory/design 要求现有至少 4 MiB | route-level ≥4 MiB；不能被 generic 1 MiB 意外截断 |
| outbound response/event | 未实现统一 bound | serialized-byte bound；超限不得发半 JSON，使用 `response_too_large` |
| outbound snapshot | 当前无独立 bound/token fallback | 独立较低 bound；用 authorized snapshot/download token、bounded summary 或 `snapshot_too_large` |
| progress | 当前 updater `ProgressSink` 可发 JSON，无 v2 bound | small fixed JSON、request-local monotonic sequence；可 coalesce/drop nonterminal progress，terminal 不可丢 |

每个适用 limit 必测 `limit-1`、`limit`、`limit+1`，分别覆盖 inbound/outbound、slow consumer、broadcast lag、disconnect、cancel。物理 frame limit 与业务 JSON limit 必须分开断言。

### 9.2 HTTP binary/download handles

所有 binary route（file raw、export、session file、paste/offload）必须：

- 只接受 relative path 或 host mint 的 opaque handle；不接受 browser authoritative absolute path；
- 在 open 前检查 capability/device、owner、wid、generation、scope；需要时在 stream/read 期间重验；
- 明确 TTL、quota、one-shot/replay、owner revoke、generation change、process restart 行为；
- MIME allowlist、`X-Content-Type-Options: nosniff`、适用时 CSP/sandbox、`Content-Disposition` filename header-injection 防护、Cache-Control；
- 明确 Range support 或明确拒绝；
- disconnect → abort stream/task、关闭 descriptor；
- 记录 TOCTOU 与 Windows descriptor 行为，不虚称 canonicalize 已解决同用户竞态；
- audit/log 不含 raw path、token、credential。

当前 host_server 只提供 static、health、bootstrap、pairing、v2 WS；没有实现这些 binary routes/handle registry。Gate A 已确认 legacy `/api/files/raw`、`export_html`、session-file download、paste-offload 的迁移要求；实现前不可宣称 parity。

### 9.3 Progress、backpressure、cancel

Progress 与 runtime event 分离：progress 只属于 request，序列按 request 单调；runtime event 按 target 单调。发送队列必须有 bounded capacity；slow consumer 不能无限堆积、阻塞其他 target 或导致 process stdin 无限等待。非 terminal progress 可 coalesce/drop；terminal response、error、snapshot-required 不可 drop。broadcast lag 必须生成 `event_sequence_gap`，客户端 hydrate snapshot。

Cancellation 分类：

- client disconnect 不自动取消 mutation/abort；
- 明确可取消的 read、HTTP stream、progress operation 才接受 cancel signal；
- abort 是 turn-bound command，不是 generic request cancellation；
- timeout 不等于 mutation cancellation；
- Pi bridge EOF、child exit、writer failure、fatal protocol frame 必须统一触发 pending rejection + runtime crash semantics（当前 native manager 尚未做到）。

## 10. LAN、loopback、pairing、auth matrix

### 10.1 Deployment states

| State | Bind | Auth | Allowed surface |
| --- | --- | --- | --- |
| default desktop | `127.0.0.1`/approved loopback only | desktop capability for owner controls | host-origin desktop + public health/static |
| pairing enabled | explicitly approved interface；默认仍 loopback | pairing token only for exchange；不作为 runtime bearer | pairing UI/exchange surface，rate/expiry required |
| paired LAN device | approved interface | device token + target visibility policy | only explicit remote allowlist；默认 read-only/limited |
| unpaired LAN/browser | never trusted by CORS/peer address | none | public health/static only; runtime/data/control deny |

当前 `HostServer::start_with_workspaces` 明确 bind `Ipv4Addr::LOCALHOST`，所以 LAN 尚未实现。当前 `/v2/auth/exchange` 是 pairing token→device token，不是 desktop capability issuance；`RemoteAuth` pairing lifetime 为 5 分钟、单次 exchange，device token 存 hash-backed metadata store，可 revoke。QR/bind/interface/firewall/port policy 尚无 host implementation evidence。

### 10.2 Auth and network matrix

| Requester / condition | health/static | runtime snapshot/event | prompt/steer/abort | route/session change | host writes / OS / secrets |
| --- | --- | --- | --- | --- | --- |
| NativeDesktop + valid capability + current generation | allow | allow target scope | allow policy/state/turn | allow owner lifecycle | allow owner-only, secret never returned |
| NativeDesktop missing/invalid/expired/revoked capability | public only if deployment exposes it | deny | deny | deny | deny |
| PairedRemote + valid device token + explicit allowlist | allow | only approved target/read set | default deny | deny by default | deny |
| PairedRemote revoked/expired/wrong device | public only | deny | deny | deny | deny |
| Unpaired browser, loopback or LAN | public health/static only | deny | deny | deny | deny |
| Any requester cross-owner/cross-wid/cross-generation | no scope expansion | deny | deny | deny | deny |
| Temporary runtime target | public policy only | explicit owner-bound ephemeral policy | explicit policy only | deny synthetic wid | deny unless exact owner control |

Further checks: Host header/origin allowlist, DNS rebinding, proxy bypass for loopback HTTP, non-loopback peer handling, CORS isolation, firewall failure, QR redaction, network reconnect, owner disconnect, device revoke, runtime crash. CORS must never be used as auth.

## 11. Error ownership and redaction

### 11.1 Stable error ownership

| Layer | Codes / responsibility |
| --- | --- |
| frame/router | `handshake_required`, `protocol_mismatch`, `invalid_client_id`, `invalid_frame`, `invalid_target`, `invalid_command`, `idempotency_key_required`, `unknown_frame_type` |
| capability/auth | `unauthenticated`, `capability_expired`, `forbidden_class`, `owner_revoked`, `unauthorized_device`, `pairing_rejected` |
| target/workspace | `invalid_workspace`, `workspace_not_found`, `not_registered`, `cross_workspace`, `stale_generation`, `runtime_not_found`, `unknown_target` |
| runtime/operation | `not_ready`, `runtime_crashed`, `duplicate_pending`, `duplicate_completed`, `operation_not_found`, `operation_expired`, `stale_turn`, `request_cancelled`, `upstream_unavailable` |
| path/data | `path_outside_workspace`, `invalid_path`, `not_a_directory`, `file_access_failed`, `file_conflict` |
| transport/limit | `frame_too_large`, `command_too_large`, `snapshot_too_large`, `response_too_large`, `event_sequence_gap` |
| migration | `unimplemented_route` only in compatibility adapter; never generic v2 success |

Current host_server has `structured_error` and several codes, but many current messages are generic (`runtime_request_failed`, `snapshot_failed`) and host capability/target errors are not yet normalized. Frontend must depend on documented code, not error text.

### 11.2 Redaction invariant

Never send/log/telemetry/crash-report: desktop capability, pairing/device token, skill-install secret, OAuth credential, Telegram token, raw config secret. Also avoid raw cwd, HOME, PATH, extension path and session path in client-visible errors and telemetry. Errors may include safe classification (`spawn_failed`, `runtime_crashed`) but not upstream parser text containing secrets.

Evidence: capability script avoids URL; RemoteAuth stores device-token hash rather than plaintext DB; architecture forbids skill secret exposure; ephemeral environment tests ensure markers carry no capability/token. Gaps: native/host unified redactor absent；Pi stderr diagnostics bounded but not redacted；legacy bootstrap startup error uses URL query and requires sanitization；stdout/parser error forwarding can expose upstream text。

## 12. Complete required security and limit test matrix

### 12.1 Handshake/capability/auth

- no hello、non-hello first frame、protocol 1/3、missing/empty/invalid client ID；
- desktop missing/wrong/expired/revoked capability；invalid capability never downgrades to remote；
- capability not present in URL/query/hash/static HTML/HTTP response/clipboard/log/telemetry/crash/remote bootstrap；
- two windows: capability A cannot access owner B；same owner wrong window label denied；
- window destroy/reload/host restart invalidates old capability；new injection works；
- remote pairing token single-use、expired、wrong device、replay；device token revoke immediately denies WS；
- desktop capability and remote device token cannot be exchanged or accepted in each other’s field；
- unpaired loopback/LAN can access only explicitly public health/static；CORS/origin/Host header does not grant control；
- DNS rebinding、proxy、non-loopback peer、approved interface/firewall failure。

### 12.2 Target/Temporary/transition

- Registered wid resolves canonical root；missing wid returns `not_registered`；
- browser-supplied root/port/cwd/session path/owner/generation ignored or rejected；
- cross-owner wid/session/instance、cross-wid instance、unknown instance、stale generation denied；
- subscription denied before state insertion；post-subscribe visibility revocation stops events；
- `Temporary` default/Quick/Side synthetic wid denied；no registry add/touch; restart does not adopt child；
- temporary→formal bind only after host-derived formal identity；old temporary target/handle fails；
- prepare/commit/cancel races、double commit、stale cancel、owner revoke during transition；
- event target confusion and session_owners map mismatch；
- remote cannot answer desktop extension/trust dialog。

### 12.3 Operation/sequence/reconnect

- first/pending/completed idempotency replay；same key different scope does not dedupe；
- operation status authorization、unknown/expired/revoked operation、TTL/capacity/eviction；
- disconnect does not cancel mutation；instance replacement preserves logical operation mapping；
- host restart pending→Indeterminate；crash before/after terminal response split；
- EOF、child exit、writer failure、oversized/fatal protocol frame all produce consistent crash/pending behavior；
- sequence monotonicity per target；broadcast lag → gap → snapshot; no blind mutation retry；
- A turn abort disconnect→A ends→B starts→old A abort rejected/no-op；duplicate abort；cross-owner turn ID；
- bounded queues: slow consumer, full queue, coalesced progress, terminal response delivery。

### 12.4 Limits/binary/paths

- every applicable inbound/outbound limit at `limit-1`, `limit`, `limit+1`；physical 16 MiB vs command 1 MiB distinct；
- malformed JSON, oversized UTF-8, nested JSON, response/snapshot oversized no partial JSON；
- generic HTTP 1 MiB vs paste ≥4 MiB route override；disconnect cancels stream and closes descriptor；
- raw/export/session-file handles: owner/wid/generation/TTL/quota/one-shot/replay/revoke/restart；
- MIME confusion, nosniff, Content-Disposition injection, Range policy, cache policy；
- traversal, sibling prefix, symlink escape, root delete, file/dir mismatch, TOCTOU documented behavior；
- no raw path/token in logs/errors/telemetry；
- backpressure, broadcast lag, cancellation, reconnect with real HTTP/WS adapter shapes。

### 12.5 v1 adapter/parity

- every Gate A legacy caller maps to one v2 route/control/event or documented retirement；
- adapter accepts only authenticated legacy context and invokes same canonical authorization; no double WS；
- field/error/side-effect/progress/order parity fixtures；
- legacy `/api/rpc` decision remains blocked by D8 external caller evidence；
- adapter deprecation header/support window/anonymous client-class usage counter only if D8 retained；
- AST/caller scan proves deletion only after zero supported caller and real Pi smoke。

## 13. Evidence gap register

| ID | Gap | Implementation owner / closure evidence | Gate-design impact |
| --- | --- | --- | --- |
| B-GAP-01 | v2 desktop capability not required/validated by HostRouter/HostServer | P2.1–P2.2 security tests | Design gate input; does not block Gate B-design |
| B-GAP-02 | HostClientContext absent; router stores only ClientKind | P2.2 context/auth tests | Design gate input; does not block Gate B-design |
| B-GAP-03 | target auth/subscription visibility not owner/registry scoped | P2.3–P2.4 authorization tests | Design gate input; does not block Gate B-design |
| B-GAP-04 | Registered-only inverse lookup not wired; HostDataPlane bare map remains | WP-R.1/.2 + P1.8–P1.9 authority tests | Gate R/P1 input; does not block Gate B-design |
| B-GAP-05 | Temporary policy not wired into native runtime; synthetic native wid exists | P1.8/P2.4 temporary-admission tests | Design gate input; does not block Gate B-design |
| B-GAP-06 | Operation Registry absent; coordinator cache per instance | P1.1–P1.2 operation/restart tests | Design gate input; does not block Gate B-design |
| B-GAP-07 | turn-bound abort, crash event, snapshot-required, pending indeterminate absent | P1.3/P1.5 crash and abort tests | Design gate input; does not block Gate B-design |
| B-GAP-08 | business inbound/outbound limits and bounded backpressure absent | P2.7/P7 limit and transport tests | Design gate input; does not block Gate B-design |
| B-GAP-09 | binary/download handle routes absent | P6 HTTP binary/handle tests | Design gate input; does not block Gate B-design |
| B-GAP-10 | v1 adapter not implemented and cost not measured | P2.5/P3.4 adapter tests and measured feasibility | D2 reopen evidence only; does not block Gate B-design |
| B-GAP-11 | LAN bind/firewall/QR/network policy absent | P2.8 deployment/security tests | D4 deployment input; does not block Gate B-design |
| B-GAP-12 | unified redaction absent; stderr/bootstrap error paths may leak | P2/P3/P5 redaction tests | Design gate input; does not block Gate B-design |
| B-GAP-13 | OAuth v2 lifecycle absent (`oauth:false` current capability) | P5 OAuth lifecycle tests | P5 input; does not block Gate B-design |
| B-GAP-14 | D8 external caller evidence remains incomplete despite Gate A inventory | Gate A external evidence; D8 decision before P7/P8 | D8 remains pending; does not block Gate B-design |

## 14. Gate B-design closure and implementation handoff

**Gate B-design may close at CP1 when B1–B6 design deliverables are reviewed and accepted.** This design closure means the canonical wire shape, capability/device-token distinction, Registered-only/Temporary fail-closed policy, operation and sequence contract, v1 adapter mapping, limits, binary handles, backpressure/cancel, LAN matrix, error ownership, redaction requirements, and required test matrix are fixed as implementation inputs. It does **not** claim that runtime/security implementation exists or that any B-GAP is passed.

B-GAP-01–14 remain mandatory implementation/acceptance items. Each gap closes only when its listed owner phase supplies the implementation and tests; a green Gate B-design review cannot waive, merge, or downgrade those checks. The phase exit that owns a gap must report its result, and dependent release gates remain blocked until required gaps pass. This removes the circular dependency: Gate B-design unlocks the phase work; phase exits close the corresponding B-GAP items.

| Phase / gate | Required B-GAP closure inputs |
| --- | --- |
| Gate R | B-GAP-04（Gate R 半边：仅 WP-R.1/.2 registry authority 与 Registered-only lookup 输入；其 P1.8–P1.9 wiring 半边归 P1 exit，不作 Gate R 前置，与 §13 表 owner 一致） |
| P1 | B-GAP-05–07: temporary admission, Operation Registry, crash/turn safety |
| P2 | B-GAP-01–03, 08, 10–12: capability/context, target authorization, limits/backpressure, adapter feasibility, LAN policy, redaction |
| P5 | B-GAP-13 and any file/config/OAuth redaction dependencies |
| P6 | B-GAP-09: binary/download handles |
| Gate A / P7/P8 | B-GAP-14: external caller evidence and D8 decision |
| Gate D / P3/P8 | rollout telemetry/cohort evidence; D10 remains separately pending |

**D2 reopening:** do not reopen based on current implementation incompleteness alone. D2 remains approved: build/evaluate server-side v1 adapter first. Reopen only with a measured review showing adapter cost unacceptable, then submit explicit alternative for authentication, routing, upgrade and deletion. Do not silently choose host-origin dual WS or permanent v1.

**D4 reopening:** no reopening required. D4 remains approved: loopback default, separate opt-in LAN phase. Current evidence supports keeping LAN disabled. Reopen only if product scope changes (LAN required in this phase) or security/deployment evidence invalidates the approved opt-in model; missing LAN implementation is not permission to broaden bind policy.

Other required reopen/escalation: D5/Gate R must close before target implementation; D8 remains pending external caller evidence; D10 cohort threshold remains Gate D. No production Rust/JS change is implied by this document.

## 15. Verification record

Read-only verification performed:

- read `AGENTS.md`、`ARCHITECTURE.md`、`docs/engineering-lessons.md`、Gate A inventory、native migration design and Gate C launch contract；
- inspected current `host_router.rs`、`host_server.rs`、`broker_ws.rs`、`native_pi_manager.rs`、`runtime_coordinator.rs`、`command_policy.rs`、`window_owner.rs`、`metadata_store.rs`、`remote_auth.rs`、`main.rs` and relevant tests；
- inspected working tree before writing；existing dirty production/spec/tool files preserved；
- did not modify production Rust/JS；did not run write-oriented commands or tests。

Recommended next step: CP1 review Gate B-design acceptance; then Gate R closure review for B-GAP-04 and a focused P1/P2 security test plan. B-GAP-05–07 remain P1 acceptance inputs and must not be treated as Gate R prerequisites.
