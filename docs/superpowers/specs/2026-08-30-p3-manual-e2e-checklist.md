# P3 manual E2E / dogfood checklist

日期：2026-08-30  
状态：**人工执行项；不属于自动化 Picot browser test。**

## 前置条件

- [ ] 使用目标 build、embedded Pi、目标 OS；记录 build、commit、Pi version、OS。
- [ ] workspace 已注册；session fixture、数据 shape、legacy/native flag 状态已记录。
- [ ] native flag 默认关闭验证完成；测试不在运行时热切换 flag。
- [ ] 保留 legacy control fixture，native 与 legacy 使用相同 workspace/session/data shape。

## Browser/WebView flow

- [ ] 打开 `/workspaces/:workspaceId/sessions/:sessionId`：页面非空白，chat、composer、sidebar 可用。
- [ ] 核对 CSS、JS、module、locale、worker、download 等静态资源均加载成功，无 console/network critical error。
- [ ] 核对 root-relative `/v2/bootstrap`：authenticated request 返回成功；URL、storage、页面源码、日志不出现 capability。
- [ ] 核对 `/v2/ws` 建连并完成 capability hello；无 Pi-origin 或 bare `/ws` fallback。
- [ ] 发送 prompt：UI 显示用户消息，收到有序 runtime event，assistant 状态正确结束。
- [ ] active turn 执行 abort：当前 turn 停止；无 active turn、stale turn 不影响后续 turn。
- [ ] reload/reconnect：连接恢复、重新订阅、snapshot 先于后续 event；无重复或跨 session 内容。
- [ ] capability revoke/过期：请求失败且 fail-closed；不能访问其他 owner/workspace；重新授权后可恢复。
- [ ] 人为制造 sequence gap：UI 请求单次 authoritative snapshot；snapshot 后状态正确，旧 event 不重复 mutation。
- [ ] retained owner-aware reads：逐项验证 `/api/health`、`/api/pi-version`、`/api/files`、`/api/sessions`、`/api/search`、`/api/cost-dashboard` 的成功、拒绝、wrong-owner、wrong-workspace 行为。
- [ ] unsupported P4/P5/P6 route：返回稳定 `unimplemented_route`，不静默 fallback。

## Dogfood / performance

- [ ] 与 legacy control path 完成同 fixture 对照。
- [ ] 记录每个 critical operation 的样本数、warmup、p50、p95、失败数、超时数、OS/build/Pi version/data shape。
- [ ] 至少覆盖 startup/bootstrap、prompt→first event、reconnect/snapshot、abort；样本不足标记 Hold，不判定通过。
- [ ] 观察 dogfood 窗口内无 credential/path 泄漏、cross-owner action、静默丢 prompt、不可恢复 data loss。
- [ ] telemetry 只含 allowlisted coarse fields；transport failure 不阻塞用户操作。

## Rollback

- [ ] 关闭 native flag 后重启应用，回到 legacy path；确认无残留 native socket/state。
- [ ] native failure 触发 stop/hold 条件时，冻结新增 cohort，保留 legacy control，按 D10 runbook 回退。
- [ ] 记录 rollback 时间、触发条件、用户影响、恢复结果；不热切换运行中 runtime。

## 判定与证据

- **PASS**：所有必选项完成，critical parity 无 S1/S2 regression，且性能、样本、D10 threshold 证据完整。
- **HOLD**：证据缺失、样本不足、baseline 不可比或只触发 Hold 条件；不得扩大 cohort。
- **STOP/ROLLBACK**：出现 security leak、cross-owner/workspace action、静默丢 prompt、data loss、不可恢复状态或 D10 stop 条件。

将截图、network/console 摘要、原始性能样本、人工签名与 rollback 记录放入同一 release evidence 目录；不得提交 capability、prompt、path、token、credential 或 raw upstream error。
