# P3 评审整改单（p3-critical-reviewer → P3 实现 agent）

日期：2026-08-30 ｜ 来源：`p3-critical-reviewer` 全量评审（16m20s）+ orchestrator 抽验
状态：**code remediation complete; Gate D / release exit remains open**（2026-08-30）；本单 D2 已在评审后自愈（见下）

> 评审判定：P3.2 ✅；P3.1/P3.3/P3.4 substrate 过、带缺口；P3.5 ❌（checkpoint 自己如实记录）。perf 文档 p50/p95 与原始样本精确复算一致、rollback 与 harness 一致、p111 修改属合法复验——证据诚实度整体良好，唯 D3 一处违约。治理状态（Gate D、P2 未关）已记录不重议。

> **独立复验（2026-08-30，orchestrator，闭单确认）**：D1 修复坐实——客户端 `runtimeCommands` 集合已整体移除（分类单一来源到 server 侧 adapter mapping，8/8 测试绿含 Host 分类断言）；D2 disconnect-on-close + 增长回归测试（orchestrator 补写）；D3 走诚实路线 (a)——证据文件为真跑实录（含 12 步覆盖路径），orchestrator 亲复跑 `bun run smoke:host-origin-p3` **PASS (4805ms)** 可复现。minors：host_capability 已接线（host_server:4）、broker bind 已收紧 LOCALHOST（D4 一致）、/app 实验壳边界在位（:212）、P3.5 与 D10 保持诚实开放（checkpoint 明文不称完整）。

## 整改状态（2026-08-30）

| 项 | 状态 | 证据 / 边界 |
| --- | --- | --- |
| D1 host lifecycle routing | **CLOSED** | 7 controls moved from frontend `runtimeCommands` to `host_request`; Rust/prototype allowlists and one-per-control tests pass |
| D2 router disconnect cleanup | **CLOSED** | HostServer disconnect hook plus bounded registry and lifecycle regression |
| D3 smoke evidence | **CLOSED** | Real `bun run smoke:host-origin-p3` pass recorded in `2026-08-30-p3-host-origin-smoke-evidence.md` |
| P3.5 release exit | **OPEN** | Manual browser/WebView E2E, native/legacy same-fixture performance, dogfood, D10 approval, real rollback and Windows validation remain external gates |

## Majors

| # | 缺陷 | 位置 | 修复方向 | 验收 |
| --- | --- | --- | --- | --- |
| **D1** | 7 个 **host 生命周期控件被误路由给 Pi 子进程**：`websocket-client.js:434` 的 `runtimeCommands` 集合把 `open_workspace / new_session / switch_session / fork / navigate_tree / stop_instance / spawn_session_process` 归类为 runtime 命令，host_server Runtime arm 随之转发——这些是 host 权限域控件，现有壳的会话控制因此失效，违反 explicit-failure 纪律 | `public/app/websocket-client.js:434-443` + host_server Runtime arm | 7 控件从 `runtimeCommands` 移除，走 host control 面（或显式拒绝+结构化错误）；host/client 两侧命令分类单一来源（control-map） | 契约测试：7 控件经 v2 通路到达 host 处理器而非 Pi 子进程；每控件一条 |
| ~~D2~~ | ~~HostRouter 客户端注册表 socket 关闭不清理~~ **评审时成立，现已自愈**——`host_server.rs:815` 已在 ws 会话循环收尾调用 `router.disconnect(&client_id)`（与 P2 整改 #4 同修法） | host_server.rs:814-816 | 无需再修；补增长回归测试防退化（N 次 connect/disconnect 后注册表有界——P2 #4 的验收测试可直接覆盖） | 增长测试落地 |
| **D3** | **被引证的证据文件不存在**：`2026-08-30-p3-host-origin-smoke-evidence.md` 缺失，但 `p3-checkpoint.md:43` 断言 "`bun run smoke:host-origin-p3`: PASS with real Rust HostServer and embedded Pi"，`d10-recommendation.md:10` 直接把该缺失文件列为参考 | p3-checkpoint.md / d10-recommendation.md | 二选一（诚实优先）：**(a)** 实际运行 `bun run smoke:host-origin-p3`，产物落盘为该证据文件（含命令、时间戳、输出）；**(b)** 若 smoke 未真跑过或不可复跑：撤回两处 PASS 断言，checkpoint 状态降级为"未验证"，d10-recommendation 移除引用。**禁止补写不可复现的 PASS** | 证据文件在树且内容可复跑核验；或断言撤回干净 |

## Minors / Notes（7 项）

1. P2 整改单 #1/#3/#5/#6 仍开放（create_pairing 类门控、第 4 acceptance、progress 双缺陷、v1 限额绕过）——P3 agent 与 P2 agent 的整改面有交叠（broker_ws/host_server 同文件），**协调顺序，勿互覆**
2. P2 整改单 #2 已改判 SUPERSEDED by D10（本日更新）——勿按其原表述改 release 门
3. `host_capability.rs` 存在但未接线（dead substrate）——P2.1 归属，随 P2 整改接上或显式标注
4. legacy 通路 gap-frame 无恢复路径（v2 侧已有 snapshot recovery，v1 侧缺）——existing-shell 适配完整性项
5. broker bind `0.0.0.0` → `127.0.0.1`：评审记为 LAN regression 风险——对照 D4（默认 loopback）核实现状与意图，若是收紧则记录为有意变更
6. `/app/` experimental 壳与 `/workspaces/` 生产壳的边界测试补齐（D1 namespace 的 runtime 侧）
7. P3.5（parity/dogfood 2 周/perf 阈值）维持 ❌ 直到条件满足——checkpoint 已如实标注，保持

## 整改后验证（全过才算完）

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings   # Finished clean
cd src-tauri && cargo test                                   # 全绿（当前 356/0/6）
bun run check && bun run check:inventory                     # 绿 + 零漂移
bun run smoke:host-origin-p3                                  # 产物落盘（D3 路线 a）
```
