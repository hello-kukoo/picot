# Gate D：UI parity、existing-shell adapter 与 rollout 证据稿

> 状态：**Gate D 未关闭**。本文是 2026-08-28 只读逆向盘点与 adapter 可行性记录，不是 production implementation，也不宣称 P3 可启动。
>
> 证据来源：`AGENTS.md`、`ARCHITECTURE.md`、`docs/engineering-lessons.md`、`2026-08-27-native-runtime-migration-design.md`、`2026-08-27-native-runtime-migration-plan.md`、Gate A inventory、Gate B protocol contract、Gate C launch contract；以及 `public/index.html`、`public/app.js`、`public/app/websocket-client.js`、`public/app/transport.js`、`public/bootstrap-entry.js`、`src-tauri/src/{main.rs,host_server.rs,host_router.rs,broker_ws.rs}`。
>
> 本次没有修改 production UI、transport、origin、flag、Rust 启动/路由代码；没有提交；仅做只读检查与文档写入。

## 1. 结论

1. **Existing shell 是可复用的 parity 基础，但当前不能直接接 v2 Host。** `public/index.html` 与 `public/app.js` 承载完整现有 UI；它们依赖 legacy Pi-origin REST `/api/*` 与 legacy broker WS（`brokerWs` query → `WebSocketClient` → `broker_control` / `broker_event`）。Host v2 当前仅有 `/v2/ws`、`/v2/bootstrap`、静态服务和 pairing exchange，且 desktop capability 尚未由 `HostRouter`/`HostServer` 验证。
2. **推荐 adapter 形态：server-side protocol adapter + existing-shell transport façade。** 不把 production shell 改成双 WS；不把 `/app/` native shell 当 parity 方案。适配层必须把已认证 v1 context 转为统一 `HostClientContext`，再调用 canonical v2 handler；保留的 `/api/*` 必须是 host-origin、owner-aware compatibility route，不能 silent fallback 到 Pi origin。
3. **Prototype 与 real-Pi smoke 已运行，但 Gate D 仍未关闭。** `scripts/prototype/` adapter fixture 已执行通过（37/37，证据见 `2026-08-27-adapter-prototype-evidence.md`）；`bun run smoke:host-origin-p3` 已通过真实 Rust HostServer + embedded Pi 基础路径。Browser/WebView 验收改为人工 E2E，清单见 `2026-08-30-p3-manual-e2e-checklist.md`。完整 real-Pi interaction、browser static matrix 与 parity evidence 仍缺，因此 D2 暂不触发重开，Gate D 保持开放。
4. **D10 未决。** 下方阈值均明确标记为 proposed，不能当作 Dr. Lin 已批准决策。

## 2. 现状证据与边界

### 2.1 Existing shell

- `public/index.html` 是完整聊天壳：sidebar、主聊天、composer、file preview/browser、Info/Git tabs、settings、Quick/Side Chat 容器、Super Agent 组件。
- `public/app.js` 是 orchestrator，已接入 session、stream、files、Git、Terminal、settings、ephemeral、i18n、workspace transition 等模块；不应借迁移把业务逻辑塞回该文件。
- `public/app/websocket-client.js` 当前协议版本默认 `1`，从 `?brokerWs=` 或 sessionStorage 解析 broker URL；发送 `client_hello`，随后发送 `broker_command` / `broker_control`，接收 `capabilities`、`broker_event`、`mirror_sync` 等 legacy frame。
- `public/app/transport.js` 把生命周期/native 操作抽象成 `sendControl()`，底层仍是 `broker_control`。
- `public/bootstrap-entry.js`：路径以 `/app/` 开头时加载 `./native/app.js`，否则加载 `./app.js`。因此 `/app/workspaces/...` 不是 existing shell。

### 2.2 Host v2 当前证据

- `HostServer` 绑 `127.0.0.1:0`，提供 `/health`、`/v2/ws`、`/v2/bootstrap`、`/v2/auth/exchange`；静态服务 fallback 到 bundle，另有 `/v/{fingerprint}/` 内容指纹路径。
- `host_server.rs` 的 v2 WS 首帧读取 hello；remote device token 有验证；desktop capability 没有 host-side 验证，`HostRouter` 当前只记录 `Desktop/Remote`。
- `HostRouter` 已验证 v2 frame/version/requestId/target shape/idempotency key presence，但未实现 Gate B 要求的 `HostClientContext`、Registered target authorization 与 subscription-before-storage authorization。
- v2 当前 route 与 existing shell 的 API/事件字段不等价；不能把 host skeleton 视为 adapter 已完成。

## 3. 固定 namespace / static routing facts

| 路径 | 当前 entry / 行为 | 迁移结论 |
| --- | --- | --- |
| `/workspaces/:wid/sessions/:sid` | 应加载现有 `index.html`；`bootstrap-entry.js` 非 `/app/` → `app.js` | **P3–P8 production route，D1 固定** |
| `/app/workspaces/:wid/sessions/:sid` | `index.html` → `native/app.js` | experimental；不计入 parity |
| `/app/settings` 等 | native shell 路径 | experimental；不承载 production settings |
| `/v/<fingerprint>/...` | `HostServer` 用静态 bundle 路径 + 替换 `<base href="/">`；禁缓存 | 静态资源 cache-busting 机制已存在，必须由 prototype 验证所有资源类型 |
| `/health` | Host health JSON；不代表 runtime ready | 启动探针与 UI ready 必须分开 |
| `/v2/ws` | canonical v2 WS 候选 | existing shell 不能直接把 legacy frame 发入该 endpoint |
| `/v2/bootstrap` | `workspaceId/sessionId` query，返回 runtime target | 当前只按 native runtime map 查找，不能视为 Registered authority |
| `/api/*` | legacy embedded-server route；existing shell 大量直接 fetch | P3 只能保留 owner-aware compatibility route；禁止 Pi-origin fallback |

Static facts：

- `index.html` 里的 `<base href="/" />` 会被 HostServer fallback 替换为 `/v/<fingerprint>/`。因此相对 module/CSS/worker/icon 资源应从 fingerprint namespace 解析。
- root-relative `fetch("/api/...")` 不受 `<base>` 影响，仍请求当前 Host origin 的 `/api/...`。这既不会自动变成 `/v2/*`，也不会自动请求旧 Pi port；若 compatibility route 不存在，必须显式失败而不能隐式降级。
- `bootstrap-entry.js` 的 `/app/` 分支是静态路径判定，不是 feature flag；只改 Host window URL 就会改变加载的 UI shell。
- 当前 legacy desktop window URL 是 `http://localhost:<pi-port>/?brokerWs=<broker-url>`，由 `main.rs::open_workspace_window` 生成；native 实验窗口是 `${host_origin}/app/workspaces/...`。两者都不是 D1 production URL。
- `brokerWs` 是 legacy broker discovery/state carry mechanism，存在 URL 与 sessionStorage 两处来源；P3 若仍依赖它，必须说明它只指向 server-side adapter，不得指向 Pi-origin；P8 才能在 caller/deletion proof 后移除。

## 4. UI parity matrix（critical paths）

状态含义：`现有` = existing shell 有生产 caller/实现；`adapter required` = 不可直接复用，需明确 v2/compat mapping；`gap` = 当前没有 parity evidence。所有条目必须在 P3 prototype 中变成可执行 test case；此表不是删除证明。

| Critical path | Existing shell evidence / caller | 当前 transport | Host terminal / adapter contract | 验证证据要求 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 首次加载 / bootstrap | `index.html`、`bootstrap-entry.js`、`app.js` module graph | 当前 Pi static origin | Host `/workspaces/:wid/sessions/:sid` → existing shell；capability 注入不进 URL；`/v/<fingerprint>` base | browser load + no blank screen + dynamic import/CSS/worker | adapter required |
| WS hello / auth | `websocket-client.js::_sendClientHello` | legacy `client_hello`, capability optional | v2 `hello` + desktop capability / remote device token → `HostClientContext`; invalid capability 不降级 | valid/missing/expired/cross-owner handshake tests | gap（Host 未接 capability） |
| prompt / steer / follow-up | `app.js` RPC/composer handlers；Gate A A-WS-10/29/30/42 | legacy WS command 或 `/api/rpc` | v2 `runtime_request`，mutation `idempotencyKey`，host `operationId`，terminal event | real Pi first event/terminal event/order/replay | adapter required |
| abort | `app.js` abort handlers；A-WS-01 | legacy RPC/WS abort | v2 turn-bound `turnId`；旧 turn stale no-op，不误 abort 后继 turn | disconnect A→A end→B start→old abort | adapter required |
| message stream | `handleMessageStart/Update/End`、`agent_end` | `broker_event` → `rpcEvent` | v2 `runtime_event` target+sequence；字段转译不得丢 `text_delta/thinking_delta/usage` | message/tool/thinking ordering、unknown event tolerance | adapter required |
| sequence gap / reconnect | `mirror_sync_request`、`connected/disconnected` listeners | broker reconnect + snapshot | v2 `event_sequence_gap` → authorized snapshot；不自动重发 mutation | forced lag/reconnect, snapshot watermark, no duplicate prompt | gap（现有仅 legacy semantics） |
| state/mirror snapshot | `mirror_sync`、`get_state/get_messages/get_session_stats` | legacy WS/`/api/rpc` | `runtime_snapshot_request` + target/sequence；需映射 active leaf/session/profile/stats | reload, background runtime isolation, leaf correctness | adapter required |
| new/switch session | `transport.newSession/switchSession`、`navigateToWorkspacePort` | broker control + Pi port navigation | host lifecycle/`runtime_request`；route/generation atomic；不再以 port 作 browser authority | same/cross workspace transition, stale generation | adapter required |
| fork / tree / edit | `transport.fork/navigateTree`、Info panel、`picot-bridge` | broker control → stdin RPC → `session_tree` | v2 lifecycle + snapshot；保持 `summarize:false`、same-port fork/tree semantics | real session branch fixture, tree event then snapshot | adapter required |
| sidebar/session list | `sidebar/index.js`、workspace registry controls | `/api/workspace-sessions`、`/api/instances`、workspace controls | v2 `list_sessions`/registry data；root/wid host-derived | name/path distinction, prune, cross-workspace | adapter required |
| Focus / workspace transition | `focus-state.js`、`workspace/actions.js`、`prepare/commit` | broker controls + URL params | registered wid + atomic owner snapshot；Temporary fail closed | consecutive cross-workspace switches, exactly-one file refresh | gap（authority not wired） |
| file tree | `workspace/file-browser.js` | `/api/files`、`/api/open` | v2 `list_files`/owner open; root host-derived, no browser absolute authority | traversal/symlink/403 stale-root, real workspace switch | adapter required |
| file preview/editor | `file-preview-panel.js` | `/api/files/content` GET/PUT | `file_read/file_write`; mtime/conflict/atomic write/error parity | edit/save/conflict/reload, 1MiB limits | adapter required |
| image/PDF/raw | preview renderers/PDF worker | `/api/files/raw` | v2 bounded binary handle/relative path, MIME/nosniff/cache/range policy | real image/PDF browser render, disconnect abort | gap（binary route absent） |
| MarkItDown | preview path / subprocess-backed legacy route | file preview REST | host data operation + same dependency states | supported/unsupported/error/large file | gap（host mapping absent） |
| Git status/diff/history | `GitClient`/`GitPanel` | native broker Git controls, not embedded HTTP | retain owner-scoped host Git controls; map frames, preserve snapshots/OID/path validation | status, stage/discard/commit/history, cross-owner | mostly existing host; adapter required |
| Terminal | `TerminalClient`/`TerminalPanel` | native broker terminal controls/events | v2 host operation/event or temporary server adapter; PTY lifecycle/backpressure | open/write/resize/close/restart/slow client | gap（v2 mapping absent） |
| system open / picker | sidebar/file preview/settings callers | broker control or `/api/open` | NativeDesktop-only host controls; remote/LAN deny | path/URL/platform/no-shell, capability denial | adapter required |
| Side Chat | `SideChatManager`、`ephemeral-chat-view.js` | owner-scoped broker ephemeral frames | explicit ephemeral adapter; owner+generation+quota; not Registered target | one-instance quota, transition/close/reconnect | gap（native full lifecycle absent） |
| Quick Chat | quick dialog/composer paste flow | ephemeral broker + `/api/paste-offload` | temp child opaque handle; no synthetic wid; binary offload bounded | 0700 child, cleanup, root-delete/symlink, large paste | gap（native full lifecycle absent） |
| models / auth catalog | settings models modules | WS commands + `/api/models-config` | v2 data/control; no credential return; refresh after writes | catalog refresh, redaction, provider errors | adapter required |
| OAuth | `settings/models-oauth-login.js` | legacy WS OAuth commands | desktop-owner-only v2 controls; Pi owns token exchange/persistence; current host says `oauth:false` | device flow/cancel/status/logout/generation | gap（not implemented） |
| skills / packages | settings skills/package modules | broker controls + install routes | native owner controls; lock/TOCTOU/opaque source handles | precedence/shadowing/empty manifest/lock/owner | adapter required |
| config / AGENTS / APPEND_SYSTEM | `config-gateway-legacy.js` consumers | `/api/*` + `/api/rpc` | host owner controls; settings lock/atomic/0600; global agent root | malformed/lock/secret redaction/refresh | adapter required |
| Telegram / Super Agent | `components/chat-settings-panel.js`, `super-agent/*` | `/api/chat-*`, `/api/super-agent/*`, legacy RPC | explicit host control/data mapping; token never telemetry; external timeout | 90s/failure/target authority/secret scan | gap（mapping未证） |
| cost dashboard | `cost/dashboard.js` | `/api/cost-dashboard` with range/granularity/scope/models | v2 `cost_dashboard` compatibility operation; preserve all/current scope, buckets, sort/cache | same JSONL fixture field-by-field; P50/P95 | adapter required |
| session search | `sidebar/index.js` | `/api/search` | v2 `search_sessions`, registered scope/bounds/snippets | same fixture, path/name/snippet/error bounds | adapter required |
| i18n/theme | `i18n.js`、theme bootstrap in `index.html` | `/locales/*`、cookie/localStorage first paint | static fingerprint path must resolve locales; DB/cookie reconcile unchanged | locale switch, fresh paint, missing locale | adapter required |
| keyboard/IME/a11y | HTML semantics、composer handlers | browser local + transport | no UI redesign; Enter/IME ordering preserved | keyboard/IME, focus, ARIA, viewport clamp | existing UI; test required |
| startup/reconnect/error | swap overlay、bootstrap window、WS reconnect | Pi health/broker reconnect | host ready separate from `/health`; safe redacted bootstrap error | startup fail, reconnect, crash, retry, no secret in URL | gap（redaction/host lifecycle） |

**Parity acceptance rule：** 每一行必须有至少一个真实 browser/interaction path；跨 adapter 的条目还需 contract test + real Pi smoke。仅 DOM/unit test 不足以关闭 appearance-sensitive 或 transport-crossing 条目。

## 5. Existing-shell adapter feasibility prototype（设计记录，非运行证据）

### 5.1 推荐形态

**选 `adapt`，不选 client-side replace 或双连。**

```text
existing app.js / websocket-client.js / transport.js
        │ stable façade (temporary compatibility client)
        ▼
Host-origin adapter endpoint
        ├─ legacy-compatible broker frame translation
        ├─ retained /api/* owner-aware compatibility routes
        └─ canonical Host v2 handlers / HostClientContext / Native runtime
```

理由：

- `app.js`、各模块与 HTML 有大量既有调用点；一次 replace 会把 UI parity 与 transport migration 耦合，扩大 P3 风险。
- 现有 `WebSocketClient` 的事件面（`connected`、`mirrorSync`、`rpcEvent`、`controlResponse`、ephemeral/Git/terminal events）可作为 temporary façade；内部可将 v1 envelope 适配到 v2，而无需主 UI 同时连接两个 WS。
- `public/index.html` 的 root-relative REST 调用数量大（Gate A inventory 已列 37 HTTP surfaces）；逐条迁移到 v2 前，保留 authenticated host compatibility routes 可降低 P3 blast radius，但每条必须有 authority、limits、error、deletion proof。

### 5.2 协议/base URL/brokerWs

| 项目 | prototype contract | 当前证据 / 风险 |
| --- | --- | --- |
| WS URL | 页面只连一个 Host-origin `/v2/ws` adapter endpoint；不得再连 Pi `/ws` | 当前 `resolveBrokerWsUrl()` 接受任意 query URL；需 host 注入/校验，不能信任 arbitrary URL |
| hello | façade 生成 v2 `hello`，host 注入 capability 仅存在内存 global；adapter 不把 credential 回送 JS telemetry/URL | 当前 client 发 `client_hello`，Host v2 要 `hello`；字段不兼容 |
| request correlation | façade 为每个 legacy control/RPC 保存 v1 requestId ↔ v2 requestId/operationId 映射 | 当前 control timeout/disconnect 会 reject；v2 mutation disconnect 不应自动取消，需明确 UI semantics |
| event translation | `runtime_event` → legacy `broker_event`/`event`，补 source/session metadata；保留 sequence/gap marker | 当前 app 依赖 `message_*`、`mirror_sync`、`session_tree` 等 legacy event shape |
| reconnect | reconnect 后 hello → target authorize → snapshot → pending operation status；再触发 legacy `connected` | 当前 client connected 只在 `capabilities` frame 后触发，无 v2 snapshot ordering |
| base URL | `/v/<fingerprint>/` 只用于相对静态资源；API 必须 Host-origin explicit route；不能因 `<base>` 让 API 指向旧 Pi | 当前 app 多数 `/api/*` 是 root-relative，恰好仍指当前 host，但 route 尚未实现 |
| `brokerWs` | 过渡期只允许 opaque/host-validated adapter URL；P8 删除 query/storage 依赖 | 当前 URL + sessionStorage 双来源会残留旧 broker；需 caller scan 与 no-Pi-origin test |
| `/api/*` | 仅保留明确 compatibility middleware；每 route 完整 auth/owner/generation/limit/error/cancel | Host 当前没有这些 legacy APIs；404 必须 visible stable error，不得 silent fallback |

### 5.3 Control/event mapping

- `broker_control` lifecycle → v2 `runtime_request` 或 `host_request`，按 Gate A authority 分类；不能用一个 generic forward 隐藏 picker/Git/registry/ephemeral 权限差异。
- `broker_event` Pi session events → v2 `runtime_event`；每个 event 要补 host target/sequence，unknown event 不得使 façade 崩溃。
- `mirror_sync` → authorized `runtime_snapshot`；恢复顺序固定为 snapshot watermark → UI state/profile → incremental events。
- `control_progress` 保持 request-local sequence；慢客户端可丢非 terminal progress，不能丢 terminal response。
- `/api/rpc` 仅在 D8 明确 retained 后适配；不能先实现一个无界 generic tunnel。D8 当前仍 pending external caller evidence。

### 5.4 Owner auth / security

Prototype 必须拒绝：缺 hello、错误 protocol、missing/invalid/expired/revoked desktop capability、remote 冒充 desktop、cross-owner target、cross-workspace/generation、Temporary synthetic wid、unpaired browser control。loopback peer/CORS 不得替代 capability。

当前 Host v2 缺 `HostClientContext` 与 desktop capability validation，故这不是“接线即可”的低风险 wrapper；P2 security substrate 是 P3 前置条件。

### 5.5 Prototype 边界

adapter fixture 已隔离在 `scripts/prototype/`，不改 production UI/transport/origin/flag；它证明 wrap/façade 映射机制与契约测试可运行，不证明完整 browser parity 或完整 real-Pi interaction。基础 HostServer production wiring 与 real-Pi host-origin smoke 由 `bun run smoke:host-origin-p3` 覆盖；browser validation 按人工 E2E 清单执行。**Gate D：design-closure（2026-08-30，Dr. Lin 指令；按 R4.7 同构拆分先例）**——substrate 层证据（adapter prototype 37/37、real HostServer + real-Pi host-origin smoke 复验、capability handshake / owner-bound bootstrap / wrong-workspace 403 / missing-capability 401、WebSocketClient gap→authoritative snapshot）关闭 D-GAP-02/06/07/08 的实现面；**浏览器级证据残项显式移交 P3.5 人工 E2E 清单（`2026-08-30-p3-manual-e2e-checklist.md`）与 D10 Stage 0 准入**，随 P3 human acceptance / release exit 关闭。rollout 框架随 D10 框架性批准（同日）定案。

## 6. Telemetry schema（匿名；方案提案，不是已决定实现）

以下为 **proposed / D10 input**。Schema 不记录 capability、device token、prompt、path、session file、cwd、port、URL query、raw error、credential 或 upstream text。client installation/window 可使用短期随机 installation bucket，但不得可逆关联用户身份。

```json
{
  "schemaVersion": 1,
  "anonymousClientClass": "native_desktop|paired_remote|unpaired_browser|unknown",
  "runtimeMode": "legacy|native",
  "flagState": "off|dogfood|cohort|default_on|invalid_fallback",
  "protocolVersion": 1,
  "routeFamily": "existing_shell|native_shell|bootstrap|static|v2_ws|legacy_api|compat_api",
  "operationFamily": "bootstrap|chat|session|files|git|terminal|settings|ephemeral|cost|search|other",
  "outcome": "success|failure|cancelled|timeout|reconnect|crash|fallback",
  "failureCode": "stable_redacted_code_or_null",
  "latencyBucketMs": "0_100|101_500|501_2000|2001_10000|over_10000",
  "eventCountBucket": "0|1_10|11_100|over_100",
  "payloadSizeBucket": "0_1k|1k_64k|64k_1m|over_1m",
  "sequenceGap": false,
  "buildChannel": "dev|stable|unknown",
  "hostOsFamily": "macos|windows|linux|unknown",
  "createdAtBucket": "YYYY-MM-DD"
}
```

约束：

- `anonymousClientClass` 只记录 coarse class，不记录 owner/client ID；若 class 无法可靠派生则 `unknown`，不能由浏览器自报提升权限。
- `failureCode` 只能是 allowlist stable code（如 `handshake_rejected`、`runtime_crashed`、`event_sequence_gap`、`command_too_large`）；禁止上游错误文本。
- 默认采样建议为 100% failure/crash/sequence-gap、低比例 success；比例属于 proposed，需 D10 评审。
- Telemetry transport 失败不得阻塞聊天、不得重试 mutation、不得记录请求正文。

## 7. Cohort rollout 与 D10 门槛（全部 proposed）

### 7.1 Flag/rollout facts

- 唯一 release source 应为 Gate R 交付的 `preferences.runtime.native_origin`；Rust launch-time 读取。
- schema/value/read failure 必须 fail closed 到 legacy；debug env 仅 debug/developer build，不能成为 release authority。
- default off → internal dogfood → opt-in cohort → default on；至少两个稳定 release 周期观察后才考虑 default-on。
- running runtime 不因 flag 改变自动热切换；flag 在 launch boundary 生效。rollback 必须先处理 running child、owner/operation state，再重启旧 artifact。

### 7.2 Proposed D10 decision inputs

D10 尚未拍板。建议 cohort 每阶段至少满足以下**提案阈值**，连续两个完整观察窗口（建议每窗口 7 天或 ≥1,000 个匿名 native sessions，取先到者；样本不足则不判定）：

| 指标 | proposed proceed threshold | proposed stop/rollback threshold |
| --- | --- | --- |
| startup success / no bootstrap failure | ≥99.5% 且不低于 legacy baseline 0.2pp | <99.0% 或比 legacy 差 ≥0.5pp |
| prompt-to-first-event success | ≥99.0% | <98.5% |
| runtime crash per session | 不高于 legacy baseline +0.1pp | 高于 legacy baseline +0.3pp，或出现重复 crash cluster |
| reconnect recovery with authorized snapshot | ≥99.0% | <98.0% 或出现 stale-target write |
| event sequence gap unresolved after snapshot | ≤0.1% sessions | >0.5% sessions |
| critical-path parity failure (P0 matrix rows) | 0 confirmed severity-1/2 regression；severity-3 有 workaround | 任一 security/credential leak、cross-owner leak、不可恢复 data loss |
| p95 latency vs legacy | each critical op ≤ legacy +20% | any critical op > legacy +50% for 2 windows |
| fallback rate | ≤1% sessions，且原因可分类 | >3% 或 unknown fallback >0.5% |

这些数值是**建议评审输入，不是已批准产品门槛**。必须先用 F0 performance baseline、legacy control sample、real Pi smoke 与 release telemetry 验证可测性，再由 Dr. Lin 决定 D10。

### 7.3 Stop conditions

立即暂停 cohort：任何 capability/credential/token/path 泄漏；cross-owner/workspace action；静默丢 prompt；旧 turn abort 影响新 turn；snapshot 恢复后 state/leaf 错乱；rollback 不能恢复 legacy；DB/settings schema 不兼容且无 backup；unbounded memory/backpressure；static asset 路由导致白屏。

## 8. Rollback runbook

### Flag off（首选）

1. 停止扩大 cohort，记录匿名 stable failure codes；不清除 operation records 或 running runtime。
2. 通过 rollout-authorized host writer 将 `runtime.native_origin=false`；普通 preference ingress 不得读/写该 namespace。
3. 新启动窗口 fail closed 回 legacy；确认 legacy `PiManager`、Pi-origin static、broker v1 可用。
4. 对 native 已运行窗口：禁止粗暴切 origin；先显示 reconnect/restart-required 状态，按 Gate C stop order 停 native child，revoke owner/handles，settle/reclassify operations，再由 legacy 启动并重新绑定 session。
5. 对 `Pending` operation：若已有 terminal response 记 `Completed`；否则 `Indeterminate/runtime_crashed`，不得自动重发；UI 要求用户确认并使用新 idempotency key。

### Artifact rollback / N-1

1. 停发当前 artifact，保留 session JSONL；不要用 git tag/source checkout 当用户恢复工具。
2. 检查 registry schema/user_version 与 N-1 binary 支持矩阵。若 N-1 不支持当前 schema，**拒绝启动并显示 recovery UX**，不可静默降级。
3. 使用 Gate R 已演练的 pre-upgrade DB backup/restore；先复制并校验 backup，再恢复 metadata/preferences。恢复失败时保持当前 DB 不覆盖，保留 session files。
4. 旧 static cache 通过旧 Host fingerprint namespace 隔离；启动后重新取得对应 artifact 的 static fingerprint，不能复用错误 bundle 的 cached `index.html`。
5. 终止/回收 native child、temporary Quick child、ephemeral handles、capabilities、subscriptions；旧 host 不得采用新版本残留 operation/target。
6. 运行 smoke：health、existing shell load、hello/broker reconnect、prompt first event、session list、file root、Git/Terminal（若 cohort 涉及）、settings read；记录平台差异。
7. 若 rollback 失败：保持 legacy-safe mode，阻止再次 native enable；输出不含 token/path/credential 的稳定错误码。

### Roll-forward after rollback

只有完成 root cause、修复、focused regression、real Pi smoke、N-1 compatibility check、telemetry dry run、Gate D review 后，才能重新启用 dogfood；不得自动恢复原 cohort。

## 9. P3 effort re-estimate inputs

当前计划明确 P3 在 adapter prototype 后重估，不能沿用旧“5 人日”承诺。必须先量化：

1. **Surface count**：37 HTTP、43 WS command baseline、broker controls、host v2 frames；以 Gate A generated inventory 为准，不手填常数。
2. **Caller churn**：`public/app.js`、sidebar、file preview/browser、settings legacy gateway、OAuth、ephemeral、cost/search、Super Agent、HTML/test 的实际 caller 数与动态 fetch exception。
3. **Adapter depth**：只做 server-side v1 façade，还是需改 client `WebSocketClient`；是否需要 per-route compatibility middleware；每类 event 是否有 lossless mapping。
4. **Auth substrate readiness**：HostClientContext、desktop capability validation、Registered resolver、generation/operation registry、Temporary policy是否已由 P1/P2/Gate R 提供。
5. **Static/origin work**：`/workspaces/` route fallback、fingerprint base、root-relative API、download links、navigation allowlist、capability injection、brokerWs removal。
6. **Parity execution**：matrix 中需 real Pi 的行数、browser E2E 数、Windows/macOS smoke、slow consumer/reconnect/sequence-gap 测试时间。
7. **Retained legacy scope**：D8 决定 `/api/rpc` 是否保留；每多一条 retained route 都增加 auth/limits/deprecation/telemetry/removal 负担。
8. **Release/rollback**：dogfood 观察窗口、N-1 DB recovery、artifact signing/resource resolution、support runbook。

**重估格式提案：**按上述 8 类给出 engineer-days range、未知项、验证成本、review buffer；prototype 通过前只报告范围，不给单点承诺。

**Prototype 量化结果（2026-08-29）：P3 coding 19–29 人日**（核心传输 6–8、映射表补全 5–8、static/origin 2–3、E2E parity 5–8、compat per-route 3–5；不含 P1/P2 substrate 与 dogfood 窗口）。详见 `2026-08-27-adapter-prototype-evidence.md` §3。D2 重开评估：未触发（façade 成本有界，无 lossless-mapping 阻断）。

## 10. Evidence gaps / closure checklist

| ID | Gap | Gate D impact | Required evidence |
| --- | --- | --- | --- |
| D-GAP-01 | 没有 runnable existing-shell adapter | **prototype 范围已关闭（2026-08-29，`2026-08-27-adapter-prototype-evidence.md`，37/37）**：wrap+façade 双形态可运行，capability 重连缓存缺陷已修；浏览器/真 Pi 部分归 D-GAP-02/06/07/08 维持开放 | Host-origin adapter + browser smoke + real Pi（后两项见对应 D-GAP） |
| D-GAP-02 | Host desktop capability 未验证；HostClientContext 未实现 | **substrate 已关（2026-08-30）**：HostClientContext 实现并接线；real HostServer smoke 覆盖 handshake/owner-bound bootstrap/403/401（复验 PASS）；浏览器 cross-owner/reconnect 残项 → P3.5 人工 E2E | handshake/capability cross-owner tests |
| D-GAP-03 | v1 broker 与 v2 WS 字段/hello/event 不兼容 | 不能声称 façade 可直接工作 | mapping fixture + reconnect/order tests |
| D-GAP-04 | `/api/*` host compatibility middleware 不存在 | existing shell fetch 会 404 或误走旧 origin | 每条 retained route 的 auth/error/limit test |
| D-GAP-05 | `brokerWs` 双来源（query/sessionStorage）仍存在 | 旧 broker/Pi-origin 残留风险 | host-only URL test、caller scan、removal plan |
| D-GAP-06 | `/app/` native shell 与 existing shell 分流 | **substrate 已关（2026-08-30）**：`/workspaces/` 路由与 `<base href>` 有 real HostServer/Rust 证据；浏览器 worker/download/`/app/` no-blank 残项 → P3.5 人工 E2E | `/workspaces/` route browser smoke；`/app/` only no-blank smoke |
| D-GAP-07 | static fingerprint 仅有 Rust unit/integration evidence | **substrate 已关（2026-08-30）**：fingerprint asset serving 有 real HostServer 证据；real browser static matrix（dynamic import/worker/download）残项 → P3.5 人工 E2E | real browser static matrix |
| D-GAP-08 | sequence gap → snapshot ordering 未接到 existing UI | **substrate 已关（2026-08-30）**：WebSocketClient 转发 v2 sequenced events/snapshot，gap 后请求 authoritative snapshot；unit/prototype + real-Pi smoke 覆盖 ordering/reconnect/snapshot；existing UI forced-lag 人工证据残项 → P3.5 人工 E2E | forced lag/reconnect browser test |
| D-GAP-09 | Temporary/default/Quick/Side native policy未完成 | ephemeral parity 与 auth 不成立 | owner/generation/quota/cleanup real lifecycle |
| D-GAP-10 | OAuth v2 当前 `oauth:false` | settings parity 未完成 | Pi-owned OAuth lifecycle + redaction tests |
| D-GAP-11 | Terminal/Super Agent/Telegram v2 mapping 未证 | critical path coverage incomplete | control/event mapping + platform smoke |
| D-GAP-12 | D8 `/v2/rpc` external caller evidence 未完成 | retained generic RPC 范围不能定 | external caller inventory / decision |
| D-GAP-13 | D10 threshold 未批准，success baseline 尚未采样 | P3/P8 rollout gate 未定 | Dr. Lin decision after telemetry dry run |
| D-GAP-14 | rollback real rehearsal 未执行 | release claim 不成立 | N/N-1 DB/static/running-child recovery rehearsal |
| D-GAP-15 | bootstrap startup error 仍把 raw error 放入 query（`main.rs`） | secret/path leakage risk | redacted error fixture and browser URL scan |

## 11. Gate D / D2 / D10 status

- **Gate D：不能关闭。** 文档、namespace、adapter prototype（37/37）与 P3 重估已具备；但 GD-2 所需的 real browser evidence、real Pi host-origin evidence、telemetry dry run 与 D10 决策仍未完成。
- **D2：仍按 Gate B 既有决议暂不重开。** 当前没有成本实测证明 server-side v1 adapter 不可接受；但 D-GAP-01 必须在 Gate D review 前补齐。若 prototype 失败或 adapter 成本超出复核门槛，再提交 D2 重开，不得自行改成双 WS。
- **D10：未决。** 本文 §7 的 cohort 数值与 stop thresholds 全部是 proposed，供 Dr. Lin 评审；不能写入 release authority，不能作为 P3/P8 已批准门槛。
- **P3：保持 blocked。** adapter prototype 已满足其原型子项且 coding range 已重估为 19–29 人日；仍需 Gate D 集成证据、P1/P2 substrate、telemetry dry run 与 D10 decision（按计划 Blocks），当前不能启动 production rollout。

## 12. Verification record

只读检查完成：

- 读取 `AGENTS.md`、`ARCHITECTURE.md`、`docs/engineering-lessons.md`、Gate A inventory、Gate B protocol contract、Gate C launch contract、native migration design/plan。
- 检查 `public/index.html`、`public/app.js`、`public/app/websocket-client.js`、`public/app/transport.js`、`public/bootstrap-entry.js`。
- 检查 `src-tauri/src/host_server.rs`、`host_router.rs`、`main.rs`、`broker_ws.rs` 的静态服务、namespace、hello、navigation/window URL、broker/frame、reconnect 相关事实。
- 检查 working tree；保留既有 dirty code/docs/tool 文件；本轮仅更新 Gate D 状态文字，没有新增 production code；已执行 adapter/host-origin focused tests、`bun run check`、`bun run check:rust` 与性能脚本可用性检查。
- 未声称 Gate D、D10 或 P3 已完成。

Recommended next step：按 `2026-08-30-p3-manual-e2e-checklist.md` 执行人工 browser/WebView static/interaction E2E，与 telemetry dry run、性能 fixture、dogfood 一起提交 Dr. Lin 评审 D10/Gate D。
