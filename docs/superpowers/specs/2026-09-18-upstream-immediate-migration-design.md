# Upstream 可立即迁移项：子进程清扫、Git push、last-model、模型性能、UI 增补

**Status:** 设计定案，待实现。
**Date:** 2026-09-18（评审修订稿）
**Source:** upstream `picot` main 分支 `42e2a06..5e558fd`（PR #63–#66 相关子集），已逐 commit 核实。
**Baseline:** v3 `private/features-v3` HEAD `8df9efb`，工作树干净。文中行号仅为定位辅助，实现时以符号名为准——v3 前端正在重构（`public/ui/turn.js`、`turn-model.js`），行号会继续漂移。
**关联:** ACP 外部代理委派另立 spec（`2026-09-18-acp-external-agent-delegation-design.md`），其 M1 依赖本 spec 第 2 节。本 spec 不含 ACP、SSH 远程工作区。

## 1. 目标与顺序

把 upstream 一批自包含改进落地到 v3，按下述顺序实现，每项独立提交：

1. **子进程清扫**（纯后端，ACP spec 的前置依赖，与本轮前端重构无冲突）
2. **Git push**（后端 + git 面板）
3. **last-model**（新会话继承模型）
4. **模型目录缓存 + 健康检查并行化**
5. **助手消息响应时长**
6. **Composer 附件缩略图接入 lightbox**
7. **两处样式微调**（用户气泡收紧、「添加 provider」边框顺序）

**执行前提：已满足。** 工作树干净，领先 origin 30 个 commit。前端三项（5–7）建议等 turn/composer 重构落定后再动 `app.js`；4 项之前的都在扩展层或 Rust 层，不受影响。

## 2. 子进程清扫（child_supervision）

### 问题

pi 在 stdin EOF 时会退出，子进程通常随父进程而死。但 wedge 住的子进程永远读不到 EOF：upstream 曾发现一个孤儿子进程在 Picot 消失后仍以 100% CPU 空转九天。SIGKILL/崩溃时 Picot 的 teardown 完全不运行，spawn 时的注册表是唯一幸存的记录。

### 现状（关键：不要重造已有能力）

v3 已有 `src-tauri/src/process_tree.rs`，被 `pi_rpc_bridge.rs` 使用，已实现：

- Unix：`getpgid` 身份校验 + `kill(-pgid, SIGTERM)`，20×10ms 等待后升级 `SIGKILL`；终止前校验进程组身份未变。
- Windows：`windows_job::create_and_assign` kill-on-close job object。

`windows_child.rs` 只有 hide_console，**不涉及进程组**。因此本节**不新增进程组/job object 逻辑**，只补三件 v3 缺失的事。

### 设计

1. **spawn 时注册**：每个 pi 运行时把 `{ pid, workspace 路径, 启动时间 }` 写入应用数据目录下 `picot-runtimes/`；正常退出时删除对应条目。落盘点跟随现有 pi spawn 路径（`native_pi_manager.rs`）。
2. **启动清扫 `sweep_orphans()`**：`main` 启动时读注册表，凡不属于本进程的 pid 视为上一次被强杀的 Picot 遗留，用既有进程组终止路径杀掉后清空注册表。日志记录清理数量。
3. **信号兜底**：`RunEvent::Ready` 时安装 SIGTERM/SIGINT handler，走 `stop_all()` + 清注册表，覆盖不触发 `RunEvent::Exit` 的退出路径；`RunEvent::Exit` 上补 `clear_registry()`。
4. **Windows**：复用 `process_tree.rs` 的 job object，不重复实现。

**范围**：只覆盖 pi 运行时（`native_pi_manager.rs` 的 spawn/stop 路径）。terminal 与 git 子进程不纳入；若实现时发现同一条 kill 路径可零成本复用，单独提出再扩。

### 测试

- Rust 单测：注册表读写、`sweep_orphans` 只清本进程外的条目、路径解析拒绝越界（tempfile）。
- 手工验证：kill -9 Picot 后重启，确认遗留 pi 进程被杀。

## 3. Git push

### 现状

- `src-tauri/src/git_service.rs` 有 status/diff/log/stage/commit，无 push。可直接复用：`lock_for_write`（每 root 写槽）、写槽 `try_lock` 模式、`git_command`（已设 `GIT_TERMINAL_PROMPT=0`）、`git()` helper、`parse_porcelain_v2_z`。
- **Git 命令分发在 `src-tauri/src/main.rs`**（`"git_status" =>`、`"git_diff" =>`、`"git_turn_stats"` 等 match 臂，约 1700–1750 行）。`host_server.rs` 只持有 `GitService` 句柄（`set_git_service`），不参与分发。
- 前端 `public/git-panel.js`（面板）与 `public/git-client.js`（`GitClient` 类），无 push 入口。v3 的 git UI 拆为 git-panel / git-history-panel / git-diff-renderer 三个模块。

### 设计

**`git_service.rs` 新增 `push(&self, root: &Path) -> Result<GitPushOutcome, String>`**，参照 upstream 同名实现：

- `GitPushOutcome { remote, branch, set_upstream, output }`。`output` 是有上限（4 KB）的 stderr 摘录——git push 连成功时也把人类可读结果写 stderr。
- 无 upstream 配置时 push 到默认 remote 并加 `--set-upstream`。
- 错误码：`push_detached_head`、`push_no_remote`。
- 与 stage/unstage/discard/commit 共享 per-root 写槽；槽被占用立即返回 `busy`。
- 超时 120 秒（`PUSH_DEADLINE`），超时杀整个进程组。120 秒的理由：push 走网络，比 30 秒写槽 deadline 需要更多余量；但仍要有硬上限，因为本进程无法应答凭据提示，没有上限会把写槽永久占死。

**认证严格非交互**：Tauri 子进程无 TTY，任何凭据/passphrase 提示都会挂到超时。`git_command` 已设 `GIT_TERMINAL_PROMPT=0` 和 null stdin，push 补充 askpass 抑制与 `GIT_SSH_COMMAND` 的 BatchMode，缺凭据时立即以可读错误失败，而不是挂住面板。

**`main.rs` 的 git match 新增 `"push"` 臂**，返回 `git_push` 帧（含 outcome 或错误码）。

**capability/permission 检查**：v3 有 `src-tauri/capabilities/default.json` 与 `permissions/default.toml`，`bun run test` 含 Tauri capability validation。实现时确认新增的 host 命令是否需要登记（当前 default.json 无 git 条目，可能无需改动）——不确认就报「已通过」等于没验证。

**前端**：

- `git-panel.js` 增加 push 按钮（图标 `arrow-up`），`git-client.js` 增加 push 请求；结果区展示 stderr 摘录与「已设置 upstream」状态。
- **push 错误提示区**：工具栏 details 区在 `pushError` 非空时渲染 `git-panel-push-error` 段落——`role="alert"`、红色文本、自动换行。
- 错误码映射为本地化文案：`push_detached_head` → `git.pushDetachedHead`、`push_no_remote` → `git.pushNoRemote`、`busy` → `git.pushBusy`；其余字符串透传 git 的 stderr（已截断），空值回落 `git.pushFailed`。
- push 进行中（`pushInProgress`）与 detached HEAD（无 branch）时按钮禁用；重试前先清空上一次错误，避免 in-flight push 旁边挂着过期错误。
- i18n 四语言（`public/locales/{zh,en,ja,es}.json`，`"git"` 段）补 key。

### 测试

- `git_service.rs`：detached head 拒绝、无 remote 拒绝、outcome 序列化（沿用现有 Rust 测试风格）。
- `git-panel.test.js`：push 按钮触发请求、结果与错误渲染、busy 禁用。
- 真实 push 不做自动化（需远端凭据），以手工验证记录收尾。

## 4. last-model（新会话继承模型）

### 现状

- 模型选择逻辑在 `public/app.js` 与 `public/models/selection.js`（provider-scoped 匹配）。v3 无 `public/native/`（原生入口已在 `b27c5f4` 移除）。
- 新建空会话总是回落到 pi 内置默认模型，用户每次都要重选。

### 设计

**新模块 `public/models/last-model-store.js`**（约 57 行，参照 upstream 同名文件）：

- `getLastModel()` / `setLastModel(model)`，localStorage key `picot.composer.lastModel`，存 `{ provider, modelId }`。
- 所有读写 try/catch：storage 不可用时静默降级为 pi 默认，不得抛错影响会话加载。
- 键含 provider，沿用 v3 已落地的 provider-scoped 语义。

**接入 `public/app.js`（两处）**：

1. 手动切换模型成功后调用 `setLastModel(model)`。
2. 快照加载时：会话无消息且 pi 未带回模型（或与记录不一致）时，发 `set_model { provider, modelId }` 继承；有历史的会话沿用 pi 从 session record 恢复的模型，不发送。

**风险（必须遵守）**：v3 的 `set_model` / `set_thinking_level` 会重写 pi 的**全局**配置（`app.js` 内相关注释与 transcript restore 分支已说明：回放这些命令会改写全局，因此 restore 路径刻意不发）。继承路径只在空会话触发，否则会污染其他会话的 restore。

### 测试

- `last-model-store.test.js`：合法存取、非法输入忽略、storage 异常不抛。
- 接线测试：手动选择后写入；空会话发送继承 `set_model`；非空会话不发送。

## 5. 模型性能

### 5.1 模型目录缓存

`extensions/picot-config.ts` 的 `list_model_catalog` 每次调用都从零 `buildModelCatalog`，重复探测各 provider 的 auth/availability。前端调用点：`public/app.js`（`loadModelCatalog` / `filterModelsByCatalogVisibility` 处）与 `public/settings/models-page.js`。

**设计**：给 `buildModelCatalog` 加 3 秒短 TTL 缓存；凡是可能改变结果的写入路径都要失效缓存：

- `set_model_visibility`（`extensions/picot-config.ts` 的处理分支）
- 健康检查写入
- 每一处 `registry.refresh()` 调用点（当前 5 处：约 711、1071、1119、1209、1217 行——API key 变更、OAuth 登录/登出、配置编辑）

失效必须穷举写入点，这是本项的主要风险；遗漏任何一处会让 UI 显示过期 catalog。

### 5.2 健康检查并行化

`check_model_health` 在 `extensions/picot-config.ts` 中确认为串行：`const results = []; for (...) results.push(await runModelHealthCheck(...))`，N 个模型耗时 N × 单次延迟。改为 `Promise.all`（map 保序，结果聚合顺序不变）。

**注意**：upstream 同时改了 `/tui` 侧（不存在于 v3），只取 `check_model_health` 这一处。

### 5.3 模型可见性 opt-in —— 已定案 D1a（2026-09-20，已实现）

**决策**：可见性变为 opt-in——未设置过的模型默认**不出现**在 composer 选择器里，用户需在 Settings 里开启（列表头已有 per-provider 全选开关，不必逐个点）。理由：`available` 只表示 provider 配好了凭据（「能不能跑」），可见性才是用户的策展清单（「想不想看到」）；provider 配好 key 后其全部模型涌入下拉是噪音来源。

**语义**：`visible === true` 才可见。已改动的 7 处：

- `extensions/picot-config.ts`：`ModelPreferencesStore.isVisible()`、`set_model_visibility` 处理分支（`params.visible === true`，缺参不再误开）。
- `public/models/selection.js`：`filterModelsByCatalogVisibility` 的 `available && visible === true`。
- `public/settings/models-page.js`：4 处（健康检查按钮可用性、「已启用 N 个」计数 ×2、行内开关初值）。
- `public/app.js`：`filterConfiguredModels` 的异常分支。

**fail-closed 回退（与 upstream 一致）**：catalog 读不到（`!catalog.ok` 或桥调用抛错）时返回**空列表**，而不是「回退显示全部」。理由：读不到用户清单时把全部可用模型放回下拉，等于在最不可信的时刻取消用户的策展；宁可暂时为空，由下一次成功刷新重填。

**已知代价（接受）**：升级后现有安装的 composer 下拉会先空掉，需在 Settings 里开启所需模型；冷启动若遇到 registry 未就绪的瞬时窗口，下拉短暂为空并自愈。若要改回 fail-open，仅需 `selection.js` 与 `app.js` 两处 `return []` 改回 `return models`。

**验证**：`extensions/picot-config.test.ts`（默认隐藏 + 缺参不误开 + 显式 true 生效）、`public/models/selection.test.js`（默认隐藏、fail-closed）。

## 6. UI 增补

### 6.1 助手消息响应时长

**现状（已核实）**：流式渲染由 `public/app.js` 的 `message_update` 分支驱动（`const { assistantMessageEvent, message } = event`，`text_delta` / `thinking_delta` 累积进 `currentStreamingText` / `currentStreamingThinking`，元素由 `ensureStreamingAssistantElement` 创建）。`finalizeStreamingMessage` 全仓只有一处定义（`public/ui/message-renderer.js:431`）和一处调用（`public/app.js:3239`）。pi 事件不带时长，需要客户端计时。

**设计**：

- `formatDurationLabel(durationMs)`：`<60s` 显示 `"3.2s"`，超过显示 `"1m 05s"`；null/负数/非有限值返回空串——注意 `Number(null) === 0`，必须先判 null 再转数字，否则渲染假 `"0.0s"`。
- footer 在时间戳旁追加 `.message-duration` span（`title` 用 `messages.responseTime` i18n key）。
- 计时起点挂在首个 `text_delta`（或 `ensureStreamingAssistantElement` 创建元素处），终点在 `finalizeStreamingMessage` 的调用点（`app.js:3239`）传入时长。只有完整走到 finalize 的消息显示；中断、历史回放、切换会话不显示。
- `finalizeStreamingMessage(messageElement, usage = null, thinking = "", durationMs = null)`：第 4 参带默认值，既有调用不破坏。
- **实现前先确认 finalize 调用点数量**：v3 正在重构 turn（`public/ui/turn.js`、`turn-model.js`），若重构后新增了 finalize 路径，计时与传参必须一并覆盖，否则部分消息会静默丢失时长。

### 6.2 Composer 附件缩略图接入 lightbox

**现状**：v3 已有完整 lightbox 基建——`public/ui/image-lightbox.js` 的容器点击委托 + `.lightbox-image` class 机制，已挂在消息区（`app.js` 的 `initImageLightbox(messagesElement)`）；`public/composer-image-attachments.js` 创建缩略图（`.image-preview`）时未挂 class，附件图不可放大。

**设计**：

- `composer-image-attachments.js` 渲染缩略图时加 `.lightbox-image` class。
- 在附件预览容器上初始化 lightbox 委托（`initImageLightbox(previewContainer)`，内部 `dataset.lightboxWired` 防重复挂）。

### 6.3 纯样式微调（Dr. Lin 已确认迁入）

**用户气泡收紧**（upstream 301f2c0 + 432584a）：

- `public/style.css` 的 `.message.user .message-content`：`border-radius` 由 `var(--radius-lg)` 改为 `12px`（介于 md 与 lg 之间的定制值；upstream 带 `design-token-ignore` 注释，v3 需按 design check 的实际规则处理豁免）；`padding: var(--space-1) var(--space-2)`；`border-bottom-right-radius: 6px` 保留。

**「添加 provider」边框顺序修正**：

- `public/settings/settings-config.css` 的 `.models-provider-add`：`border-color: var(--accent)` 当前声明在 `border: 1px dashed var(--border)` 之前，被后者覆盖；把 `border-color` 挪到 `border` 之后，恢复 dashed 边框的 accent 色。

## 7. 排除项

- ACP 外部代理（另立 spec）。
- SSH 远程工作区、SSH host 管理（未选）。
- 会话路径查询缓存（`5900f7f` 混入项，价值低，YAGNI）。lightbox composer 预览已由 6.2 收编，不再排除。
- task failure alerts、贡献者头像。
- conv-nav 整条 rail 可点：v3 自己的 `public/ui/conversation-nav.js` 已是全 track 点击委托（`trackEl` click + `pointerTickIndex` 映射最近刻度），同一效果不同实现，无需迁移。
- `sanitize-markup.js` 抽取：v3 的 `_sanitizeMarkup` 内联在 `message-renderer.js` 且只有一个调用方，YAGNI；等 ACP spec M2 出现第二个消费方再抽。
- slash 菜单 agent 选择器布局：依赖 composer-agent-menu，归 ACP spec 的 M2。
- 侧边栏折叠箭头 SVG 14px：v3 sidebar 无对应结构，不适用。

## 8. 验证

每项落地后运行对应命令：

- 改 `extensions/`（5.1、5.2）：`bun run build:extensions` + `bun run check`。
- 改前端（3、4、6）：`bun run check`，先跑聚焦测试再跑相关套件。
- 改 Rust（2、3）：`bun run check:rust`（cargo check + clippy + fmt + 单测）。
- 收尾：`bun run test` 全量（含 Tauri capability validation）。

完成后 `ARCHITECTURE.md` 相应小节需同步：Git 集成（push 契约）、运行时生命周期（子进程注册表与启动清扫）。
