# P3.1–P3.5 / Gate D evidence audit

日期：2026-08-30

## 结论

**Gate D 未关闭，P3 release exit 未通过。** 当前工作树已有 production wiring、隔离 adapter prototype，以及真实 Rust HostServer + embedded Pi host-origin/browser smoke；仍缺少完整 parity matrix、性能对照及 D10 批准。浏览器 smoke 已证明 existing shell 在 `/workspaces/:wid/sessions/:sid` 可加载并重连，但不等于完整 browser parity 或 rollout-ready。

## Checklist

| 项 | 判定 | 当前证据 | 剩余缺口 |
| --- | --- | --- | --- |
| P3.1 flag / launch snapshot / fail-closed | **部分通过** | `src-tauri/src/main.rs::native_runtime_enabled` 读取受保护 `runtime.native_origin`；`MetadataStore` 对读失败、无效 JSON/value、无授权写入 fail closed；已有 flag off/on、invalid-value、redacted-write tests；`src-tauri/src/telemetry.rs` 提供默认禁用的匿名 allowlist emitter、schema validation、bounded sampling 与 fail-closed tests；Rust focused tests pass | 尚无 production transport、release telemetry 事件接线；D10 未批准，故 emitter 保持 disabled default |
| P3.2 production namespace | **部分通过** | `HostServer` 注册 `/workspaces/{workspace_id}/sessions/{session_id}`；native window 使用该 URL；`/app/` 保留 experimental；`public/app/websocket-client.js` 在该 namespace 选择 `/v2/ws`；真实 host-origin/browser smoke 已验证 shell、`<base href>`、bootstrap、`/ws` rejection、跨 workspace/缺 capability 状态码；Rust static tests 验证 fingerprint path asset serving 与 `/app/` fallback | worker、download、`/app/` no-blank 及完整 static matrix 仍未覆盖 |
| P3.3 owner/capability/navigation lifecycle | **部分通过** | native window 在首载前创建 owner、注入 capability、安装 navigation authorizer；Host WS 校验 desktop capability 并生成 owner context；Rust host tests 覆盖跨 owner；真实 smoke 已验证 capability handshake、owner-bound bootstrap、missing capability、wrong workspace | 没有 Tauri/WebView integration test；没有浏览器重载、导航、reconnect、owner revoke 的真实证据；`/v2/bootstrap`/route binding 尚未由 browser path 验收 |
| P3.4 existing-shell adapter | **基础 production adapter 通过；完整 parity 未通过** | `bun run vitest run scripts/prototype/adapter-prototype.test.js`：37/37；HostServer 已接入 shared control handler、v1→v2 allowlisted adapter、owner-aware retained routes；真实 host-origin smoke 已覆盖 v2 WS and runtime interaction | 全量 43 WS command / ~40 controls 及全部 retained surface 的 lossless mapping/limits/auth/error 仍未完成；Terminal/Super Agent/Telegram/OAuth/binary/ephemeral 属后续 phase；`brokerWs` legacy caller/storage 仍存在于非-host路径 |
| P3.5 parity / dogfood / performance | **未通过** | 仅有 unit/contract tests；`scripts/perf-baseline.mjs` 存在 | 无 flag on/off full parity；无两周 dogfood；无 native-vs-legacy control sample；无 p95 evidence；perf script 当前默认连接 `127.0.0.1:47821`，本次因无运行 server 失败 |

## Gate D gaps

- **D-GAP-01：** prototype 子范围已关闭（43/43），且真实 HostServer + embedded Pi smoke 已记录；仍不关闭人工 browser/WebView parity 部分。
- **D-GAP-02：** Host capability/context 代码已有；real HostServer smoke 已覆盖 capability handshake、owner-bound bootstrap、missing capability、wrong workspace，但仍缺真实 browser cross-owner/reconnect evidence。
- **D-GAP-03：** prototype 覆盖代表性 mapping；完整 production mapping 未证明。
- **D-GAP-04：** 当前 retained route contract 已覆盖 `/api/health`、`/api/pi-version`、`/api/files`、`/api/sessions`、`/api/search`、`/api/cost-dashboard`；其余 inventory surfaces 按 P4/P5/P6 phase ownership 保持显式 `unimplemented_route`，不能在 P3 越权实现。
- **D-GAP-05：** host-origin 页面不再使用 `brokerWs`，但 legacy query/sessionStorage 机制和 caller 仍存在；不能声称全局 removal。
- **D-GAP-06/07：** `/workspaces/`、`<base href>`、fingerprint asset serving 已有 real HostServer/Rust evidence；browser validation is intentionally manual E2E, not a Picot automated browser harness. worker、download、`/app/` no-blank 放入人工 E2E。
- **D-GAP-08：** production WebSocketClient now forwards v2 sequenced events/snapshots and requests one authoritative snapshot after a sequence gap; unit/prototype 与 real-Pi smoke 已覆盖 ordering/reconnect/snapshot；existing UI 接收 forced lag → snapshot → event 的人工 E2E evidence 缺失。
- **D-GAP-09/10/11：** Temporary/Quick/Side、OAuth、Terminal/Super Agent/Telegram mapping 未完成 parity。
- **D-GAP-13：** D10 未批准；telemetry schema/redaction/sampling dry-run contract 已有 Rust fixture evidence，但 production transport / success baseline 不存在。
- **D-GAP-14：** rollback real rehearsal 未执行；Gate R 的 component/recovery evidence 不能替代 P3 release rollback rehearsal。
- **D-GAP-15：** startup diagnostic 已有 Rust redaction tests，仍缺 browser URL scan / real bootstrap failure evidence。

## Commands and observed evidence

| 命令 | 结果 |
| --- | --- |
| `bun run smoke:host-origin-p3` | **PASS：real Rust HostServer + embedded Pi；shell/bootstrap/hello/subscription/snapshot/route isolation；1 ignored test** |
| 人工 browser/WebView E2E | **执行项：按 `2026-08-30-p3-manual-e2e-checklist.md` 与 dogfood/performance 一起验收；Picot 不新增 automated browser harness** |
| `cargo test runtime_preference --manifest-path src-tauri/Cargo.toml` | **PASS：3/3**；flag off/on、授权边界、invalid value fail-closed、redacted audit |
| `bun run vitest run public/app/host-origin.test.js scripts/prototype/adapter-prototype.test.js` | **PASS：2 files / 39 tests** |
| `bun run vitest run public/app/websocket-client.test.js public/app/transport.test.js` | **PASS：2 files / 40 tests**；已有 expected disconnect stderr |
| `bun run check` | **PASS：Biome 459 files；design check passed** |
| `bun run check:rust` | **PASS：cargo check/clippy；351 passed，0 failed，5 ignored**；`cargo fmt --check` 报 advisory formatting drift |
| `bun run perf:baseline` | **授权延期：**按计划 §2/WP0.4 已重定域为手工 dogfood 阶段；未生成 p50/p95，避免伪造数字 |
| `bun run vitest run scripts/prototype/adapter-prototype.test.js` | **PASS：37/37**（prototype evidence） |
| `cargo test telemetry --manifest-path src-tauri/Cargo.toml` | **PASS：3/3**；default-off、0–1 bounded success sampling、allowlist/redaction、invalid config fail-closed |

## 不应现在修的项目

1. **浏览器验证**：Picot 不新增 automated browser harness。`/workspaces/`、静态资源、聊天、reload、abort、sequence-gap、retained API、rollback 统一放入人工 E2E/dogfood checklist；不使用 DOM/Vitest mock 冒充 browser evidence。
2. **性能数字**：按计划 §2/WP0.4 的 Dr. Lin 授权重定域，自动 baseline 延期至 P3 dogfood/parity 手工 e2e；本轮不填造 p50/p95，且 native adapter/parity 尚未完成，不能比较。
3. **两周 dogfood/D10**：属于发布观察与产品决策，不可由本次代码修改替代；D10 阈值仍是 proposed。
4. **全量 route mapping**：需 P2 substrate、Gate A inventory 锁定范围，再逐条实现/验收；当前只应保留明确 stable failure，不得 generic silent fallback。

## Gate D closure checklist

- [ ] 人工 browser/WebView `/workspaces/:wid/sessions/:sid` load/no-blank 与 static matrix：按 `2026-08-30-p3-manual-e2e-checklist.md` 执行。
- [x] 真实 Pi host-origin smoke 基础路径：shell、bootstrap、hello/capability、subscription、read-only snapshot、route isolation。
- [ ] 人工完整交互：prompt → first event → terminal、abort、reconnect、forced sequence gap → snapshot、no duplicate mutation。
- [ ] 人工 Host capability cross-owner、revocation、navigation、reload integration evidence。
- [ ] 全量 retained route auth/owner/generation/limit/error/cancel matrix。
- [x] P3.1 anonymous telemetry schema/allowlist/sampling/redaction dry run contract（`src-tauri/src/telemetry.rs` tests）；[ ] production transport failure non-blocking evidence。
- [ ] legacy/native same-fixture performance control sample，至少记录 p50/p95、样本/预热、OS/build/Pi/data shape（按计划授权延期至 dogfood/parity）。
- [ ] flag off rollback smoke；running child/operation/static cache disposition evidence。
- [ ] D10 cohort thresholds 由 Dr. Lin 批准；否则保持 blocked。

Recommended next step：不要扩大 production scope。保留已执行 real HostServer/embedded-Pi smoke；单独立项取得 browser/real-Pi full interaction harness 许可，完成 retained-route/parity matrix；按授权延期执行 dogfood 性能对照；D10 仍须 Dr. Lin 批准。
