<!-- ABOUTME: 设计规格目录索引与状态总览。 -->
<!-- ABOUTME: 按实现状态分类：implemented / in-progress / not-started / superseded / process-evidence / prototypes / audits。 -->

# 设计规格目录

`docs/superpowers/specs/` 下的所有 `.md` 与 `.html` 文件按实现状态分类存放。
原始扁平目录（85 个文件）已拆为 6 个子目录，便于按状态检索。

## 子目录

| 子目录 | 含义 | 文件数 |
| --- | --- | --- |
| [`implemented/`](implemented/) | 设计已批准 + 代码已落地 + 测试已通过 | 48 |
| [`in-progress/`](in-progress/) | 设计已批准实施未完（部分代码已合入或 working tree 有进展） | 1 |
| [`not-started/`](not-started/) | 设计草案或待评审，未实施 | 7 |
| [`audits/`](../../audits/) | 审计记录（非设计 spec，不引入实现） | 1 |
| [`superseded/`](superseded/) | 已被更新的 spec 取代，保留作历史参考 | 4 |
| [`process-evidence/`](process-evidence/) | Native Runtime 迁移过程的证据 / CP 评审 / 闭环记录（不是设计规格） | 24 |
| [`prototypes/`](prototypes/) | 视觉原型（HTML），仅评审用，不进生产 | 3 |

## 分类原则

1. **状态字段为第一信号**——spec 文件首部的 `**Status:**` / `## Status` / `**状态:**`。
2. **代码/工作树为第二信号**——若 status 与实际代码不一致（如 spec 写"未实施"但代码已落地），以代码为准，并在备注列说明偏差。
3. **spec 显式标注 SUPERSEDED/Superseded → superseded/**。
4. **不是设计规格的过程文档**（CP 评审、smoke 证据、review remediation、checkpoint、evidence audit）一律放 `process-evidence/`。

## 完整状态表

| 状态 | 文件 | 备注 |
| --- | --- | --- |
| ✅ implemented | [2026-07-08-i18n](implemented/2026-07-08-i18n-design.md) | i18n.js 引擎（267 行，10 export API）+ 4 locale（en/zh/ja/es 各 1322 行，40 namespace 全 parity）；§4.13 cost iframe + postMessage 与 §4.14 bootstrap.html 因架构演进（cost 改 web component、bootstrap 简化为 entry）已 obsoleted |
| ✅ implemented | [2026-07-12-company-extensions](implemented/2026-07-12-company-extensions-design.md) | Corp fork 实现（`com.palandata.picot`）；public repo 不含（schema v6 不创建 `company_account_profiles` / `gitlab_bindings` / `company_install_ledger` 三表） |
| ✅ implemented | [2026-07-12-file-preview-editor](implemented/2026-07-12-file-preview-editor-design.md) | File tree 集成预览/编辑，commit `b149091` |
| ✅ implemented | [2026-07-14-pinned-projects-sidebar](implemented/2026-07-14-pinned-projects-sidebar-design.md) | workspace 维度 Pin 已落地（07-25 sidebar spec 承接，commit `567d82e`/`d80399c`/`5f8d0d6`）；实现偏差：仅 workspace Pin，session Pin 已于 08-25 移除 |
| ✅ implemented | [2026-07-15-quick-and-side-chat](implemented/2026-07-15-quick-and-side-chat-design.md) | QuickChatDialog + SideChatManager，commit `f32c494`/`2dd74f4`；spec 文本过期但代码完整 |
| ✅ implemented | [2026-07-21-terminal-panel](implemented/2026-07-21-terminal-panel-design.md) | 6 个 JS 模块 + 5 个 Rust 模块（terminal_manager/output/profiles/registry/state_store）；spec 自标 "Tasks 1-6 已实施"；xterm addon 增强落地（commit `018d818`） |
| ✅ implemented | [2026-07-24-cjk-font-bundling](implemented/2026-07-24-cjk-font-bundling-design.md) | LXGW WenKai GB2312 子集，commit `5564e44`；后 c0f64ba 升级 Fira Code |
| ✅ implemented | [2026-07-24-skills-page](implemented/2026-07-24-skills-page-design.md) | Skills 三标签页，commit `ccdf1b8`/`c584b68` |
| ✅ implemented | [2026-07-25-sidebar-titlebar-focus-archive](implemented/2026-07-25-sidebar-titlebar-focus-archive-design.md) | sidebar 重构 + Focus + 永久删除，commit `a01f137`/`f8e94a5` |
| ✅ implemented | [2026-07-26-git-panel](implemented/2026-07-26-git-panel-design.md) | GitPanel + GitHistoryPanel + git_pi_runner，commit `7727e9a`/`25efff1`；spec 文本为"草案"但代码完整 |
| ✅ implemented | [2026-07-26-session-rename](implemented/2026-07-26-session-rename-design.md) | Pi TUI 同持久化模型，commit `1540453` |
| ✅ implemented | [2026-07-27-package-skills-tab](implemented/2026-07-27-package-skills-tab-design.md) | package-skill-inventory.ts |
| ✅ implemented | [2026-07-27-skill-link-installation](implemented/2026-07-27-skill-link-installation-design.md) | skills-install-tab.js |
| ✅ implemented | [2026-08-10-message-toolbar](implemented/2026-08-10-message-toolbar-design.md) | 复制/时间戳/用量 tool card，commit `0eca134` 起的连续修复 |
| ✅ implemented | [2026-08-16-oauth-model-auth](implemented/2026-08-16-oauth-model-auth-design.md) | Phase 0 capability spike 完成；Phase 1 Codex device-code 落地（commit `6f2f5a0` + `be6ea93`）；oauth-gateway.js + oauth_manager.rs + 登出（`95e7e0d`）；host_server.rs 集成 OAuthManager 生命周期 |
| ✅ implemented | [2026-08-19-settings-extensions-package-manager](implemented/2026-08-19-settings-extensions-package-manager-design.md) | Settings → Extensions，commit `f9a7ea3`/`899d488` |
| ✅ implemented | [2026-08-21-info-panel](implemented/2026-08-21-info-panel-design.md) | 右栏 info tab，commit `5dd2bb9`/`c71ec15` |
| ✅ implemented | [2026-08-24-git-history-panel](implemented/2026-08-24-git-history-panel-design.md) | git-history-panel.js，commit `7727e9a` |
| ✅ implemented | [2026-08-26-workspace-registry](implemented/2026-08-26-workspace-registry-design.md) | 注册制 + SQLite 数据源，commit `7acbc0a` |
| ✅ implemented | [2026-08-27-native-runtime-migration](implemented/2026-08-27-native-runtime-migration-design.md) | D1–D10 拍板；P1–P8 大部分完成；Gate D / D10 release exit 待人工件 |
| ✅ implemented | [2026-09-04-appearance-settings-page](implemented/2026-09-04-appearance-settings-page-design.md) | theme-grid + Preview + 字号五档，commit `778625b` |
| ✅ implemented | [2026-09-04-terminal-display-settings](implemented/2026-09-04-terminal-display-settings-design.md) | 终端字号/scrollback/WebGL，commit `10c0da1` |
| ✅ implemented | [2026-09-13-advisor-extension-settings](implemented/2026-09-13-advisor-extension-settings-design.md) | advisor host ops，commit `899d488`；landing 09-21 |
| ✅ implemented | [2026-09-13-ask-user-question-rich-renderer](implemented/2026-09-13-ask-user-question-rich-renderer-design.md) | questionnaire-card.js，commit `34c14f1` |
| ✅ implemented | [2026-09-13-fff-extension-settings](implemented/2026-09-13-fff-extension-settings-design.md) | fff host ops，commit `899d488` |
| ✅ implemented | [2026-09-13-mcp-settings-page](implemented/2026-09-13-mcp-settings-page-design.md) | 6 层对齐 mcp-page，commit `5548f03` |
| ✅ implemented | [2026-09-13-widget-mirror-registry](implemented/2026-09-13-widget-mirror-registry-design.md) | runtime widget mirrors，commit `606ad17` |
| ✅ implemented | [2026-09-14-landing-page](implemented/2026-09-14-landing-page-design.md) | TemporaryKind::Landing，commit `a19aa5c` |
| ✅ implemented | [2026-09-16-cache-optimizer-extension-settings](implemented/2026-09-16-cache-optimizer-extension-settings-design.md) | cache_optimizer_config.rs + renderCacheOptimizerSettings |
| ✅ implemented | [2026-09-16-chat-window-turn-ia-scroll-and-type-scale](implemented/2026-09-16-chat-window-turn-ia-scroll-and-type-scale-design.md) | turn 模型 + history 折叠，commit `cc1ab26` |
| ✅ implemented | [2026-09-16-composer-interaction](implemented/2026-09-16-composer-interaction-design.md) | composer C1–C5，commit `090e5ad`/`adcbd32` |
| ✅ implemented | [2026-09-16-extension-settings-rollout](implemented/2026-09-16-extension-settings-rollout-inventory.md) | 14 项扩展设置全部落地（advisor / fff / rpiv-todo / rpiv-ask-user-question / ponytail / vcc / goal / caveman / cache-optimizer / lens / plan-mode / safety-guard / web-access / datarx-safety-guard-pi） |
| ✅ implemented | [2026-09-16-goal-extension-settings](implemented/2026-09-16-goal-extension-settings-design.md) | goal_config.rs + renderGoalSettings |
| ✅ implemented | [2026-09-16-lens-extension-settings](implemented/2026-09-16-lens-extension-settings-design.md) | lens_config.rs + renderLensSettings |
| ✅ implemented | [2026-09-16-plan-mode-extension-settings](implemented/2026-09-16-plan-mode-extension-settings-design.md) | plan-mode renderer（bridge 通道，model picker 需 in-process modelRegistry） |
| ✅ implemented | [2026-09-16-ponytail-extension-settings](implemented/2026-09-16-ponytail-extension-settings-design.md) | ponytail_config.rs + renderPonytailSettings |
| ✅ implemented | [2026-09-16-rpiv-ask-user-question-extension-settings](implemented/2026-09-16-rpiv-ask-user-question-extension-settings-design.md) | rpiv_config::get_askuser_config + renderAskUserSettings |
| ✅ implemented | [2026-09-16-rpiv-todo-extension-settings](implemented/2026-09-16-rpiv-todo-extension-settings-design.md) | rpiv_config::get_todo_config + renderTodoSettings |
| ✅ implemented | [2026-09-16-safety-guard-extension-settings](implemented/2026-09-16-safety-guard-extension-settings-design.md) | renderSafetyGuardSettings（package-extension-settings.js:1571）+ bridge ops `safetyGuard.config.{get,set}`；09-21 fork 后被 [datarx-safety-guard-pi](implemented/2026-09-21-datarx-safety-guard-pi-design.md) 取代，renderer gate 重定向到 fork |
| ✅ implemented | [2026-09-16-vcc-extension-settings](implemented/2026-09-16-vcc-extension-settings-design.md) | vcc_config.rs + renderVccSettings |
| ✅ implemented | [2026-09-16-web-access-extension-settings](implemented/2026-09-16-web-access-extension-settings-design.md) | web-access host ops + renderWebAccessSettings |
| ✅ implemented | [2026-09-18-cross-workspace-runtime-lifecycle-divergence](implemented/2026-09-18-cross-workspace-runtime-lifecycle-divergence.md) | 跨工作区订阅运行时事件流，旧代 runtime 留活（commit `edc3721`）；host_server.rs 双重实时校验 + find_existing_runtime_for_prepare+rebind 复用 |
| ✅ implemented | [2026-09-18-landing-bridge-runtime](implemented/2026-09-18-landing-bridge-runtime-design.md) | landing-config-runtime.js，working tree |
| ✅ implemented | [2026-09-18-upstream-immediate-migration](implemented/2026-09-18-upstream-immediate-migration-design.md) | 5 项全落地：子进程清扫 `7710a78` + Git push `25efff1` + last-model 继承 `2d63dcf` + response time `744d99a` + model visibility opt-in `b63347a` |
| ✅ implemented | [2026-09-19-file-mention-paths](implemented/2026-09-19-file-mention-paths-design.md) | spec §末尾自标"两步均已实施并通过验证"（2026-09-19）；public/ui/at-file-mention.js 470 行 + test 83 行 |
| ✅ implemented | [2026-09-19-steering-and-queue-ux](implemented/2026-09-19-steering-and-queue-ux-design.md) | Enter=steer + Esc 1s，commit `adcbd32`/`a62a97a` |
| ✅ implemented | [2026-09-19-turn-files-card](implemented/2026-09-19-turn-files-card-design.md) | public/ui/turn-files-card.js 168 行 + test 209 行；spec 标"待复核"指 spec 文本未定稿而非功能缺失 |
| ✅ implemented | [2026-09-21-datarx-safety-guard-pi](implemented/2026-09-21-datarx-safety-guard-pi-design.md) | safety-guard-dialog.js，working tree（取代 09-16 safety-guard） |
| 🚧 in-progress | [2026-09-18-subagent-display](in-progress/2026-09-18-subagent-display-design.md) | 设计定案；widget + tool card 未实现 |
| 📋 not-started | [2026-09-03-picot-external-terminal](not-started/2026-09-03-picot-external-terminal-design.md) | Path 2 拍板后暂停 |
| 📋 not-started | [2026-09-17-anydoc-office-preview](not-started/2026-09-17-anydoc-office-preview-design.md) | 设计已批准，替换 MarkItDown；实施未启动 |
| 📋 not-started | [2026-09-18-acp-external-agent-delegation](not-started/2026-09-18-acp-external-agent-delegation-design.md) | 设计草案，待 Dr. Lin 拍板 |
| 📋 not-started | [2026-09-20-history-scroll-auto-load](not-started/2026-09-20-history-scroll-auto-load-design.md) | 参照 Paseo 滚动触发状态机 + gate；Draft 待 Dr. Lin 评审 |
| 📋 not-started | [2026-09-20-persistent-daemon-relay](not-started/2026-09-20-persistent-daemon-relay-design.md) | 持久 daemon + relay 接入；Draft 待拍板（daemon 形态 + 公司服务器部署清单待定） |
| 📋 not-started | [2026-09-20-session-resident-views](not-started/2026-09-20-session-resident-views-design.md) | 收窄为前端视图层（host 常驻已实现）；Draft 待 Dr. Lin 评审 |
| 📋 not-started | [2026-09-20-session-scan-bounded-io](not-started/2026-09-20-session-scan-bounded-io-design.md) | head/tail 双窗口扫描；Draft 待 Dr. Lin 评审 |
| ⛔ superseded | [2026-07-25-at-file-mention](superseded/2026-07-25-at-file-mention-design.md) | 由 [2026-09-19-file-mention-paths](implemented/2026-09-19-file-mention-paths-design.md) 扩展并部分取代 |
| ⛔ superseded | [2026-07-26-markitdown-office-email-preview](superseded/2026-07-26-markitdown-office-email-preview-design.md) | 由 [2026-09-17-anydoc-office-preview](not-started/2026-09-17-anydoc-office-preview-design.md) 取代 |
| ⛔ superseded | [2026-07-27-claude-skills-discovery](superseded/2026-07-27-claude-skills-discovery-design.md) | 由 [2026-08-07-composer-skill-discovery-and-execution-fixes](superseded/2026-08-07-composer-skill-discovery-and-execution-fixes.md) 取代 |
| ⛔ superseded | [2026-08-07-composer-skill-discovery-and-execution-fixes.md](superseded/2026-08-07-composer-skill-discovery-and-execution-fixes.md) | （已被新 spec 取代） |


## 相关参考

- 实施计划：[`../plans/`](../plans/)
- 审计记录：[`../audits/`](../audits/)
- 主架构：[`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- Agent 指南：[`../../../AGENTS.md`](../../../AGENTS.md)
