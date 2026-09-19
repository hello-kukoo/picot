# Upstream 可立即迁移项：Git push、last-model、子进程清扫、模型性能、UI 增补

**Status:** 设计定案，待实现。2026-09-18 第二轮评审后修订：§5.3 取 D1b（不动可见性语义）、§6.1 取格式 A（复用 `formatTurnDuration`）、`>1h` 归一已随本批落地。
**Date:** 2026-09-18
**Source:** upstream `picot` main 分支 `42e2a06..5e558fd`（PR #63–#66 相关子集），已逐 commit 核实；第二轮修订同时按 v3 工作树实况复核。
**关联:** ACP 外部代理委派另立 spec（`2026-09-18-acp-external-agent-delegation-design.md`）；本 spec 不含 ACP、SSH 远程工作区。

## 1. 目标

把 upstream 一批自包含改进落地到 v3：

1. Git 面板支持 push。
2. 新会话跨 app 重启继承上次手动选择的模型。
3. Picot 被强杀后遗留的 pi 运行时子进程可被清扫。
4. 模型目录不再每次加载重新探测 provider。
5. 助手消息 footer 显示响应时长。
6. Composer 附件缩略图接入 lightbox。
7. 用户气泡收紧。

七项互相独立，可按任意顺序实现，每项独立提交。

**执行前提：** 2026-09-18 晚实况为 55 个未提交路径（`git status --porcelain`），含 `public/app.js`、`public/ui/turn.js`、`public/ui/message-renderer.js`、`public/style.css`、`public/settings/settings-config.css`、`public/composer-image-attachments.js`、`public/locales/*.json`，与 §2/§3/§6 全面重叠；在途的跨工作区 runtime lifecycle 改动（见 `2026-09-18-cross-workspace-runtime-lifecycle-divergence.md`）落在 `main.rs` 与 `native_pi_manager.rs`，与 §4 重叠。实现本 spec 前必须先提交或处置这批在途工作，避免两个批次混进同一 commit 和同一段代码。

## 2. Git push

### 现状

- `src-tauri/src/git_service.rs` 有 status/diff/log/stage/commit，无 push。
- Git 命令由 `main.rs` 的 `dispatch_git_host_operation`（`main.rs:1683`）分发，入口是 `main.rs:2244` 的 `command.starts_with("git_")` 分支；`host_server.rs` 只在重连时回放 detached commit 的 `git_commit_result`（`host_server.rs:1540`）。v3 无 upstream 的 `host_git.rs`。
- 前端 `public/git-panel.js` + `public/git-client.js`，无 push 入口；工具栏 details 区已存在（`git-panel.js:480`），push 错误提示有落点。

### 设计

**`git_service.rs` 新增 `push(&self, root: &Path) -> Result<GitPushOutcome, String>`**，参照 upstream 同名实现：

- `GitPushOutcome { remote, branch, set_upstream, output }`。`output` 是有上限（4 KB）的 stderr 摘录——git push 连成功时也把人类可读结果写 stderr。
- 无 upstream 配置时 push 到默认 remote 并加 `--set-upstream`。
- 错误码：`push_detached_head`、`push_no_remote`。
- 与 stage/unstage/discard/commit 共享 per-root 写槽，push 不会和 index 变更竞态；槽被占用立即返回 `busy`。
- 超时 120 秒（`PUSH_DEADLINE`），超时杀整个进程组。120 秒的理由：push 走网络，比 30 秒写槽 deadline 需要更多余量；但仍要有硬上限，因为本进程无法应答凭据提示，没有上限会把写槽永久占死。

**认证严格非交互**：Tauri 子进程无 TTY，任何凭据/passphrase 提示都会挂到超时。`git_command` 已设 `GIT_TERMINAL_PROMPT=0` 和 null stdin，push 补充 askpass 抑制与 `GIT_SSH_COMMAND` 的 BatchMode，缺凭据时立即以可读错误失败，而不是挂住面板。

**`main.rs`** 在 `dispatch_git_host_operation` 新增 `"push"` 分支。push 走网络，与 upstream 一致拆两帧：`git_push_started` 同步 ack（在 `spawn_blocking` 之前返回），随后 `git_push_result` 事件带 `status: "succeeded" | "failed"`，成功时含 `remote` / `branch` / `setUpstream` / `output`。前端的 `pushInProgress` 由 started 置位、result 清位；合并成单帧会让按钮在整个 push 期间没有反馈。这与既有 `git_commit_started` / `git_commit_result` 同构（`main.rs:1983`）。

**前端**：`git-panel.js` 增加 push 按钮；`git-client.js` 增加 push 请求；结果区展示 stderr 摘录与「已设置 upstream」状态。i18n 四语言（zh/en/ja/es）补 6 个 key：`git.push`、`git.pushing`（按钮）、`git.pushDetachedHead`、`git.pushNoRemote`、`git.pushBusy`、`git.pushFailed`。

**push 错误提示区**（参照 upstream git-panel 实现）：

- 工具栏 details 区在 `pushError` 非空时渲染 `git-panel-push-error` 段落：`role="alert"`、红色文本、自动换行。
- 错误码映射为本地化文案：`push_detached_head` → `git.pushDetachedHead`、`push_no_remote` → `git.pushNoRemote`、`busy` → `git.pushBusy`；其余字符串透传 git 的 stderr（已截断），空值回落 `git.pushFailed`。
- push 进行中（`pushInProgress`）与 detached HEAD（`!snapshot.branch`）时按钮禁用；重试前先清空上一次错误，避免 in-flight push 旁边挂着过期错误。

### 测试

- `git_service.rs`：detached head 拒绝、无 remote 拒绝、outcome 序列化（沿用现有 Rust 测试风格）。
- `git-panel.test.js`：push 按钮触发请求、结果与错误渲染。
- 真实 push 行为不做自动化（需远端凭据），以手工验证记录收尾。

## 3. last-model（新会话继承模型）

### 现状

- v3 无 `public/native/`；模型选择逻辑在 `public/app.js`（`set_model` 调用见 3866、4187、4804 行）与 `public/models/selection.js`。
- v3 已按 session 持久化 `SessionUiProfile{provider, modelId, thinkingLevel}`（`src-tauri/src/session_ui_profile_store.rs`，经 `session_ui_profile_load` / `_save` 读写）。`app.js:4740` 的 `applySessionUiProfile` 对无 profile 的会话执行 `snapshotReportedProfile(currentModelProvider, currentModelId)`，而这两个变量在手动 `set_model` 成功后即更新（`app.js:4812`）。所以**单次运行内**新会话已经继承上次选择；回落 pi 内置默认只发生在**跨 app 重启**之后，且仅限重启前未被 snapshot 过的会话。本项补的是这条路。

### 设计

**新模块 `public/models/last-model-store.js`**（约 57 行，参照 upstream 同名文件）：

- `getLastModel()` / `setLastModel(model)`，localStorage key `picot.composer.lastModel`，存 `{ provider, modelId }`。
- 所有读写 try/catch：storage 不可用时静默降级为 pi 默认，不得抛错影响会话加载。
- 依 v3 上轮已迁入的 provider-scoped 语义，键含 provider。

**接入 `public/app.js`（两处）**：

1. 手动切换模型成功后调用 `setLastModel(model)`。
2. 快照加载时：会话无消息且 pi 未带回模型（或与记录不一致）时，发 `set_model { provider, modelId }` 继承；有历史的会话沿用 pi 从 session record 恢复的模型，不发送。

两个时序约束：

- 继承必须发生在 `applySessionUiProfile` 内 `loadProfile()` 返回 null 之后、`snapshotReportedProfile(reported)` 之前。否则 snapshot 会立刻把当前值写成该会话的显式 profile，localStorage 记录与实际状态分叉。
- 继承前先确认目标模型在当前 `availableModels` 中可用（沿用 `hasLoadedAvailableModels` 守卫）。pi 对未认证 provider 的 `set_model` 会返回失败或 `false`，此时保留 pi 默认并在 console 记录，不要把会话切到一个用不了的模型。

v3 的 `set_model` 会重写 pi 全局默认（见 app.js 4728–4789 注释），继承路径必须只在空会话触发，避免污染其他会话的 restore 行为。

### 测试

- `last-model-store.test.js`：合法存取、非法输入忽略、storage 异常不抛。
- `app.js` 接线测试：手动选择后写入；空会话发送继承 set_model；非空会话不发送。

## 4. 子进程清扫（child_supervision）

### 问题

pi 在 stdin EOF 时会退出，子进程通常随父进程而死。但 wedge 住的子进程永远读不到 EOF：upstream 曾发现一个孤儿子进程在 Picot 消失后仍以 100% CPU 空转九天。SIGKILL/崩溃时 Picot 的 teardown 代码完全不运行，spawn 时的注册表是唯一幸存的记录。

### 现状

- 进程树已受管：spawn 经 `configure_child_process`（`native_pi_manager.rs:1610-1615`，调用点 `native_pi_manager.rs:338`）做 `setpgid(0,0)`；`pi_rpc_bridge.rs:75` 再以 `ProcessTree::attach` 接管该子进程。`process_tree.rs` 持有 unix pgid 与 Windows kill-on-close job object，terminate 前校验 `getpgid(pid) == pgid`，先 SIGTERM（20×10ms）再 SIGKILL。`windows_child.rs` 只管隐藏控制台，不是进程树归属地。
- 真正缺三件：spawn 时落盘的注册表、启动清扫、信号兜底。

### 设计

新增 `src-tauri/src/child_supervision.rs`，参照 upstream：

1. **spawn 时注册**：写入 `~/.pi/picot-runtimes/<supervisor_pid>.json`，条目为 `{ pid, started_at }`，`started_at` 取自 `ps -o lstart=`；退出时移除自身条目，条目清空则删文件。workspace 路径不入注册表——清扫只需要 pid 身份，写路径只会扩大误杀面。
2. **启动清扫 `sweep_orphans()`**：main 启动时遍历注册表目录，逐条判定。三条守卫缺一不可：
   - 该注册表的 `supervisor_pid` 仍是活进程 → 跳过（另一个 Picot 实例仍拥有这些 runtime）；
   - 条目 pid 已死 → 跳过；
   - 条目的 `started_at` 与当前同名 pid 的 `lstart` 不一致 → 跳过（重启或 pid wrap 后该 pid 属于别的进程，杀错比漏杀更糟）。
   全部通过才杀：Unix `killpg(-pid, SIGKILL)` 加 `kill(pid, SIGKILL)`，随后删除该注册表文件。
3. **信号兜底**：`RunEvent::Ready` 时安装 SIGTERM / SIGINT / SIGHUP handler，走 `stop_all()` + 清注册表，覆盖不触发 `RunEvent::Exit` 的退出路径（`tauri dev` 的 Ctrl-C、登出/关机、终端关闭）。
4. **Windows**：kill-on-close job object 已由 `process_tree.rs` 提供，不重复实现，也不搬到 `windows_child.rs`。

**范围**：本 spec 只覆盖 pi 运行时（`native_pi_manager.rs` 的 spawn/stop 路径与 `pi_rpc_bridge.rs` 的 `ProcessTree`）。terminal 走自己的 `terminal_manager.rs:684/1099 kill_process_tree`，git 子进程由 `git_command` 独立 `setpgid`，两者不纳入；若实现时发现同一条 kill 路径可零成本复用，单独提出再扩。

### 测试

- Rust 单测（把存活探测与 kill 注入成回调，测试里不真杀进程）：注册表读写、清空即删文件；`sweep_orphans` 跳过 supervisor 仍存活的注册表；跳过 `started_at` 不匹配的条目；只杀全部守卫通过的条目；非 `.json` 文件不处理（沿用 upstream 测试思路，用 tempfile）。
- 手工验证：kill -9 Picot 后重启，确认遗留 pi 进程被杀。

## 5. 模型性能

### 5.1 模型目录缓存

`extensions/picot-config.ts` 的 `list_model_catalog` 每次调用都从零 `buildModelCatalog`，重复探测各 provider 的 auth/availability——每次切会话或打开 Settings > Models 都触发一次。

**前端已缓存**：dropdown 侧有 `app.js:4120 hasLoadedAvailableModels`，`get_available_models` 只在未加载时发一次（`app.js:4161`）。本项只补后端。

**设计**：给 `buildModelCatalog` 加 3 秒短 TTL 缓存；凡是可能改变结果的写入路径都要失效缓存——`set_model_visibility`（`picot-config.ts:1160`）、健康检查写入，以及全部 5 处 `registry.refresh()` 调用点：`picot-config.ts:711`、`1071`、`1119`、`1209`、`1217`。

失效必须穷举写入点，这是本项的主要风险；遗漏任何一处会让 UI 显示过期 catalog。

### 5.2 健康检查并行化

`check_model_health` 目前 for 循环逐个 `await runModelHealthCheck`，N 个模型耗时 N × 单次延迟。改为 `Promise.all`。结果聚合顺序不受影响（map 保序）。

### 5.3 模型可见性 opt-in —— 已拍板：D1b（本次不动语义）

upstream 把可见性语义从「默认可见、显式才隐藏」反转为「默认不可见、显式才显示」（`isVisible` 由 `!== false` 改 `=== true`，commit `e4add1f`）。动机：配了 API key 的 provider 下所有模型都涌入 composer，噪音大。

**决定：本次只迁 5.1 的缓存与 5.2 的并行化，不动可见性语义。** 理由与代价记录如下，供日后单独决策：

- 「现有用户从未显式设置过任何可见性标记」不成立。本机 `~/.pi/agent/picot-models.json` 有 691 条 visibility 记录（21 true / 670 false）；打开过 Settings > Models 的用户都有记录。
- 反转后的可见集合等于显式 `true` 的并集。本机当前 catalog（`~/.pi/agent/models.json` 的 26 个模型）中 8 个 true、15 个显式 false、3 个无记录，后者会消失；此后每个新增模型也静默隐藏，直到用户去 Settings 勾选。
- prefs 文件全空（首次安装、从未进过 Models 页）时，反转后可见模型数为 0，composer 空到用户手动开启为止。
- 这不是两行改动：谓词出现在 2 处后端（`picot-config.ts:374`、`1164`）与 5 处前端（`models/selection.js:27`、`settings/models-page.js:548`、`635`、`741`、`774`），前后端必须同时翻，否则 composer 与 Models 页各说一套；`models-page.js:548` 还决定「检查健康」按钮的禁用态。
- 若日后做 D1a，必须配一次性 seed：升级时把当前 available 且无记录的模型写入 `visibility: true`，此后新模型仍 opt-in。seed 只消除第一类悬崖，不改变「新模型静默不出现」这一长期成本，而那才是需要拍的产品取舍。

## 6. UI 增补（2026-09-18 第二轮核对补充）

### 6.1 助手消息响应时长

**现状**：`message-renderer.js` 的 `finalizeStreamingMessage`（`message-renderer.js:431`）只渲染时间戳；pi 事件不带时长，需要客户端计时。v3 没有 `public/native/`，流式状态内联在 `app.js`（`currentStreamingElement` / `currentStreamingThinking`，事件分支见 `app.js:2597` / `2612` / `2615`）。时长格式化已有 `formatTurnDuration`（`public/ui/turn-model.js:84`），`turn.js:86` 已用它渲染每条 turn 的完成标签（i18n `messages.turnWorkedFor`）。

**设计**：

- **复用 `formatTurnDuration`，不新增 formatter**（已拍板：格式 A）。同一 transcript 里 turn 标签与消息 footer 必须是同一套写法。upstream 的 `formatDurationLabel` 另起小数格式，且其 `≥60s` 分支先取小数余数再取整，会把 119.6s 渲染成 `1m 60s`，不移植。
- `formatTurnDuration` 已随本批归一 `>1h`：输出 `1h 00m 00s`（原为 `60m 00s`）。实现保持「先四舍五入到整秒，再拆单位」，避免 59.6s 的余数进位成 `60s`。
- footer 在时间戳旁追加 `.message-duration` span（`title` 用 `messages.responseTime` i18n key，四语言补齐）。
- 计时挂点在 `app.js`：首个 `message_update` 记 start，`message_end` 算时长，`app.js:3156` 调 `finalizeStreamingMessage` 时传入。只有完整收到 `message_end` 的助手消息显示；中断/重渲染不显示。
- `finalizeStreamingMessage` 签名追加第 4 参 `durationMs = null`，默认值保证既有调用不破坏。
- 判空必须先判 `null` 再转数字：`Number(null) === 0` 会渲染出假的 `0s`。该守卫已在 `formatTurnDuration` 内，调用点不要绕过。

**测试**：`turn-model.test.js` 已覆盖 `0s` / `12s` / `1m 04s` / `1h 00m 00s` 与非法输入；`message-renderer.test.js` 补 footer span 的有/无时长两例；`app.js` 接线测试确认中断路径不显示时长。

### 6.2 Composer 附件缩略图接入 lightbox

**现状**：v3 的 lightbox 用容器点击委托，`dataset.lightboxWired` 防重复挂（`image-lightbox.js:76`），已挂在消息区（`app.js:664`）。但它匹配的是 `img.message-image, img.inline-image`（`image-lightbox.js:81`），**没有** `.lightbox-image`。`composer-image-attachments.js` 的缩略图（`composer-image-attachments.js:132`）既不带 class，也不在选择器内，所以附件图点不开。

**设计**（三处缺一不可）：

- `image-lightbox.js:81` 选择器追加 `, img.lightbox-image`。只给缩略图加 class 而不改选择器，点击依然不触发。
- `composer-image-attachments.js` 渲染缩略图时给 `img` 加 `lightbox-image` class。
- 在附件预览容器 `imagePreviews` 上初始化委托（`initImageLightbox(imagePreviews)`）。容器由 `renderPreviews()` 内的 `replaceChildren()` 清空而非替换，委托因此跨重渲染存活；移除按钮是 `img` 的兄弟节点，不会命中委托。

### 6.3 用户气泡收紧（Dr. Lin 已确认迁入）

- `public/style.css` `.message.user .message-content`（`style.css:4130`）：`border-radius` 由 `var(--radius-lg)` 改为 `12px`；加 `padding: var(--space-1) var(--space-2)`；`border-bottom-right-radius: 6px` 保留。该规则当前没有 `padding` 声明，先核出现值再改。
- `12px` 不在 design check 的 radius token 集合内（`scripts/check-design-css.mjs:50` 只有 4/6/10/16/24/999），必须写成同行或上一行的 `/* design-token-ignore: 收紧用户气泡圆角，取自 upstream 301f2c0 */`。豁免机制已确认存在（同脚本 `103`、`171`）。

**已从本 spec 删除的原第 7 项**：「添加 provider」边框顺序。复核 v3 实况后不存在该缺陷——`public/settings/settings-config.css:127-139` 是 `border: 1px dashed var(--border)` 配 `:hover { border-color: var(--accent) }`，没有「`border-color` 在前被 `border` 覆盖」的问题。不迁。

## 7. 排除项

- ACP 外部代理（另立 spec）。
- SSH 远程工作区、SSH host 管理（未选）。
- 会话路径查询缓存（`5900f7f` 的 `host_data.rs` session-path index）：v3 的 session 解析走 `session_ui_profile_store` 与 `ephemeral_registry` 各自路径，不依赖目录遍历，YAGNI。lightbox composer 预览已由 6.2 收编，不再排除。
- task failure alerts、贡献者头像。
- conv-nav 整条 rail 可点：v3 自己的 `conversation-nav.js` 已是全 track 点击委托（`trackEl` click + `pointerTickIndex` 映射最近刻度），同一效果不同实现，无需迁移。
- `sanitize-markup.js` 抽取：v3 `_sanitizeMarkup` 内联且只有一个调用方，YAGNI；等 ACP spec M2 出现第二个消费方再抽。
- slash 菜单 agent 选择器布局：依赖 composer-agent-menu，归 ACP spec 的 M2。
- 侧边栏折叠箭头 SVG 14px：v3 sidebar 无对应结构，不适用。
- 模型可见性 opt-in（§5.3 的 D1a）：本次不动语义，理由与代价见 §5.3。
- upstream `5c92645` 的 model selection 测试：v3 已有 `public/models/selection.test.js` 覆盖同形断言，不重复迁。

## 8. 验证

每项落地后运行：

- `bun run check`（含前端 lint/format/design check）
- `bun run check:rust`（cargo check + clippy + fmt + 单测）
- `bun run test`（最终收尾跑全量）

完成后 `ARCHITECTURE.md` 需同步：`## 运行时生命周期`（已存在，`ARCHITECTURE.md:123`）补子进程注册表与启动清扫；Git 没有独立小节，push 契约加进 `## 模块清单` 的 `git_service.rs` 行（`ARCHITECTURE.md:175`）。
