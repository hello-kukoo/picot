<!-- ABOUTME: 迁移计划 Phase 2 的首个交付物——host op 注册/门禁的差异审计结论。 -->
<!-- ABOUTME: 结论供 Phase 2/4/5/6 复用：无注册表可移植，需补 host_config 与渲染器体系。 -->

# Phase 2 审计：host op 注册、门禁与每包设置页落点

- 日期：2026-10-06
- 计划：`docs/feature-v3-settings-migration-plan.md` Phase 2（首个 commit 的交付物）
- 复用方：Phase 4（Subagents）、Phase 5（技能页 scope）、Phase 6（MCP）

## 结论速览

| 问题 | 结论 |
| --- | --- |
| v3 是否有 op 注册表要移植？ | **没有。** `operation_registry.rs`（476 行）是异步任务幂等登记（accept/get/complete/mark_indeterminate），与 host op 分发无关。host op 两仓都是 **match 分支**：v3 在 `main.rs install_control_handler`，v3.3 在 `host_server.rs dispatch_host_operation` —— **同形，无需移植机制。** |
| 门禁怎么对齐？ | v3 用 `require_native_owner(&ctx)`；v3.3 无对应物，用 Phase 1 建立的 `ensure_desktop_client(state, client_id, op)`（`host_router::HostRouter::client_kind`）。每包设置 op 写的是用户 `~/.pi/agent/*.json`、`~/.config/*.json`，与 PATH 开关同属"触及 Picot 之外"的一类，桌面门禁一致。 |
| 共享 JSON 配置读写怎么办？ | **v3.3 没有，必须移植 `host_config.rs`（29 KB）**——它是全部 8 个 host 侧包模块的共同依赖，也是 Phase 2 的地基。 |
| 前端渲染器体系？ | v3.3 **无每包设置 UI**；需移植 `SETTINGS_RENDERERS` 映射 + 渲染器，并按 v3.3 模块纪律拆分（v3 那一个文件 2072 行，远超 500 行警戒线）。 |
| 挂载点在哪？ | `public/native/settings/package-manager.js` 的详情面板 `#pkg-manager-detail`（`detailEl` 在 144 行取、388-456 行组装），与 v3 的 `renderExtensionSettings(detailEl, pkg, …)` 同构。 |
| 传输面？ | v3 用 `WsTransport` 上的 `getTodoConfig`/`setLensConfig` 等 16 个方法 + `withOkFlag()` 归一化；v3.3 对应 `HostControlGateway` 方法，需同样归一化以让渲染器不关心自己走哪条通道。 |

## v3 侧解剖（移植源）

**共享助手 `src-tauri/src/host_config.rs`**：`MAX_CONFIG_BYTES = 512 KiB`、`ConfigError`、`read_json`、`revision_of`（乐观并发用的修订号）、`update_json_locked`（目录锁 + 重读改写的唯一入口）、`reject_symlink_ancestry`（防符号链接逃逸）、`write_text`、`write_json`。安全语义集中于此，逐字节移植。

**每包模块（8 个，约 85 KB）**：`fff_config.rs`(19 K)、`rpiv_config.rs`(11 K，覆盖 rpiv-todo + rpiv-ask-user-question)、`lens_config.rs`(11 K)、`goal_config.rs`(10 K)、`cache_optimizer_config.rs`(7 K)、`ponytail_config.rs`(6 K)、`caveman_config.rs`(4 K)、`vcc_config.rs`(4 K)。每个都是"专用 op + 该配置文件的读写"。

**前端渲染器映射（v3 `package-extension-settings.js`）**：12 条 `SETTINGS_RENDERERS` + safety-guard 后缀匹配（13 个渲染器），每条 `{ dep: "transport" | "configGateway", render }`；`HOST_CONFIG_METHODS` 列 16 个 host 侧方法并由 `withOkFlag()` 把 `transport` 载荷归一为 `{ok, data|error}`，使渲染器不必知道通道；`appendSettingsFailure()` 保证渲染器抛错时详情页留一行而不是拖垮页面。

**通道划分（沿用 v3 拍板，不在 Phase 2 重议）**：host 通道 = fff、rpiv-todo、rpiv-ask-user-question、ponytail、vcc、goal、caveman、cache-optimizer、lens；bridge 通道（依赖模型目录）= plan-mode、safety-guard、web-access。advisor 亦为 bridge。

## 建议实施顺序（与计划的"首页趟通"一致）

1. **地基**：移植 `host_config.rs`（本审计后的第一个改动），补 Rust 单测（容量上限、符号链接拒绝、修订号语义）。
2. **首页趟通**：选 **fff**（v3 中 host 通道的先例，`19 K` 覆盖最全），打通 模块 → op → 网关方法 → 渲染器 → 详情页挂载 → 未安装降级 全链路。
3. **批量其余 host 包**：rpiv（todo + ask-user 两页共享机制）、ponytail、vcc、goal、caveman、cache-optimizer、lens。
4. **bridge 三页**：plan-mode、safety-guard、web-access（走 `configGateway`，需模型目录，属 v3 已拍板的例外）。
5. **模块拆分**（v3.3 纪律，与步骤 2-4 并行落实）：`public/native/settings/extension-settings/` 下按包或族拆文件，`index.js` 只放映射 + 挂载；避免再造一个 2000 行文件。

## 本阶段已落地（Phase 2 同一 commit 的一部分，尚未提交）

- `src-tauri/src/host_config.rs` 已移植（682 行，含 10 条单测）并注册 `mod host_config`；
  `cargo test` 281 条通过，`check:rust` 全绿。
- **两处测试为 Phase 4 归还**：`locked_update_preserves_unrelated_json_and_prunes_empty_layers`
  整条移除；`locked_update_busy_when_lock_held_and_invalid_layer_shapes_reject` 改名
  `locked_update_busy_when_lock_held_blocks_the_transaction` 并只保留 Busy 断言——
  两者的无效形状循环都依赖 `crate::subagents_settings::apply_override_edit`（Phase 4 的模块）。
  **Phase 4 落地 `subagents_settings.rs` 时必须把这两条测试连同语义一起恢复。**
- `host_config.rs` 顶部保留 `#![allow(dead_code)]`：Phase 2 的 8 个模块只用其**朴素读写面**，
  而 `update_json_locked`（修订号校验 + 目录锁的读改写）与符号链接/备份机制要到 Phase 4
  （subagents override 编辑器）与 Phase 6（MCP 配置页）才有消费者。**那两个 phase 落地后删除该 allow**；
  v3.3 的 `settings_store.rs` 有同类先例。
## 实施结果（Phase 2 收口）

**范围修正：13 页，不是 14。** inventory 的 #9 `@demigodmode/pi-web-agent` 在 features-v3 **从未实现**——
全仓无该 spec 文件（`find docs -iname '*web-agent*'` 为空），渲染器映射恰好 13 条。本仓按实际存在的 13 页移植。

| 通道 | 页数 | 实现 |
| --- | --- | --- |
| host（控制面 op） | 9 | fff、rpiv-todo、rpiv-ask-user-question、ponytail、vcc、goal、caveman、cache-optimizer、lens |
| bridge（configGateway，需模型目录） | 4 | advisor、plan-mode、safety-guard、web-access |

**Rust 侧**：`host_config.rs`（共享助手）+ 8 个 `*_config.rs`（fff 单独 + 7 个批量）+ `extension_config.rs`
（op → 模块表，18 个 op，单一委派臂进 `dispatch_host_operation`，保持 facade 薄）+ `pi_launch::resolve_pi_agent_root`。
`cargo test` 309 条通过。

**前端**：`public/native/settings/extension-settings/` 下按页拆 13 个渲染器模块 + `index.js`（映射 + 挂载 +
`withOkFlag`）+ `shared.js`（`fieldRow`）+ `model-choices.js`（模型选择器助手）。挂载点 =
`package-manager.js` 的 `#pkg-manager-detail` 详情面板末尾。

### 三处对 v3 的有意偏离（都比 verbatim 更正确）

1. **`withOkFlag` 只在成功路径补 `ok: true`**（不吞 reject）。v3 的版本把失败也转成 `{ok:false}`，导致不检查
   `ok` 的渲染器（如 fff）在失败时渲染空表单且不报错。本仓保留 reject，于是两类渲染器都对：检查 `ok` 的
   （rpiv 两页，自带 `.catch()`）拿到契约，try/catch 的（fff）拿到错误。
2. **补 `settings.saved` 全局键**：v3 的 rpiv 渲染器引用它但 v3 locale **没有这个键**（界面上显示键名）。
   本仓补四语言文案，i18n 完整性测试据此通过。
3. **`filterModelsByCatalogVisibility` 移植进 `composer/model-selection.js`**（v3 在 `models/selection.js`，
   本仓该路径不存在），并把 `noteWhenCatalogUnavailable` 从内部函数改为导出（拆分文件后渲染器需要 import）。
   另补 `models.unavailableHelp` 键。

### 未安装降级态

结构上不存在"已安装但无渲染器"之外的缺口：设置区块只在包详情面板内挂载，而未安装的包不会出现在
`pi list` 的列表里，因此没有详情面板可挂。真正的降级路径都已被测试覆盖——配置文件缺失（Rust 侧回落默认值）、
op 失败（渲染器内联显示错误，`index.test.js` 断言）、依赖缺失（渲染器不挂载，`index.test.js` 断言）。

## 未决/风险

- **未安装降级是一等公民**：公司扩展在部分环境缺失。v3 的做法是"缺少依赖即不渲染"，但计划的验收要求"页面可开、可读、不可写"——需在首页趟通时定下具体形态（读失败显示不可用行 + 禁用控件），并覆盖测试。
- **revision/乐观并发**：`revision_of` + `update_json_locked` 是"外部（Pi 或用户）同时改配置文件"的防护。渲染器是否要把 revision 回传取决于 v3 各页实现，移植时逐页确认，不要自行简化掉。
- **Windows 无差异面**：这 8 个模块只做 JSON 文件读写，无平台分支，可在 macOS 完整验证（与 Phase 1 的 `pi_path.rs` 不同）。
