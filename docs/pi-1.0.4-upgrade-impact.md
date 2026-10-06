<!-- ABOUTME: 内嵌 pi 0.85.1 → 1.0.4 升级的影响评估与验证记录。 -->
<!-- ABOUTME: 迁移计划 Phase 0 交付物；含集成面审计、RPC 契约实测、验证证据与回滚路径。 -->

# 内嵌 pi 0.85.1 → 1.0.4 升级影响与验证记录

- 日期：2026-10-06
- 目标：`docs/feature-v3-settings-migration-plan.md` Phase 0（全局前置）
- 锁定版本：`scripts/pi-version.json` → `1.0.4`（含 6 平台 sha256）
- 依据：features-v3 `docs/superpowers/specs/process-evidence/2026-10-06-pi-1.0.4-impact.md`（1.0.2→1.0.4 评估）；本记录补 0.85.1→1.0.4 全跨度审计

## 为什么是 1.0.4 而非计划初稿的 1.0.2

计划初稿按 features-v3 当时的 pin 写 1.0.2。开工时的最新证据把目标定为 1.0.4：

1. 1.0.2→1.0.4 评估结论为「干净」：无 breaking changes 章节，唯一 soft 项是 1.0.3 的 Azure provider 改名。
2. 1.0.4 修复 `#10493` MCP OAuth native client 注册（`invalid_redirect_uri` 一类失败）——正是 Phase 6 MCP 登录依赖的上游缺陷。
3. features-v3 已把 pin 提到 1.0.4 并留下 `1.0.4` 契约 fixture，两仓同基线便于后续 verbatim 移植。

## 集成面审计（0.86.0 → 1.0.4 全跨度破坏性变更 × v3.3）

变更清单取自上游各包 CHANGELOG 的 `Breaking Changes` / `Removed` 节（coding-agent / agent / ai / mcp / server / tui）；命中面用 `rg` 在 `public/`、`extensions/`、`src-tauri/src/` 逐项核实。

| 上游变更 | v3.3 是否触碰 | 结论 |
| --- | --- | --- |
| agent 1.0.0 删除 `./node`、`./harness/*` 等子路径导出（harness 整体移除） | 否（全仓无该子路径 import） | 无影响。**用户侧** pi-subagents < 0.75.0 后台 runner 依赖它 → 需 pi ≥ 1.0 兼容版 |
| coding-agent 0.87 `shouldStopAfterTurn` → `finishTurn` | 否 | 无影响 |
| coding-agent 0.87 `SessionEntry` 联合新增 `ContextEditEntry`（穷尽 switch 需处理） | 否（无 `SessionEntry`/`context_edit` 使用） | 无影响 |
| coding-agent 0.87 `SessionManager` 成为 provider context 权威；赋值 `session.agent.state.messages` 不再替换历史 | 否（无该赋值） | 无影响 |
| coding-agent 0.87 `TurnEndEvent` 扩字段、`ExtensionEvent` 新增 `AgentBeforeSettleEvent`、`ExtensionRunner.emit()` 不再接受 `turn_end` | 否（仅一处注释提及 ExtensionRunner） | 无影响 |
| coding-agent 0.87 `agent_settled` handler 内延迟 run 语义收紧 | v3.3 仅**消费**该 wire 事件名（`native_pi_manager.rs` / `app.js` / 通知模块），非注册 handler | 无影响 |
| coding-agent 0.86 `user_bash` 改 fail-closed（返回非法值即中止命令） | **是**：`extensions/ssh-remote.ts:1020` | **兼容**——handler 恰好只返回 `undefined`（本地）或 `{ operations }`（远端），符合新契约 |
| coding-agent 0.86 自定义 provider 流输入 `Context` → `TranscriptContext` | 否（仓内无自定义 provider 流实现） | 无影响 |
| ai 0.99 图像模型并入统一 `Provider`/`Models`（`ImagesModels` 等移除、模型数据 schema v6） | 否（无 `ImagesModels`/`createImagesModels`/`builtinImagesModels` 使用） | 无影响 |
| tui 0.99 `queryTerminalColorScheme/BackgroundColor` → `queryTerminalColors` | 否 | 无影响（custom-ui-bridge 不调该 API） |
| mcp 1.0.1 `OAuthClientProvider.clientMetadataUrl` → `clientMetadataDocument` | 否（v3.3 现无 MCP OAuth client 代码） | 无影响；**Phase 6 实现时按新接口写** |
| server 1.0.0 `SessionMetadata` 改由 pi-server 导出 | 否（无 pi-server 依赖） | 无影响 |
| coding-agent 1.0.3 Azure provider `azure-openai-responses` → `azure` | 是（`picot-config.ts:424` 旧串映射、`models-page.js:24` 图标 alias） | **无需改动**：`providerIcon()` 有精确匹配回退（`PROVIDER_ICON_ALIASES[provider] \|\| provider`），且 `public/icons/providers/azure.svg` 存在；旧串映射按设计保留 |
| coding-agent 1.0.1 移除 `npm-shrinkwrap.json`（npm 安装不再 pin 传递依赖） | 否（内嵌走 bun 编译二进制） | 无影响 |
| `SessionManager.listAll/open/inMemory` 直调（`picot-config.ts`） | 是 | **兼容**：1.0.4 仍导出；`ctx.navigateTree(targetId, options)` 在 1.0.4 扩展上下文仍在（`runner.ts:1014`），实测 op 返回成功 |

## RPC 契约实测（`bun run smoke:pi-rpc`）

新增 `tests/fixtures/pi-rpc/1.0.4/contract.json`，与 0.85.1 逐字段对比：

| 字段 | 0.85.1 | 1.0.4 | 判定 |
| --- | --- | --- | --- |
| `commands`（6 条 smoke 命令） | 全部成功 | 全部成功 | 一致 |
| `stateFields` | 10 个 | 10 个 | 一致 |
| `eventTypes` | `extension_ui_request` | `extension_ui_request` | 一致 |
| `commandSources` | `extension, skill` | `extension, prompt, skill` | **附加性**新增 `prompt`（提示模板作为命令来源），非破坏 |
| `promptAcceptance` | true | true | 一致 |

文档层面另核：0.85.1 的 `docs/rpc.md` 在 1.0.4 被拆为 `rpc.md` + `rpc-commands.md` + `rpc-extension-ui.md`，并新增 `mcp.md`、`virtual-models.md`、`message-types.md`、`cli.md` 等。RPC 命令 token 抽取对比：旧文档 38 个命令**全部保留**，事件名（`agent_settled`、`tool_execution_start`、`message_update`、`text_delta`、`queue_update`、`auto_retry_*`、`bash_execution_update` 等）在新文档仍全部收录（多数迁至 `json.md`/`message-types.md`）。AGENTS.md 引用的 `docs/rpc.md` 路径仍有效。

## 验证证据（全绿）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 二进制版本 | `./src-tauri/resources/pi/pi --version` | `1.0.4` |
| 下载完整性 | `bun run fetch:pi` | sha256 校验通过（6 平台钉值已对官方 SHA256SUMS 逐项核对） |
| RPC 契约 | `bun run smoke:pi-rpc` | passed（6 commands） |
| 扩展运行时（端到端） | 见下 | bridge 加载并服务 op 成功 |
| 前端 + 扩展套件 | `bun run test` | 187 文件 / 1523 测试全通过 + Tauri 权限检查 OK |
| 静态与设计检查 | `bun run check` | exit 0（余 1 条**预先存在** warning，见下） |
| Rust | `bun run check:rust` | 263 测试通过（1 ignored），clippy 干净 |
| 扩展构建 | `bun run build:extensions` | `picot-bridge.mjs` 754 KB / `pi-chat.mjs` 131 KB |

**扩展运行时端到端**（临时脚本，验证后已删；复现方式）：

```bash
./src-tauri/resources/pi/pi --mode rpc --no-session -ne \
  --extension extensions/dist/picot-bridge.mjs
# 然后发送 {"type":"prompt","message":"/picot-config {\"id\":\"cfg-1\",\"op\":\"get_default_thinking_level\",\"params\":{}}"}
```

实测返回（`ctx.ui.notify` 回包 `__picotConfig` 关联键）：

- `get_default_thinking_level` → `{"ok":true,"data":{"level":"medium","source":"global","path":"~/.pi/agent/settings.json"}}`
- `get_oauth_login_capabilities` → `{"ok":true,"data":{"providers":[{"providerId":"openai-codex","deviceCode":true,"configured":true}]}}`

注意：必须带 `-ne`（`--no-extensions`）——本机全局用户扩展（如 `~/.pi/agent/.../datarx-programming/extensions/unified-edit.ts`）会与 bridge 的工具名冲突导致加载失败。`-ne` 只禁发现/配置的内建扩展，显式 `-e` 仍加载。

## 已知遗留（非本次引入）

1. `extensions/picot-config.ts:106` biome `lint/suspicious/noConfusingVoidType` warning——**HEAD 即存在**（已用 HEAD 版本单文件复核），修复标记为 unsafe，未纳入本次改动。
2. 用户侧扩展兼容：`~/.pi/agent` 下依赖 pi-agent-core `/node` 子路径的扩展（典型 pi-subagents < 0.75.0）在 pi ≥ 1.0 下后台 runner 会失效。属用户环境面，Phase 4（Subagents 设置页）落地时在页面标注实际可用性；不在本仓代码范围。
3. `scripts/fetch-pi-binary.js` 中「产物含 `node_modules/`」的注释随本次升级修正——0.85.1 tarball 确实含该目录，1.0.4 起为 bun 自包含（实测无该目录）。

## 回滚路径

```bash
git checkout scripts/pi-version.json package.json bun.lock
bun install
bun run fetch:pi          # 重新落 0.85.1（归档缓存仍在 .cache/pi-binaries/）
./src-tauri/resources/pi/pi --version
```

## 变更文件清单

| 文件 | 变更 |
| --- | --- |
| `scripts/pi-version.json` | `0.85.1` → `1.0.4`；新增 6 平台 `sha256` 钉值 |
| `package.json` | devDependency `@earendil-works/pi-coding-agent` `0.85.1` → `1.0.4` |
| `bun.lock` | 依赖解析更新 |
| `tests/fixtures/pi-rpc/1.0.4/contract.json` | 新增契约 fixture（`--update` 生成，biome 格式化） |
| `scripts/fetch-pi-binary.js` | 过时布局注释修正（1 行） |

> devDependency 必须与内嵌版本同步：`extensions/oauth-login-smoke.test.ts` 断言「npm pin == 内嵌 pin」，漂移时**静默跳过**真实运行时断言；`tsconfig.json` 另把该包类型映射到 `src-tauri/resources/pi/dist/index.d.ts`（随 fetch 自动变为 1.0.4 类型）。
