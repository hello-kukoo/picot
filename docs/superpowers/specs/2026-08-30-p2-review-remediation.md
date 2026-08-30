# P2 评审整改单（p2-critical-reviewer → P2 实现 agent）

日期：2026-08-30 ｜ 来源：`p2-critical-reviewer` 全量评审（13m59s）+ orchestrator 抽验
状态：**P2 code remediation complete; CP4 evidence ready**（2026-08-30）

> CP4 结论：P2 实现、授权/限额修复及 focused matrix 已完成；P2 gates 已通过。#2 按 Dr. Lin 裁决为 `SUPERSEDED by D10`，不得据此改写 D10 release 语义。

> 范围裁决：P3 host-origin 工作已存在于当前 dirty tree，但本整改单不扩展 P3 功能；P3 的人工 E2E、dogfood、D10 签署与真实 release rollback 仍按 P3 evidence audit 保持未关闭。

> **独立复验（2026-08-30，orchestrator，闭单确认）**：六项全实——#1 门控（:1157 仅 Unpaired + forbidden_class 拒绝）；#3 canonical 三值 + abort operationId + 契约测试；#4 disconnect-on-close + 增长回归测试（100 轮 connect/disconnect 归零，orchestrator 补写）；#5 progress_sink 真实投递；#6 v1 限额三点法测试绿。P2.2 九宫格（host_router:402）与 P2.3 带内三 acceptance replay（request_scoped_receipt 契约，orchestrator 补写）均在。cargo **364/0/6** + clippy clean + check 绿。

> 评审底色：核心安全面已验证扎实（每次准入重读 registry、精确相等 live-target 校验、逐事件重鉴权、常数时间 capability、TTL/容量/撤销、loopback-only bind），356/356 测试过。本单只列缺陷与缺口，不代表质量差。

## 整改状态（2026-08-30）

| 项 | 状态 | 证据 / 边界 |
| --- | --- | --- |
| #1 create_pairing client-class gate | **CLOSED** | `host_server.rs` paired remote 拒绝、unpaired 成功测试 |
| #2 release gate | **SUPERSEDED by D10** | 保留 `cfg!(debug_assertions) && PICOT_RUNTIME=native` 双门；debug 内读取 `runtime.native_origin`。不把 sqlite preference 改成 release-only gate；writer policy 与公开 `runtime.*` 拒绝归 P3.1 验收 |
| #3 acceptance / operationId | **CLOSED** | 三值 acceptance 契约、abort/dialog `operationId` 测试 |
| #4 router lifecycle | **CLOSED** | disconnect 清理 + 256 client bounded registry；clientId 稳定化随 P3 host-origin 生命周期处理 |
| #5 progress | **CLOSED** | v2 progress sink 投递；broker progress per-request monotonic `sequence` |
| #6 v1 limits | **CLOSED** | v1 adapter 业务 payload 边界测试（limit-1/limit/limit+1） |
| P2.1 capability lifecycle | **CLOSED** | per-window revoke/validate regression |
| P2.2 hello matrix | **CLOSED** | desktop/remote/unpaired × valid/invalid hello matrix |
| P2.3 replay semantics | **CLOSED** | accepted_pending → duplicate_pending → duplicate_completed，稳定 operationId |
| P2.6 dialog policy | **CLOSED** | owner × client-class authorization regression |
| P2.7 limit matrix | **CLOSED** | v1 boundary coverage；slow-consumer/cancel/lag 使用既有 broker queue/abort/sequence-gap tests |

## 0. Blocker —— 已修复 ✅（2026-08-30，orchestrator）

telemetry.rs 全模块未接线 → 19× dead_code → `check:rust` 红。已加模块级 `#![allow(dead_code)]` + 落因注释（D10 cohort 门槛未决、schema 超前于接线，D10 落地时接线并移除 allow）。**P2 agent 接手 D10 时务必回收此 allow。**

## Majors（6 项，按建议修复序）

| # | 缺陷 | 位置 | 修复方向 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | `create_pairing` 无客户端类门控——已配对 remote 可铸造配对 token | `host_server.rs:1125`（`RoutedAction::Auth` arm） | 该 arm 仅对 `UnpairedBrowser` 类开放（或至少拒绝 `PairedRemote`）；类来源用 P2.2 的 `HostClientContext` 分支 | 新测试：paired remote 调 create_pairing → 拒绝；unpaired → 成功 |
| 2 | ~~v2 面 release 门 = sqlite preference，非契约双门~~ **已改判：SUPERSEDED by D10（2026-08-30）**——D10 已决：`preferences.runtime.native_origin` 是唯一 release source，debug env 仅 developer override；P2 评审员所指的 sqlite pref 正是 D10 契约本身。剩余待办收窄为：① dev host（HostServer）的启动门保持 `native_runtime_enabled()` 双门不变（勿按本条原表述改 release 面）；② D10 的 writer policy（仅 rollout-authorized host writer 可写）与公开 `runtime.*` controls 全拒的实现验证归 P3.1（见 P3 整改单） | host_server 启动路径 | 不改 release 门；验证 writer policy + 公开 controls 全拒（归 P3.1） | 测试：公开 preference 写入 runtime.* → 拒绝；debug env override 仅 debug 生效 |
| 3 | 非规范第 4 acceptance 状态 `"completed"`（spec §3.1 枚举恰 3 值）；abort/dialog 响应缺 `operationId` | `host_server.rs:1079`（dialog 响应路径） | `"completed"` 改为三值之一（该路径语义应为 `duplicate_completed`）；abort/dialog 响应补 `operationId` | 契约测试：所有 runtime_response 的 acceptance ∈ 三值集且必带 operationId |
| 4 | Router 客户端注册表断连不清理 + 每刷新随机 clientId → 无界增长（Gate B §3.2.6） | host_router.rs 客户端注册表 | disconnect 钩子清注册表；或注册表容量上限 + LRU；clientId 稳定化随 P3 host-origin 一起定 | 增长测试：N 次 connect/disconnect 后注册表有界 |
| 5 | v2 control progress sink 为 no-op（进度静默丢）；broker progress 缺 `sequence` | host_server control 路径 / broker_ws progress | progress 接到 sink（或显式 policy 拒绝+事件化）；broker progress 补 per-target sequence | 进度投递测试 + sequence 单调断言 |
| 6 | v1 adapter 通路绕过 1MiB/256KiB 业务限额（仅剩 16MiB 物理层） | v1_control_adapter 路径 | adapter 内或其入口挂 transport_limits 的业务限额层（与 v2 同一执行点） | `limit-1/limit/limit+1` 三点测试走 v1 通路 |

## P2.1–P2.8 缺口测试矩阵（评审判定 ⚠️ 项的补测要求）

- **P2.1**：capability per-window memory lifecycle 测试（窗口关闭 → mint/validate 失效）
- **P2.2**：valid/invalid hello × 三 client class 全组合矩阵（9 格）
- **P2.3**：三 acceptance 的 in-memory replay/event sequence 测试（对照 spec §4.1 语义逐条）
- **P2.6**：dialog owner × class 策略测试
- **P2.7**：每 surface `limit-1/limit/limit+1` + slow consumer/cancel/lag（含 v1 通路，见 #6）

## 范围外观察（不整改，仅记录）

1. 树上存在 P3 命名产物（`public/app/host-origin.js(+test)`、`scripts/smoke-host-origin-p3.mjs`、`2026-08-30-p3-evidence-audit.md`）——P2 尚未关，P3 工作已超前动工。**建议 P2 关闭（CP4）前冻结 P3 面**，或由 Dr. Lin 显式批准并行。
2. `telemetry.rs` 为 D10 超前实现（cohort 门槛待 Gate D 方案后补拍）；接线与 allow 回收绑定 D10。
3. knip 报 `scripts/smoke-host-origin-p3.mjs` unused（无引用）——P3 面冻结决议时一并处理。

## 整改后验证（全过才算完）

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings   # Finished clean
cd src-tauri && cargo test                                   # 全绿（当前 356/0/6）
bun run check                                                # 绿
bun run check:inventory                                      # 零漂移
```
