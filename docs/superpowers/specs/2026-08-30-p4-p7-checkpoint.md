# P4/P7 完成检查点

日期：2026-08-30 ｜ 状态：**P4 完成；P7 完成**（单元测试全绿；Gate D/P3 人工件与 D10 Stage 0 按既有记录保持开放）

## P4 — Data/session 与 Cost Dashboard compatibility

| 项 | 交付 | 测试 |
| --- | --- | --- |
| Cost parity | `cost_compat.rs`：parseRangeParams / buildCostDashboardPayload 逐字段移植（UTC day/ISO-week/month 桶、series、breakdown、topSessions 20、infobar fractions、JS 数字语义——积分浮点输出整型）；`HostDataPlane::cost_dashboard_compat` 扫描共享会话树 | 同 JSONL fixture 上 Rust vs legacy TS（`scripts/p4-cost-parity.mjs` 经 buildCostDashboardPayload）**逐字段 parity**（scope=all + current 双轮）；六个单测（参数默认/归一、ISO 周桶、series/fraction/todayCost） |
| 数据/会话 compat 面 | `/api/instances`、`/api/home`、`/api/workspace-info`、`/api/workspace-sessions`（path→dirName + count 模式）、`/api/sessions/{rename,delete-batch,switch}`、`/api/workspace/open`（owner-only system-open，限注册根） | 边界测试（无 capability → 401；错误 owner/workspace → 403）；delete 三态（trash-first staging / running 保护 / 越界拒绝）；dirName 编码 + header-sample 双拼写的回退测试；rename 追加 `session_info` 记录测试 |

## P7 — Chat RPC / event transport completion

| 项 | 交付 | 测试 |
| --- | --- | --- |
| D8 执行（/api/rpc 退役） | 410 Gone + `Deprecation: true` 头 + 移除通告 + **匿名 client-class 命中计数**（desktop/paired_remote/unpaired_browser，无 per-user/token 维度） | 契约测试：GET/POST 双方法 410、头存在、body code=gone、clientClass 字符串 |
| transport 收口 | control progress（control_progress 帧 + PayloadKind::Progress）、abort、per-frame 限额（send_checked/validate）、event_sequence_gap → snapshot fallback、逐事件重鉴权 | P2/P3 既有测试族 + retained-routes 契约测试（authz 矩阵 + 限额 + 方法约束） |
| caller 迁移证明 | retained 路由 capability 边界测试（无 capability → 401；跨 owner/workspace → 403）+ 未迁移路由 fail-closed 404 | `legacy_api_routes_require_owner_capability_and_unknown_routes_fail_closed` |

## 验证

```text
cargo test                ✅ 384 passed / 0 failed / 6 ignored
cargo clippy --all-targets -D warnings ✅ Finished clean
bun run check             ✅（design + biome + markdown）
bun run check:inventory   ✅ 零漂移
```

## 诚实边界

- browser/WebView 人工 E2E、dogfood 2 周、性能对照（P3.5 / D10 Stage 0 前置）**保持开放**——按 Dr. Lin 指令挂起，不影响 P4/P7 代码与单测完成态；
- Windows 平台实证按 R4.10 顺延 P8；
- telemetry.rs 保持未接线（D10 已框架性批准，采样比例与接线绑定 Stage 0，allow(dead_code) 届时回收）。
