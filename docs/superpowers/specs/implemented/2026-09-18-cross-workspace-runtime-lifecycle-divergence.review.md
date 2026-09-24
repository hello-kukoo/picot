# 评审记录:跨 workspace 切换时旧 runtime 不停止

> 评审对象:`../2026-09-18-cross-workspace-runtime-lifecycle-divergence.md`
> 评审日期:2026-09-20。B1 已由 Dr. Lin 拍板(见 B1 节),其余订正建议待定。

## 总体判断

方向正确,风险披露诚实,尤其 §2.2 事件边界一段。问题出在时效:spec 写于 2026-09-18 22:17,它描述的"工作树进度"当天 22:46 已提交为 `edc3721`,而 §4 验收清单没有随之更新。照单执行会重写已经存在的测试。

## A. 事实订正

**A1「工作树」措辞过期。** §2.1/§2.2 所述改动全部在 `edc3721`(feat(runtime): 跨工作区订阅运行时事件流,旧代运行时保留存活,2026-09-18 22:46),评审时 `git status` 干净。应改为引用 commit hash,否则后来者找不到所谓工作树 diff。

**A2 §4 items 4–6 与 5 的主路径已有测试:**

- item 4 → `runtime_instance_summaries_span_every_registered_workspace`(main.rs)
- item 5 主路径 → `cross_workspace_activity_events_reach_other_subscribers_but_dialogs_stay_scoped`(host_server.rs:5919):跨 workspace 订阅获准、`agent_start` 投递、widget 广播、dialog 只投 owner
- item 6 → `pending_dialog_replay_skips_cross_workspace_subscribers`(host_server.rs:6081)

item 5 的拒绝分支(未认证、非 desktop、已停止 target)未见专门测试,item 7 的 message/tool payload 跨 target 转发也未测(只测了 widget 与 `agent_start`)。

**A3 §2.1「保留 manager API 供其余调用方使用」不实。** `stop_for_owner_transition` 与 `stop_for_workspace_transition` 在生产代码中零调用方,全部命中位于 native_pi_manager.rs:2239–2535 的测试内。应改为「仅为语义测试保留」。

**A4「no reactor running」警告过期。** 实跑 `cross_workspace_return_reuses_the_prior_runtime` 通过(0.00s)。删故障描述,保留论点:helper 级测试不等于 transition 级验证。

**A5 §2.3 表漏分支。** background `message_end` 也调 `markUnread`(app.js `handleBackgroundRPCEvent`),蓝点在 turn 中途逐条消息出现。验收 item 9 只测 `agent_start`/`agent_end`,测不到这个分支。

## B. 决策项

### B1 事件边界 —— 已拍板:接受宽通道

2026-09-20 Dr. Lin 拍板:持有 desktop capability 的本机窗口可订阅其他 live runtime 的全部非阻塞事件(消息正文、tool 输出、widget、notify);阻塞式 `extension_ui_request`(select/confirm/input/editor)仍只投 `authorize_target` 通过者。§4 第 7 项按原文执行。已同步记入 ARCHITECTURE.md 安全边界。

拍板依据:desktop capability 只由原生窗口 owner registry 铸发,LAN 配对设备是 Browser 类客户端,拿不到;单用户本机看到的是自己的数据。收窄为 activity-only 要求 host 新增合成事件路径,并砍掉 background widget mirroring(B 窗口渲染 A 的 mirror 面板,`public/ui/widget-mirror-registry.js`),代价与收益不成比例。未来若出现演示模式、多用户等明确需求,按新 spec 重新立项。

### B2 显式 restart —— 已拍板：定义 + 修选靶 bug + 进验收

2026-09-20 Dr. Lin 拍板。显式 restart = `restart_runtime` 控制面命令（Registered owner 经 Settings 包管理页「重载」手动触发，stop 旧实例 + 新 instanceId respawn）；定义已写入 spec §5，ARCHITECTURE.md 安全边界第 4 条枚举已补。

讨论中发现的选靶 bug 已列入 spec §4 第 9 条：stop 目标按 `owner_id` 首个命中（HashMap 遍历序不定），无 workspace 过滤。旧世界每 owner 至多一个 live runtime 时安全；`edc3721` 留活后一个 owner 可有多 workspace 的 live runtime，在 B 点重载可能误停 A 的任务。前端 `transport.restartRuntime(workspaceId, sessionId)` 早已传参，Rust 侧未使用。修复排进本 spec 剩余实现。

## C. 建议

- C1 §4 改双列表:一列代码现状(已测),一列剩余验收(待做)。
- C2 `should_stop_owner_runtimes_on_transition` 改名。它现在只作 `should_revoke_prior_generation` 的闸门,自带测试注释都写着 "runtimes themselves are no longer stopped by it"。
- C3 item 7 补 message/tool payload 跨 target 测试。B1 已拍板,这条现在可以写。

## D. 真实缺口(2026-09-20 复核仍缺)

- items 1–3：transition 级 A→B→A async 测试不存在。main.rs:1091 只调 `find_existing_runtime_for_prepare` 和 `rebind_owner_generation` 两个 helper。
- item 9：`restart_runtime` 选靶 bug 待修（B2 拍板新增的验收项）。
- items 10–12：前端零测试。没有 `.test.js` 引用 `setStreaming`/`markUnread`/`handleBackgroundRPCEvent`。
- items 13–14：手工 e2e 状态未确认。

注：插入 Rust 第 9 条后，原前端 9–11、e2e 12–13 已顺延为 10–12、13–14（2026-09-20）。

2026-09-20 复核时工作树新增了 child_supervision、git push 等未提交改动,与上述缺口无交集,D 组结论不变。

## 附:独立发现(不属于本 spec,建议开新工单)

`mobile_lan_access_enabled`（host_server.rs:56）pref 缺省时 `unwrap_or(true)`——已拍板回退（2026-09-20，Dr. Lin）。

证据链：原始实现为 `unwrap_or(false)`，与注释一致；2026-09-03 的 8bd24c8（9 项 squash，含「移动端 LAN QR」）翻成 `true`，注释、ARCHITECTURE.md、commit message 均未同步，判断为无意翻转。已修复：`unwrap_or(false)` 回退 + 新增 `absent_lan_preference_defaults_to_loopback` 回归测试（缺省断 loopback、显式 true 断 LAN）+ ARCHITECTURE.md 安全边界第 1 条改写为「默认 loopback，显式开启才绑全部网卡」。已显式开过开关的用户不受影响（pref 有行）。

## 验证记录(2026-09-20)

- `cargo test ... workspace`：44 passed
- `cargo test ... host_server`（含新增 LAN 默认回归）：28 passed（2026-09-20 回退后复跑）
- `cross_workspace_return_reuses_the_prior_runtime`:pass
- vitest background 过滤:3 passed
