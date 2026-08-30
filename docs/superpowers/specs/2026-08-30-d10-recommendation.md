# D10 rollout recommendation — dogfood/cohort proposal

日期：2026-08-30  
状态：**已批准（Dr. Lin 指令「做 D10 拍板」，2026-08-30）——框架性批准：stages/thresholds/telemetry 契约/stop-hold-rollback runbook 按本提案全案生效。** Stage 0 准入仍以三件人工件（browser/WebView E2E、同 fixture 性能样本、dogfood）为前置；fail-closed / default-off 约束不变；不授予 default-on；§1 的全部约束作为阶段门条件继续生效。

依据：`docs/superpowers/specs/2026-08-27-ui-parity-and-rollout.md` §7，以及 P3 证据审计与 checkpoint：

- `2026-08-30-p3-evidence-audit.md`
- `2026-08-30-p3-checkpoint.md`
- `2026-08-30-p3-host-origin-smoke-evidence.md`

## 1. 决策边界

本文件只把 Gate D §7 的 rollout 方案整理成可评审的执行提案。当前没有 D10 批准；以下阶段、阈值、telemetry 与 rollback 条件均为 **proposed**。在 Dr. Lin 签署前：

- native runtime 保持现有 fail-closed / default-off 约束；
- 不扩大 production cohort，不切 default-on；
- 不把 telemetry dry-run 或 unit/real-Pi smoke 证据写成 rollout success；
- 不因 flag 改变对运行中的 runtime 做热切换。

## 2. Proposed rollout stages

### Stage 0 — instrumentation readiness

前置条件：

1. P3/Gate D 必需的 browser、parity、rollback 与 real-Pi interaction evidence 已按对应 checklist 验收；
2. telemetry production transport 已证明 failure non-blocking：上报失败不得阻塞聊天、重试 mutation 或泄漏请求内容；
3. 完成 legacy/native same-fixture control sample，记录 p50/p95、样本数、warmup、OS/build/Pi/data shape；
4. 明确 legacy baseline 与统计窗口；样本不足时不得判定 proceed。

### Stage 1 — internal dogfood

- 仅限内部、可识别但不进入 telemetry 的人工授权名单；建议观察 **14 天**。
- native flag 在 launch boundary 生效；不允许运行时热切换。
- 每个窗口保留 legacy control path，记录同 fixture 对照。
- 任一 Stop/Rollback 条件触发即暂停新增用户，按 §5 执行。

Stage 1 不等于 cohort approval；完成观察只产生 D10 review input。

### Stage 2 — opt-in cohort

- 仅在 Stage 1 达到 proceed threshold 后开放；建议从小比例、可回退 cohort 开始。
- 建议每个完整观察窗口为 **7 天或 1,000 个匿名 native sessions，取先到者**；若未达到最小样本，不作通过判定。
- 连续 **两个完整观察窗口** 达到所有 proceed threshold，且无 Stop/Rollback 事件，才可提交扩大 cohort 的复审。
- 任一窗口出现 Hold 条件，不扩大 cohort，继续观察或回到 Stage 1。

### Stage 3 — default-on review

- 至少完成两个稳定 release 周期观察后，才提交 default-on 评审。
- default-on 不是本提案自动授予的结果；需另行确认 parity、性能、支持/回滚准备及 D10 签署。
- 未签署前继续保持 cohort 或 legacy-safe mode。

## 3. Proposed D10 thresholds

以下阈值沿用 Gate D §7；相对 legacy 的比较必须使用同 fixture、同统计口径、同完整观察窗口。

| 指标 | Proceed：可进入下一阶段 | Hold：暂停扩大，继续收集证据 | Stop/Rollback：立即暂停并回退评估 |
| --- | --- | --- | --- |
| startup success / bootstrap failure | ≥99.5%，且不低于 legacy baseline 0.2pp | 达到 proceed 不充分，且未触发 stop | <99.0%，或比 legacy 差 ≥0.5pp |
| prompt → first event success | ≥99.0% | 低于 99.0% 但 ≥98.5% | <98.5% |
| runtime crash / session | ≤ legacy baseline +0.1pp | 高于 baseline +0.1pp 但未达 stop | 高于 legacy baseline +0.3pp，或出现重复 crash cluster |
| authorized reconnect recovery / snapshot | ≥99.0% | 低于 99.0% 但 ≥98.0% | <98.0%，或出现 stale-target write |
| unresolved event sequence gap after snapshot | ≤0.1% sessions | >0.1% 且 ≤0.5% | >0.5% |
| critical-path parity | 0 个 confirmed severity-1/2 regression；severity-3 有 workaround | severity-3 无 workaround 或证据未完整 | 任一 security/credential leak、cross-owner leak、不可恢复 data loss |
| p95 critical operation latency | 各 critical op ≤ legacy +20% | 超过 +20% 但 ≤+50%，单窗口 | 任一 critical op > legacy +50% 持续 2 个窗口 |
| fallback rate | ≤1%，且原因可分类 | >1% 且 ≤3%，原因可分类 | >3%，或 unknown fallback >0.5% |

Hold 是保护性状态，不是失败豁免：停止扩大 cohort，保留 legacy control，定位原因并补证据。若 Hold 持续一个完整窗口仍不能满足 proceed，建议回到上一阶段；若触发 Stop/Rollback，按 §5 执行。

任意样本量不足、baseline 不可比、telemetry 丢失无法判定时，默认 **Hold**，不作乐观推断。

## 4. Proposed telemetry contract

### 4.1 Event fields

每条事件只允许以下匿名、coarse-grained 字段；字段值必须经过 schema validation 与 allowlist。建议 schema version 为 `1`：

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

### 4.2 Collection and privacy rules

- Failure、crash、sequence-gap 建议 100% 采样；success 仅低比例采样。具体比例仍待 D10 批准。
- 不记录 capability、device token、prompt、path、session file、cwd、port、URL query、credential、raw error 或 upstream text。
- `failureCode` 只能来自稳定 allowlist，例如 `handshake_rejected`、`runtime_crashed`、`event_sequence_gap`、`command_too_large`。
- 不记录 owner/client ID，也不允许 browser 自报提升 `anonymousClientClass` 或权限。
- `createdAtBucket` 只保留日期粒度；installation bucket 若使用，必须短期、不可逆关联身份。
- transport failure 必须本地计数或丢弃，不能阻塞用户操作、重发 mutation 或进入错误路径。
- telemetry 事件不得包含可还原的请求正文、响应正文、路径、token 或 secret。

## 5. Proposed stop / hold / rollback runbook

### 5.1 Immediate stop conditions

发现以下任一项，立即停止 cohort 扩大，冻结 native enable：

- capability、credential、token、path 泄漏；
- cross-owner/workspace action；
- 静默丢 prompt；
- 旧 turn abort 影响新 turn；
- snapshot 恢复后 state 或 leaf 错乱；
- rollback 不能恢复 legacy；
- DB/settings schema 不兼容且无 backup；
- unbounded memory/backpressure；
- static asset 路由导致白屏。

同时保留脱敏 stable failure code、窗口、build 与样本元数据；不得保留泄漏内容。

### 5.2 Flag-off rollback

1. 停止扩大 cohort；不清除 operation records 或 running runtime。
2. 通过 rollout-authorized host writer 设置 `runtime.native_origin=false`；普通 preference ingress 不得读写该 namespace。
3. 新窗口 fail closed 到 legacy，确认 legacy `PiManager`、Pi-origin static 与 broker v1 可用。
4. 已运行 native 窗口不粗暴切 origin：显示 reconnect/restart-required，按 Gate C stop order 停 native child、revoke owner/handles、settle/reclassify operations，再由 legacy 启动并重新绑定 session。
5. Pending operation 若无 terminal response，标记 `Indeterminate/runtime_crashed`，不得自动重发；用户确认后使用新 idempotency key。

### 5.3 Artifact / N-1 rollback

按已批准 recovery contract 执行：保留 session JSONL；检查 schema compatibility；必要时使用经校验 backup 恢复 metadata/preferences；隔离错误 static fingerprint cache；回收 native/temporary child、handles、capabilities、subscriptions；运行 health、shell、reconnect、prompt first event、session/file 等 smoke。N-1 不支持当前 schema 时拒绝启动并显示 recovery UX，不得静默降级。

Rollback 失败时保持 legacy-safe mode，阻止再次 native enable，并只输出不含 token/path/credential 的稳定错误码。

## 6. Approval record

**决策：APPROVED（框架性批准，2026-08-30）。** 本提案的阶段机制、八项阈值、telemetry 契约（schema 1 + 隐私规则）与 runbook 作为 D10 决议生效；阈值为 prospective gates（治理未来阶段迁移，不追溯既有数据）。Stage 0 准入条件 = 本文件 §2 Stage 0 前置（即 P3 收尾三件人工件）；未达准入前 native 保持 fail-closed/default-off。

| 项 | 状态 |
| --- | --- |
| Proposed by | implementation worker；2026-08-30 |
| Decision owner | Dr. Lin |
| D10 decision | **APPROVED（框架性）** |
| Approved stages | Stage 0–3 机制全案；Stage 0 准入待三人工件 |
| Approved thresholds | §3 表全案（prospective） |
| Approval signature | Dr. Lin 指令式拍板（「做 D10 拍板」，2026-08-30，本会话记录） |
| Approval date | 2026-08-30 |
| Conditions / exceptions | fail-closed/default-off 不变；不授予 default-on；telemetry 采样比例待 Stage 0 定案（§4.2）；telemetry.rs 接线与 dead_code allow 回收绑定 Stage 0 |

后续阶段迁移（Stage 0→1→2→3）仍需按本提案阈值与窗口判定，逐段产生 D10 review input。
