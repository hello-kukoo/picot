<!-- ABOUTME: feature-v3 设置页家族移植到 v3.3 的分阶段迁移计划。 -->
<!-- ABOUTME: 模式沿用 docs/feature-v3-phase-migration-plan.md；拍板记录与各 Phase v3 提交映射自含。 -->

# feature-v3 设置页家族 → v3.3 分阶段迁移计划

> 状态：草案待 Dr. Lin 批准。流程沿用上轮：差异审计先行 → verbatim 优先 + 标识符映射 → TDD → 聚焦验证 → `bun run test`/`check`/`check:rust` → hunk + reviewer 双评审 → 人工测试 → 单 PR 单主题。
>
> 关联：`docs/feature-v3-phase-migration-plan.md`（上轮移植计划，模式范本）。
> 注意：AGENTS.md 与上轮计划引用的 `docs/feature-v3-migration-playbook.md` / `docs/feature-v3-migration-matrix.md` 已不存在（文档漂移）。本计划自含映射要点；收尾时顺带修复该引用（1 行改动）。

## 拍板记录（2026-10-06，Dr. Lin）

1. **MCP 路线：先升 Pi 再移植**——Phase 0 将内嵌 Pi 0.85.1 → 1.0.4，MCP 页直接移植 picot-v3 终态（原生两层配置），不做 adapter 历史版。
2. **「设置页的其他改变」范围**：Code mode 开关、Pi PATH 开关（含 embedded pi 路径切换）、技能页 scope 页签。embedded pi 路径切换并入 Phase 1。
3. 本轮**不含**：file panel icon、info panel、anydoc、内置浏览器（非设置页）。
4. 版本号两线完全独立，迁移不涉及版本对齐。

## 双架构速查（设置页面）

| 维度 | features-v3（源，picot-v3） | v3.3（目标，本仓） | 移植策略 |
| --- | --- | --- | --- |
| 内嵌 Pi | 1.0.4 | 0.85.1 | Phase 0 升级到 1.0.4，之后单一基线 |
| host op 通道 | `operation_registry.rs` + 帧级门禁，14 个 `*_config.rs` | `RoutedAction::Host{operation}` 骨架已有（`host_router.rs`） | 后端近直搬；先做一次「注册/门禁模式对齐」差异审计 |
| bridge op 通道 | config-gateway → `/picot-config <json>` prompt → `picot-config.ts` → notify 回包 | **同形**（`config-gateway.js` + `picot-config.ts`） | 几乎 verbatim |
| 设置面板 | 扁平 `public/`，landing + 主窗口双接线 | `public/native/settings/` 成熟面板（`settings-panel.js` 389 行），仅主窗口 | 前端渲染逻辑可搬，**接线层按 v3.3 模式重写**（工作量主体，估渲染 30% / 接线 70%） |
| OAuth 基建 | `mcp_login_runner.rs` + `pi-oauth-login-adapter.ts` | `oauth-gateway.js` + `models-oauth-login.js` + `pi-oauth-login-adapter.ts` + `oauth-login-operations.ts`（模型 OAuth 全链已有） | MCP OAuth 审计 adapter 覆盖面后复用/补齐 |
| i18n | 四语言 + 完整性测试 | 同（`public/locales/` ×4 + `i18n-keys-completeness.test.js`） | 键直接搬运 |
| sqlite | `metadata_store.rs`（existence-based 建表惯例） | `metadata_store.rs` 已有 | 账本/表挂载点现成 |

## 防重清单（v3.3 已有，勿重复立项）

| 能力 | v3.3 现状 |
| --- | --- |
| 模型 OAuth 全链 | `models-oauth-login.js` + `oauth-gateway.js` + `pi-oauth-login-adapter.ts` + `oauth-login-operations.ts` ✓ |
| bridge 写 auth.json 先例 | `picot-config.ts` `set_api_key`/`remove_api_key` ✓ |
| bridge op 请求/关联回包 | `config-gateway.js` id 关联 + `consumeNotify` ✓ |
| host op 分发骨架 | `host_router.rs` `RoutedAction::Host` ✓ |
| cost 面板（quota 挂载点） | `cost-dashboard.js` / `cost-dashboard-render.js` 分离 ✓ |
| Rust sqlite | `metadata_store.rs` ✓ |

---

## Phase 0：内嵌 Pi 0.85.1 → 1.0.4（全局前置，独立 PR）

> 状态：**已完成实施**（2026-10-06）——影响记录 `docs/pi-1.0.4-upgrade-impact.md`，契约决策 `docs/adr/0004-embedded-pi-1.0.4-upgrade.md`。目标版本由计划初稿的 1.0.2 上调为 1.0.4（1.0.2→1.0.4 无 breaking changes；1.0.4 修复 `#10493` MCP OAuth native client 注册，为 Phase 6 所依赖）。

**动机**：MCP 原生两层配置是 pi 1.0+ 硬依赖；此后所有 Phase 单一版本基线，无双版本兼容成本。

**步骤**（参照 picot-v3 `pi-upgrade-impact` 流程：评估与升级动作分离）：

1. 影响评估先行：盘点 v3.3 对 pi 0.85 RPC 契约的假设（`runtime-adapter.js` / `runtime-gateway.js` / `runtime-frame-routing.js` / `native_pi_manager.rs` / `pi_rpc_bridge.rs`），对照 pi 0.85→1.0.4 变更清单
2. 版本锁定四处齐动：`scripts/pi-version.json`（version + 6 平台 sha256 钉值）、`package.json` devDep `@earendil-works/pi-coding-agent` 同步（漂移会使 `oauth-login-smoke` 的真实运行时断言静默跳过）、`bun install`、`bun run fetch:pi`，再 `./src-tauri/resources/pi/pi --version` 冒烟
3. `bun run smoke:pi-rpc --update` 生成 `tests/fixtures/pi-rpc/1.0.4/contract.json` 并**评审漂移 diff**（不盲目提交）；比对 `resources/pi/docs/rpc.md` 契约面
4. 全量 `bun run test` + `bun run check` + `bun run check:rust` + 扩展运行时端到端（`-ne` 隔离全局用户扩展后加载 `extensions/dist/picot-bridge.mjs` 实测 op）；手测核心流（聊天、设置、文件预览、终端、git 面板）。v3.3 特有面加测：远程 SSH 会话、子代理、扩展设置页（host op 已上线部分）、模型 OAuth（登录+列表）、技能页
5. **回滚路径**：revert `scripts/pi-version.json` + `package.json` + `bun.lock` → `bun install` → `bun run fetch:pi`（恢复 0.85.1，归档缓存在）→ 全量回归。回滚是常规手段不丢人（picot-v3 `16b6018` 先例）
6. 遇破坏性变更：先评估适配，不回退 pin；确属阻断再回报 Dr. Lin 拍板（picot-v3 的 1.0.0 回退是 pi-subagents 未兼容所致，本仓无此历史包袱）

**v3 参照链**：`edfdc68`(0.99.2) → `d5da2df`(1.0.0) → `16b6018`(回退) → `e6f2a3c`(1.0.0) → `d52aefc`(1.0.2) → `1.0.4`（当前两仓同基线）。
**已知坑（v3 实录）**：pi-agent-core 1.0.0 删 `./node` 子路径导出，断 pi-subagents<0.75.0 后台 runner；extension 内存代码不随磁盘升级热重载（长会话须新开会话验证）。

**验收**：`bun run test` / `bun run check` / `bun run check:rust` 全绿 + 扩展运行时端到端通过 + 手测清单由 Dr. Lin 走查 + 升级影响记录与 ADR 随同交付。

## Phase 1：设置小开关组（S）

| 项 | v3 来源 | 落点 |
| --- | --- | --- |
| Code mode 系统级开关 | `4b79453`（settings.json `defaultTools "+codemode"` token 合并写） | 通用页 toggle + picot-config op。**首个审计点**：核实 v3.3 `picot-config.ts` 是否已有写 Pi `settings.json` 的 op（有 `set_api_key` 写 auth.json 先例，settings.json 未必有）；缺则本 Phase 第一个 commit 补该 op + token 合并写单测 |
| 内置 Pi 系统级 PATH 开关 | `878b3d8`（通用页） | 通用页控件 + Rust `pi_launch.rs` 语义 |
| embedded pi 路径切换 | v3 spec `2026-09-23-embedded-pi-path-toggle`（审计时从 spec 取提交号） | `pi_launch.rs` + 通用页 |

**验收**：三开关写盘生效 + 回显 + 重启保持 + 四语言 + vitest；触及 Rust 跑 `check:rust`。

## Phase 2：14 个扩展专属设置页（M，拆 2–3 个 PR）

**索引**：v3 `2026-09-16-extension-settings-rollout-inventory`；首批提交 `899d488`（advisor via bridge、fff via host ops + 包名映射表）。

**确切清单（12 项 inventory + 2 项已实现 = 14 页）**：

| # | 包 | 通道 | 配置文件 |
| --- | --- | --- | --- |
| 已实现 | advisor | bridge（`899d488`） | XDG |
| 已实现 | fff | host（`fff_config.rs` 先例） | file-only |
| 1 | `@juicesharp/rpiv-todo` | host | `~/.config/rpiv-todo/config.json` |
| 2 | `@juicesharp/rpiv-ask-user-question` | host | `~/.config/rpiv-ask-user-question/config.json` |
| 3 | `pi-caveman` | host | `~/.pi/agent/caveman.json` |
| 4 | `@dietrichgebert/ponytail` | host | `~/.config/ponytail/config.json` |
| 5 | `@sting8k/pi-vcc` | host | `~/.pi/agent/pi-vcc-config.json` |
| 6 | `@narumitw/pi-goal` | host | `~/.pi/agent/pi-goal.json` |
| 7 | `@narumitw/pi-plan-mode` | bridge | `~/.pi/agent/pi-plan-mode.json` |
| 8 | `@firstpick/pi-extension-safety-guard` | bridge | `~/.pi/agent/safety-guard.json` |
| 9 | `@demigodmode/pi-web-agent` | host | `~/.pi/agent/extensions/pi-web-agent/config.json` |
| 10 | `pi-cache-optimizer` | host | `~/.pi/agent/pi-cache-optimizer-config.json` |
| 11 | `pi-lens` | host | `~/.pi-lens/config.json` |
| 12 | `pi-web-access` | bridge | `~/.pi/agent/web-search.json` |

**基建核心（随 #1 一并移植）**：v3 的 per-package renderer map + 双通道路由（`{ configGateway, transport }`）+ host 侧 `fff_config.rs` 控制模式（`require_native_owner` + `host_config::write_json` + 每包独立 Rust 模块）。bridge 三项（#7/#8/#12）依赖模型目录（plan-mode/safety-guard 复用 advisor model-picker 机制）。

1. **差异审计（第一个 commit）**：v3.3 `RoutedAction::Host` 的注册/门禁模式 vs v3 `operation_registry.rs`，输出 host op 挂载方式结论（后续 Phase 5/6 复用）
2. 首页（advisor 或 fff）趟通通道：后端 op + `renderXxxSettings` 前端 + 包名映射 + 未安装降级态 + i18n ×4 + vitest
3. 其余按上表批量：host 通道 8 项、bridge 通道 3 项（#7/#8/#12 保持 bridge，勿迁 host——v3 已拍板模型目录依赖项留 bridge）
4. **未安装降级态一等公民**——公司扩展在部分环境缺失，页面必须可开、可读、不可写

**验收**：每页读写 round-trip + 未安装态 + `check`；host op 页加 `check:rust`。

## Phase 3：Provider 额度区块（M，可与 Phase 2 并行）

**v3 来源**：spec `b4a9f6e`（2026-09-22，于 pi 0.85.1 上实现——本 Phase 无 Pi 门槛）。

| 单元 | v3 位置 | v3.3 落点 | 搬法 |
| --- | --- | --- | --- |
| 探针/解析/TTL 缓存/去重/幂等 | `extensions/provider-quota.ts` | 同位 | verbatim |
| 三 op | `picot-config.ts`：`provider_quota_report` / `codex_reset_credits_inspect` / `codex_reset_credits_consume` | 同文件追加 | 近直搬（通道同形） |
| Codex 重置防双花账本 | Rust `reset_credit_operations` existence-based 建表 + open/settle/abandoned 清扫 | 挂 `metadata_store.rs`，owner 门禁对齐 v3.3 数据面模式 | 适配移植 |
| 前端区块 | `public/cost/provider-quota-panel.js`（dashboard rendered 事件驱动） | 挂 `cost-dashboard.js`/`render` | 渲染搬、接线重写 |
| i18n | `cost.quota.*` ×4 | `public/locales/` ×4 | 直搬 |

**验收**：解析器纯函数单测（mock 响应）+ 真实凭据手测 7 provider（Codex plan/GLM/Opencode Go/DeepSeek/MiniMax/Moonshot/Ollama Cloud 含 CN 站）+ Codex 重置幂等/重启清扫走查（v3 spec 留存的人工走查项，移植后同样执行）。

## Phase 4：Subagents 设置页 —— 已取消（Dr. Lin 2026-10-07）

> **决定**：不移植。本 phase 实施期间写下的代码已全部回退，工作树回到 Phase 3 的 HEAD（`d032f0b`）。
>
> **实施时发现的阻塞（供将来重新评估，勿重复踩坑）**：`subagents_settings.rs` 的 `authorize_scope` 依赖
> 「该客户端当前绑定哪个工作区 + generation」，而 v3.3 的 `WindowOwnerRegistry`（748 行，实现与测试完整）
> **生产代码从未实例化**——`default()` 的命中全在测试模块，且无任何生产调用 `create_owner` /
> `begin_workspace_transition` / `commit_workspace_transition`；`HostState` 亦无 `owner_registry` 字段。
> v3.3 既有的 owner-scoped 先例是句柄注册表（`SkillSourceRegistry`，其 `resolve` 本身也标着
> `#[allow(dead_code)]`，同样未启用），而 subagents 的 op 由前端直接传 `workspaceId/workspaceGeneration`，
> 没有句柄可校验。故忠实移植需先激活 owner registry（触及窗口生命周期与 capability 分发），
> 或放弃 v3 明确建立的 `stale_generation` 保护。
>
> **当时已完成并验证过、随后回退的部分**：`project_trust.rs` 只读子集（`is_project_trusted`，2 测试；
> 有意不移植写路径，避免 Picot 成为 pi `trust.json` 的第二个写入者）、`subagents_inventory.rs` verbatim
> （2091 行 + 21 测试）、`subagents_settings.rs` 适配版（2341 行 + 22 测试）、`window_owner` 的
> `OwnerWorkspaceSnapshot` 两态枚举、`percent-encoding` 依赖（inventory 的百分号解码安全检查所需）。

**v3 提交链**：`d343d97`(盘点页+host 四 op) → `508f178`(名字级覆盖+四字段) → `c91e325`(双级子页签+覆盖编辑器+模型下拉) → `d057775`/`df6449c`(停用开关位置定稿：detail 名字行右对齐) → `a0f09bf`/`b22bd87`(scope 描述+分段圆角样式) → `233947e`/`d758079`(回归+i18n)。移植取终态，历史链仅作理解。

| 单元 | 搬法 |
| --- | --- |
| `subagents_inventory.rs` + `subagents_settings.rs`（settings.json agentOverrides 读写 + agents 目录/包扫描 + hard_link 发布 + 影子快照确认 + 双同名拒绝） | 近直搬，op 分发按 Phase 2 审计结论挂 |
| `subagents-tab.js`（scope 页签=全局/项目 + 子页签=自定义/扩展包 + 覆盖编辑器 + 行内停用） | 渲染搬，接线按 settings-panel 模式重写 |
| composer 模型下拉 | 复用 v3.3 `models-page.js` 模型目录（勿搬 v3 landing 版懒加载） |
| locale `subagents.*` ×4 | 直搬 |

**依赖**：pi-subagents 用户级包；Phase 0 后 0.75.0 兼容（设置页读写本身不依赖 runner，页面对 spawn 可用性如实标注）。

**验收**：覆盖 round-trip（global/project 两层）+ 优先序 builtin<package<user<project 判定 + 双同名拒绝 + 停用开关 + 滚动位置保持 + 四语言。

## Phase 5：技能页 scope 页签 + 内联安装（S–M）

**v3 来源**：`d6126a3`（scope 两页签 + 内联安装 + 恢复三态分组）。

**依赖**：本 Phase 开工前置 = Phase 2 的 host op 审计结论落地（审计决定走 bridge 还是 host op）。
**差异审计先行**：v3.3 技能走 bridge 通道（`skill-inventory.ts`/`skill-discovery.ts`/`skill-installation.ts`）+ 前端 `package-skills-tab.js`/`skills-discovered-tab.js`/`skills-install-tab.js`；v3 走 `host_skills.rs` host op。审计两者能力差（scope 维度、内联安装、三态分组），**倾向复用 v3.3 bridge 通道加 scope 维度**；若 host op 语义明显更完整，Phase 2 趟通后移植成本已摊薄，可改走 host op。

**验收**：全局/当前项目两页签 + 内联安装 + 三态分组 + 无工作区场景 + 四语言。

## Phase 6：MCP 设置页（L，依赖 Phase 0）

**v3 终态提交**：`2a54f9f`（Pi 原生两层配置，禁用状态以配置为准）。历史链 `5548f03`(adapter 版) → `2305042`(旧 mcp.json 确认式迁移+0600) → `6e82cc9`(OAuth GUI) → `eb71ffd`(切原生) → `2df55e9`/`85479cc`/`036377d`(布局/页签/文案) 仅作理解，不逐段移植。

| 单元 | 搬法 |
| --- | --- |
| `mcp-settings.ts` + `mcp-native-config.ts`（两层配置读写：`~/.pi/agent/mcp.json` 全局 + 项目级） | 近直搬 |
| MCP OAuth 登录 | `mcp_login_runner.rs` 移植；v3.3 已有 `pi-oauth-login-adapter.ts`——审计其对 mcp login 命令的覆盖面，缺则补 |
| 旧 mcp.json 一次性迁移 | 确认式（不自动）+ 配置文件 0600（`2305042` 语义） |
| MCP 页前端（全局/当前项目页签 + 无工作区隐藏项目页签 + exposure 控件 + 页面描述） | 渲染搬、接线重写 |

**验收**：两层配置读写 + 禁用状态以配置为准 + OAuth 登录全流程（含失败路径）+ 旧配置迁移确认流 + 四语言。

---

## 文档收尾（随各 Phase 交付，不留到最后）

- ADR：Phase 0 Pi 1.0 升级契约；Phase 2 host op 设置面边界；Phase 3 reset credit 账本
- `ARCHITECTURE.md` 增量随落地写入（上轮 L5 教训）
- 修复 AGENTS.md 对已不存在的 playbook/matrix 的引用（1 行）

## 顺序与并行

```text
Phase 0（Pi 升级,全局前置）
  └→ Phase 1（小开关）→ Phase 2（13 扩展页,趟通 host op）→ Phase 6（MCP）
  └→ Phase 3（quota,独立,可插在 2 后任意点）
  └→ Phase 5（技能 scope,依赖 Phase 2 结论,可提前）
```

规模估计：P0 中 / P1 小 / P2 中（拆 PR）/ P3 中 / P4 已取消 / P5 小中 / P6 大。

## 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 架构分叉：逐字节搬只对后端纯逻辑成立，UI 接线必重写 | 估算按渲染 30%/接线 70%；每 Phase 差异审计先行 |
| R2 | Pi 升级波及全 app（RPC 契约 0.85→1.0 跨大版本） | Phase 0 独立 PR + 全量回归，不带功能改动 |
| R3 | 公司扩展未安装环境 | 未安装降级态一等公民（Phase 2） |
| R4 | 上游持续合并造成冲突 | 新代码独立文件，现有文件最小侵入 |
| R5 | quota 端点需真实凭据 | 人工走查清单随 PR（R5 = v3 spec 遗留项） |
| R6 | v3.3 host op 门禁模式与 v3 差异未核实 | Phase 2 首个 commit 即审计 |
