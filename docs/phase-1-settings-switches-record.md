<!-- ABOUTME: 迁移计划 Phase 1（设置小开关组）的实施与架构核查记录。 -->
<!-- ABOUTME: 含 v3 映射、验证证据、架构核查发现与遗留项。 -->

# Phase 1 实施记录：设置小开关组

- 日期：2026-10-06
- 计划：`docs/feature-v3-settings-migration-plan.md` Phase 1
- 范围：Code mode 系统级开关（v3 `4b79453`）+ 内置 Pi 系统级 PATH 开关与 embedded pi 路径（v3 `878b3d8`）
- 前置：Phase 0（内嵌 pi 1.0.4）已完成，`docs/pi-1.0.4-upgrade-impact.md`

## v3 → v3.3 映射

| 功能 | v3 实现 | v3.3 落点 | 搬法 |
| --- | --- | --- | --- |
| Code mode 开关 | `picot-config.ts` 5 个 op + `public/settings/toggles.js` 临时 click handler | `extensions/picot-config.ts` 新增 `get/set_default_codemode`；`public/native/settings/settings-toggles.js` 的**声明式 toggle 列表**加一项 | 语义（defaultTools 合并 token）verbatim；前端按 v3.3 列表式接线重写 |
| PATH 开关（Rust） | `src-tauri/src/pi_path.rs`（403 行）+ `main.rs` 控制 op + 启动自愈 | 同文件路径 verbatim 移植，改两处接缝（下述） | verbatim |
| PATH 开关（前端） | `public/settings/pi-path-toggle.js` | `public/native/settings/pi-path-toggle.js`（import 路径 `../../i18n.js`；入参 `{control, toggle, note}`） | 渲染逻辑 verbatim |
| PATH op 注册 | `main.rs` `install_control_handler` + `require_native_owner` | `host_server.rs` `dispatch_host_operation` + 新增 `ensure_desktop_client`（`host_router::HostRouter::client_kind`） | 语义移植（宿主分发结构不同） |
| PATH 标志位 | `metadata.pref_get/pref_set("pi.pathEnabled")` | `metadata.preference_get/preference_set`（同表，键名不变） | 适配方法名 |
| 双入口接线 | `app.js` + `landing.js` | 仅 `settings-panel.js`（v3.3 无 landing） | 单点接线 |

**接缝改动（两处）**：v3.3 的 `pi_launch` 是 `PiLaunchResolver` 结构体（方法 `bundled_pi_path()`），v3 是自由函数 `resolve_bundled_pi(static_dir)`，故 `pi_path::bundled_pi_dir` 改走 resolver；v3.3 的 host op 分发在 `host_server.rs` 而非 `main.rs` 控制处理器。

## 验证证据（全绿）

| 项 | 结果 |
| --- | --- |
| 后端 op 测试 | `extensions/picot-config.test.ts` 39/39（新增 4 条：默认态读取、开启合并、关闭剥离+空键删除、非布尔拒绝） |
| Rust 单测 | `cargo test` 271 条（+8 来自 `pi_path.rs` 的 marker 块纯函数） |
| 前端测试 | `public/native/settings/pi-path-toggle.test.js` 5/5（三态渲染、点击流、拒绝内联） |
| 全量 | `bun run test` 189 文件 / 1534 测试通过 |
| 静态 | `bun run check` exit 0（locale 四语言 1113 键齐）；`bun run check:rust` 全绿（clippy warnings-as-errors、cargo fmt 干净） |

### Code mode 语义已对照 pi 1.0.4 官方文档核实

`resources/pi/docs/settings.md:40-54` 与 `cli.md:158-166` 确认：`defaultTools` 接受 `+name`/`-name` 增量项；只含增量项的列表改变继承选择而非替换；`codemode` 由内建扩展以 inactive 注册，`{"defaultTools":["+codemode"]}` 即启用；`/reload` 对新加入项生效。

**关键陷阱（本实现已避开）**：`settings.md:40` 明确"空数组禁用全部内建工具"。因此关闭开关时必须**删除 `defaultTools` 键**，绝不能写 `[]`——否则会连带禁掉 `read`/`bash`/`edit`/`write`。该行为由测试 `disables codemode by stripping every codemode token and dropping an empty key` 锁定（断言落盘为 `{}`）。

与 v3 的差别：v3 落地时内嵌 pi 为 0.87.1，token 属前向兼容（不生效）；v3.3 已在 1.0.4 上，开关**立即生效**（新会话，或 `/reload`）。

## 架构核查发现

### 已解决

- **偏好键空间边界**：`pi.pathEnabled` 不走 `ui.*` 通用通道，改由专用 op 独占 + 桌面门禁。该决策写入 `docs/adr/0005-preference-key-space-boundary.md`（不改 ADR 0003 原文）——通用通道键空间一字未增，继续兑现 ADR 0003 的探测防护。

### 遗留（需 Dr. Lin 决定，未擅自扩面）

1. **settings 写锁不一致**：`set_default_codemode` 按 v3 语义使用 `withSettingsLock`，而同文件的 `set_default_thinking_level` / `set_default_auto_compaction` 是裸读改写（v3 早前已给这三处都加锁）。多窗口（每项目一个窗口、共享同一 `~/.pi/agent/settings.json`）并发写有丢失更新风险。建议单独立一个小 PR 把三处统一到 `withSettingsLock`（机制已在 `skill-inventory.ts` 导出），不宜混入 Phase 1。
2. **Windows 分支未编译验证**：`pi_path.rs` 的注册表实现（`RegOpenKeyExW` / `WM_SETTINGCHANGE` 广播）被 `#[cfg(target_os = "windows")]` 门控，macOS 上 `cargo check` 根本不编译该分支。features-v3 有同样限制（其 spec 记录由 Windows 构建路径兜底）。**需一次 Windows 构建/CI 验证**才能算闭环。
3. **PATH 开关在 dev 下不可用**：release-only（Q5 拍板，避免把 `target/debug` 写进用户 rc）。因此手测该功能必须用 release 构建，`bun run dev` 下只会看到"开发构建下不可用"的说明文案。
4. **首屏竞态（次要）**：`<button id="toggle-pi-path">` 初始未禁用，状态返回前点击会直接调 configure；宿主侧对不支持的 shell 会拒绝并内联显示错误（安全网在宿主），与 v3 行为一致，未加额外前端防护。

### 顺带发现的仓库文档漂移（非本 Phase 引入）

`AGENTS.md` 引用了三个**不存在**的文件：`ARCHITECTURE.md`、`docs/feature-v3-migration-playbook.md`、`docs/feature-v3-migration-matrix.md`（v3.3 无 ARCHITECTURE.md，docs/ 下只有 `feature-v3-phase-migration-plan.md`）。Agent 按指示去读会落空。建议一并修正引用（1 处段落），未擅自改动项目指令文件。

## 变更文件清单

| 文件 | 变更 |
| --- | --- |
| `extensions/picot-config.ts` | `get/set_default_codemode`（合并 token + `withSettingsLock`）+ 2 个 handler 分支 + import |
| `extensions/picot-config.test.ts` | 4 条 codemode 测试 |
| `public/native/settings/settings-toggles.js` | 声明式 toggle 列表加 `toggle-codemode` |
| `public/native/settings/pi-path-toggle.js` | 新增（PATH 开关 UI） |
| `public/native/settings/pi-path-toggle.test.js` | 新增（5 条） |
| `public/native/settings/settings-panel.js` | 接线 `setupPiPathToggle` |
| `public/native/transport/control-gateway.js` | `piPathStatus` / `piPathConfigure` |
| `public/index.html` | Code mode 行 + Embedded Pi 区块 |
| `public/locales/{en,zh,es,ja}.json` | `settings.codemode*` 2 键、`settings.piPath.*` 5 键 |
| `src-tauri/src/pi_path.rs` | 新增（verbatim + 两处接缝） |
| `src-tauri/src/main.rs` | `mod pi_path;` + 启动自愈 |
| `src-tauri/src/host_server.rs` | `ensure_desktop_client` + `pi_path_status` / `pi_path_configure` |
| `docs/adr/0005-preference-key-space-boundary.md` | 新增 |
