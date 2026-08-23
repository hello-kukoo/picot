# features-v3 → feature-v3.3-new-arch 分阶段迁移计划

> 状态：申请中。每个 phase 完成后走人工测试 → 代码评审（hunk + reviewer）→ 单 PR（不再多内容合并一个 PR）。
> 关联文档：`docs/feature-v3-migration-playbook.md`（双架构映射/verbatim 协议）、`docs/feature-v3-migration-matrix.md`（标识符/文件对照）。

## 评审修订记录（2026-08-23）

本计划经只读评审后修订，所有修订点均已对照两侧源码核实：

- **H1** 修正 Phase 1c 架构断言：新架构**存在运行时工作区切换**（`app.js:865/887/1216/1857`，`adoptTarget` 显式处理 `workspaceId` 变化并触发 `sidebar.load()`），原「进程级稳定（无切换），仅初始探测」说法错误，据此简化移植会引入可见性不更新 bug
- **H2** 补入遗漏提交 `b5bb9ae`（harden P1 workspace integrations，12 文件 +358/−110）：git 不可用处理并入 Phase 1d；install.sh 与 skills TOCTOU 测试归 Phase 5
- **M1** 修正 Phase 4 白名单断言：新架构**无 `protocol/` 目录、无命令白名单机制**，白名单方案降级为设计决策项
- **M2** 消解 Phase 3b 不确定性：pi RPC **原生支持 `fork`**（`src-tauri/resources/pi/docs/rpc.md:615-637`，`{"type":"fork","entryId"}`；v3 本就走该 RPC，`embedded-server.ts:2585`），删除"等效实现"回退分支
- **M3** Phase 4 剔除已完成项：全局 AGENTS.md / APPEND_SYSTEM.md 编辑器已随 `b5652c0`（PR #34）移植，`95e7e0d` 仅剩登出流程待移植
- **L1** Phase 3c 明确服务端 helper `paste-offload.ts` 的移植落点（安全逻辑必须随传输层选择一并移植）
- **L2** 补入 `bbdfafa`（sidebar action-slot CSS，入 2a）与 `718b348`（chips/transition 守卫文档，随 3e）
- **L3** Phase 2a 降低数据流担忧：`session-tree.js`/`workspace-actions.js` 经核实为零 import、零 fetch 的纯视图构建器；数据流工作的真正对象是 Rust 侧（`pi_manager.rs` +178 / `main.rs` +76）
- **L4** 修正行数：`pi-oauth-login-adapter.ts` 实为 202 行（原写 188）
- **L5** ARCHITECTURE.md/ADR 时机前移：Phase 3c（新增存储路径与安全语义）与 Phase 4（OAuth 边界）落地时即产出，Phase 5 只收尾
- 附「已移植防重清单」（`06e1393`/`ad64d9b` 等，防止重复劳动）

## 双架构速查（本计划相关面）

| 维度 | features-v3（源） | feature-v3.3-new-arch（目标） |
| --- | --- | --- |
| 右侧栏 | tab 体系（Files/Git/**Info** 三 tab，`file-sidebar-info-tab`） | **无 tab**；pill → 互斥面板（`workspace/exclusive-side-panel.js` 的 `toggleExclusiveSidePanel`/`toggleExclusiveSideView`，已带测试）。入口：工具条 `file-sidebar-toggle`（文件）、`diff-sidebar-toggle`+`git-branch-indicator`（git，见 `index.html`/`project-header.js`） |
| Package 管理 | `public/settings/package-manager.js` + `package-browse.js` + `extensions-tab-shell.js`（b42ccde/f9a7ea3 新增） | `public/native/settings/package-manager.js` + `package-browse.js`（已存在，需 diff 比对） |
| message 渲染 | `public/ui/message-renderer.js`（含 fork 按钮、user 折叠、工具栏） | `public/ui/message-renderer.js`（同源，已含 footer 时间戳；`_createForkButton` 雏形已在 renderer 挂钩） |
| 会话历史树 | `public/session-tree.js`（5dd2bb9 新增，294 行，**纯视图构建器：零 import/零 fetch，数据由调用方注入**）+ `workspace-actions.js`（156 行，同上） | 无 `session-tree.js`；`session-info.js` 仅框架 |
| 后端能力 | embedded-server.ts（extension，loopback HTTP） | Rust HostServer + picot-bridge extension（无 loopback 业务 API） |
| 粘贴转存 | `/api/paste-offload`（embedded-server:3580，4MiB body 顶）+ `extensions/paste-offload.ts`（`writePasteOffloadFile`：symlink 检查、0o600、EEXIST 重试、`PASTE_OFFLOAD_MAX_BYTES=2MiB`） | 无对应 → 需 picot-bridge 命令或 Rust host 数据命令（见 3c） |

## 已移植防重清单（勿重复立项）

以下 v3 提交对应能力已在 v3.3 存在，核实证据附后：

| v3 提交 | 内容 | v3.3 现状 |
| --- | --- | --- |
| `06e1393` | 主题首帧前同步解析（head bootstrap） | `public/index.html:13` `theme-bootstrap` 脚本已有 ✓ |
| `ad64d9b` | thinking level 应用到 live session + 快照护栏 | `thinking-effort-control.js:98` + `picot-config.ts:906-909`（`get/set_default_thinking_level`）已有 ✓ |
| `e5a68b1`/`6e131de`/`4243be5` 等基建 | 静态资产指纹/host 通道对等/签名脚本 | 已在 upstream main ✓ |
| （`b5652c0` 本仓 PR #34） | settings 拆分 + AGENTS.md/APPEND_SYSTEM.md 编辑器 | 已完成 ✓（即 Phase 4 的编辑器项） |

---

## Phase 1：Package manager（功能点 1+2）+ Git pill 隐藏与硬化（功能点 7）

> Dr. Lin 分组确认：1+2 是 package manager 改造；7（Git 入口隐藏）因直接复用已完成 P1a 的 `notGitRepo` 状态（同源探测），并到本 phase 顺热接线。

### 1a. 差异审计（先行，不做直接可能返工）

v3 提交：`b42ccde`（原始）→ `f9a7ea3`（同标题复提交，疑为 rebase 后版本，需确认差异）。

动作：

1. diff v3 `package-manager.js` vs 新架构 `public/native/settings/package-manager.js`，输出缺口清单：
   - `checkPiPackageUpdates`（一键更新探测）是否存在
   - Installed/Community 双 tab 结构是否一致
   - enable/disable/update/remove 操作覆盖
2. diff `package-browse.js`（Community/marketplace 浏览）
3. diff `extensions-tab-shell.js` vs 新架构 `package-skills-tab.js` 等 tab 壳的职责划分
4. 检查 `settings-panel.js` 中 extensions tab 装配（新架构已接 `setupPackageBrowse`/`setupPackageManager`，见 P3 落线）
5. diff v3 `skill-installation` 域 vs 新架构扩展侧安装流程（`b5bb9ae` 对 v3 侧加了 TOCTOU 回归测试，审计时以 v3 最新态为基准）

交付：缺口清单（diff 结论 + 每缺口工作量级），作为本 phase PR 的第一 commit 或文档。

### 1b. 移植缺口

按 1a 清单逐项补齐，verbatim 优先（playbook 协议），标识符按 matrix 映射。

### 1c. Git pill 隐藏（功能点 7）

v3 提交：`e0ed776` + 完善版 `49564e0`（+222 行含 tests）。

映射：

- v3 通过 `gitCommandFailed` 探测非 Git 仓库 → 隐藏 `file-sidebar-git-tab` + 通知
- 新架构：P1a 已有 `notGitRepo` 状态（`git-panel.js` + `git-panel-integration.js`）。本 phase 复用该状态：
  - 新架构无右侧栏 git tab——对应的"隐藏"是：**非 Git 工作区时隐藏工具条 git pill（`diff-sidebar-toggle`/`git-branch-indicator`）**，或点击时提示。设计决策点：**跟随 v3 语义"隐藏入口"还是保留 P1a 的"展示提示"？** 建议：隐藏 pill（与 v3 一致），P1a 的面板内提示保留为兜底。
- ~~`49564e0` 的"进入非 Git 工作区即刻隐藏"逻辑：新架构 workspace 进程级稳定（无切换），仅初始探测场景 → 简化移植~~
  **【H1 修正】新架构存在运行时工作区切换**：会话侧栏按 `project.path` 分组，点击跨项目会话即在同一窗口内切换工作区。`adoptTarget`（`app.js:1819`）在 `workspaceId` 变化时已有明确钩子（`:1857` 分支触发 `sidebar.load()` + `sessionInfo.refresh()`）。因此 `49564e0` 的"进入即隐藏"**必须**完整移植：git pill 可见性订阅 `adoptTarget` 的 workspaceId 变化事件，每次切换重新探测（或复用已缓存的探测结果）并应用 `notGitRepo`；启动探测只是触发点之一，不可据此简化。

### 1d. Git 不可用硬化（源自 `b5bb9ae`）

v3 提交 `b5bb9ae` 中 git 相关部分（该提交 12 文件 +358/−110，git 域与 install/skills 域拆分归属）：

- `src-tauri/src/git_service.rs`（+25）：git 探测错误区分与降级
- `extensions/workspace-info.ts`（+27）+ `workspace-info.test.ts`（+37）：工作区元数据的 git 不可用容错
- `public/git-panel.js`（+13）+ `git-panel.test.js`（+37）：面板侧错误分支
- `public/app.js`（+26）与 4 语言 locales（+1/语言）

与 1c 同属"非 Git 工作区"体验域，随本 phase 一并移植（verbatim 优先）；`b5bb9ae` 的 `install.sh`（Snap 安装）与 `skill-installation.test.ts`（TOCTOU 回归）部分归 Phase 5。

### 验收

- 人工测试：安装/更新/卸载一个社区包；非 Git 仓库打开 app 工具条无 git pill；**在多项目窗口内从 Git 工作区会话切到非 Git 工作区会话，git pill 即刻隐藏（反向亦然）**
- `bun run vitest run public/native/settings/ public/native/features/git-panel-integration.test.js public/git-panel.test.js`
- `bun run check:rust`（1d 触及 Rust）+ `bun run check`

---

## Phase 2a：Info panel / session-tree（功能点 3）

v3 提交：`5dd2bb9`（+4293/-256，37 文件——含 `session-tree.js`(294)、`workspace-actions.js`(156)、`session-tree.test.js`(270)、Rust `pi_manager.rs`(+178)/`main.rs`(+76)、`message-renderer`(56)、locales×4）+ `bbdfafa`（sidebar action-slot focus 重排 CSS，+28/−10）。

### 前置设计决策：打开入口（Dr. Lin 已提醒）

**问题**：v3 的 info panel 由右侧栏第三个 tab（`file-sidebar-info-tab`）打开；新架构无右侧栏 tab 体系，没有现成触发位置。

**候选方案**：

- **(A) 工具条新增第三个 pill**（如 session/history pill，置于 workspace path 与 git 之间或后）→ `toggleExclusiveSidePanel(infoPanel, [filePanel, gitPanel])`。与现有 pill 模型一致，新增组件小（`exclusive-side-panel.js` 已存在且带测试，直接可用）。**倾向此方案**。
- **(B) workspace path pill 下拉菜单**（列出 Files / Git / Info）— 改动大，违背现有"一个 pill 一个面板"模型
- **(C) 并入 session 侧栏**（左侧会话列表顶部 info 区）— 语义偏移（v3 是右侧栏）

决策点：**(A)** 的 pill 图标/位置/快捷键；建议在 phase 2a 开工前和 Dr. Lin 敲定，避免返工。

### 移植内容

1. `session-tree.js`（v3: 会话历史树——branch/历史聚合）。**【L3 修正】经核实为纯视图构建器**（零 import、零 fetch、零 API 调用，数据由调用方注入）→ 可 verbatim 移植；`session.filePath` 标识符按 matrix 映射为 `session.id`
2. `workspace-actions.js` 中 info 相关部分（156 行，同为纯视图构建器；需拆分：哪些属 info panel、哪些属其他）
3. Rust 侧 `pi_manager.rs`/`main.rs`（+254 合计）——**这是本 phase 数据流工作的真正对象**：查具体改动，映射到新架构 `host_data.rs`/`data-gateway` 既有能力（会话枚举/分支信息），确定可复用 vs 需新增的部分再定可否简化
4. `message-renderer` 56 行（info 相关渲染钩子，随 session-tree 一并核对）
5. i18n ×4
6. `bbdfafa` 的 sidebar action-slot CSS 重排（纯样式，随本 phase 侧栏改动顺带对齐）

### 验收

- 人工测试：会话历史树展开/折叠、branch 标识、跨会话切换状态正确；新 pill 与现有两面板互斥开合
- 全量 vitest + check + check:rust

---

## Phase 3：主聊天窗口（功能点 4+5+10+11；+ markitdown 9 移入 Phase 5）

> Dr. Lin 分组确认；9（markitdown CLI）经复核属扩展服务域，移入 phase 5。内部按依赖排序拆步。

### 3a. 长 user prompt 视觉折叠（功能点 5a）

v3 提交：`09868a4` 引入（阈值 `USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD=400`、`_NEWLINE_THRESHOLD=8`，v3 `message-renderer.js:11` 起）。

- 新架构 `message-renderer.js` 无此功能（已核）
- 移植：`formatMessageTime` 旁新增阈值常量与 `_createUserCollapseToggle`；`renderUserMessage` 挂钩（v3 的折叠进工具栏——与 P2a 已迁移的 footer 工具栏配合）
- 独立小件，先行

### 3b. 聊天导航条改进 + user prompt 层面 fork/branch（功能点 4）

v3 现状：`app.js:2391` `Fork from here` 按钮（user 消息 footer）+ fork 后 composer 预填充 + `09868a4` 工具栏改版（展开开关入工具栏、操作栏恒显）。

~~前置验证：pi RPC 是否支持 fork/branch 命令~~ **【M2 消解】已核实**：

- pi RPC **原生支持** `fork`（`src-tauri/resources/pi/docs/rpc.md:615-637`：`{"type":"fork","entryId":"..."}`，可被 `session_before_fork` 扩展事件取消，返回被 fork 消息文本）与 branch/复制会话（`:645` 起）
- v3 的 Fork from here 本就走该 RPC（`embedded-server.ts:2585`：`send_rpc(port, { type: "fork", entryId })`）
- 因此映射＝**runtime-gateway 直发同一 RPC 命令**，近乎 verbatim；无需 embedded-server 中转，无"等效实现"回退分支

注意：P2a 已迁 footer（含 copy/time/cost），fork 按钮插槽已存在（`_createForkButton` 雏形在 renderer `:253` 已挂 footer，但装配/流程未验证）。

### 3c. 大段粘贴转存文件引用（功能点 5b）

v3 提交：`c6f4e43`。**【L1 明确】两个组件，缺一不可**：

- 前端主体：`composer-paste-offload.js`（内容→文件→`@path` 引用替换）——可 verbatim 移植
- 服务端 helper：`extensions/paste-offload.ts` 的 `writePasteOffloadFile`（**安全语义所在**：symlink 检查、0o600 权限、EEXIST 重试、`PASTE_OFFLOAD_MAX_BYTES=2MiB` 内容顶；embedded-server 侧另有 4MiB body 顶）——必须随传输层选择一并移植，不能只搬前端

新架构差异：**无 loopback 业务 API**。映射选项：

- **(A)** 改 `picot-bridge` extension 命令（如 `write_paste_offload`）——不走 HTTP，`paste-offload.ts` 逻辑 verbatim 进 bridge（**倾向**；bridge 与 v3 extension 同为 TS，移植摩擦最小）
- **(B)** Rust host 加数据命令 —— `writePasteOffloadFile` 语义需译为 Rust 并复用 `host_data.rs` 的路径安全检查（`safe_join`），工作量更大

**【L5】无论选哪个，本步交付含 ARCHITECTURE.md 增量**：新增的临时文件路径约定（`.pi/tmp/paste-*.txt`）、大小上限与权限语义、以及传输层选择理由，落地时即写入（不等 Phase 5）。

### 3d. write 工具后预览热重载（功能点 10）

v3 提交：`95f0b9f`（`file-preview-follow.js` 现 108 行 + `file-preview-panel.js` +19、tests +62）。

- 新架构有 `file-preview-panel.js`/`file-preview-markdown.js` 等（无 `file-preview-follow.js`）
- 移植：面板监听 write 完成事件 → 重载预览 + 词法工作区边界（v3 的 `follow` 跟随逻辑）

### 3e. 单回合写入文件 chips 行（功能点 11）

v3 提交：`7fb1d29`（`turn-file-chips.js` 41 行 + css + locales）+ 文档 `718b348`（回合 chips 与 workspace-transition 守卫记录，随本步拷入新架构 docs）。

- 独立小件；chips 行渲染在消息流中（工具调用结果的单回合文件写入提示）
- 新架构 tool-renderer（`ui/tool-card.js` 等）需核对 chips 挂载点

### 验收

- 人工测试：>400 字符或 8 换行的 user 消息折叠/展开；fork 会话流程完整（新会话+branch 正确）；粘贴超长文本→转存引用；write 后预览刷新；单回合 chips 显示
- phase 3 为超大 PR → **允许内部分 2-3 个 commit**（3a/3b → 3c → 3d+3e），仍单 PR

---

## Phase 4：Codex OAuth（功能点 6）

v3 提交：`6f2f5a0`（`oauth-login-operations.ts` 272 + `pi-oauth-login-adapter.ts` **202**（【L4 修正】原写 188）+ `models-oauth-login.js` 293 + embedded-server +301 + i18n×4）+ `95e7e0d`（登出 + ~~全局 AGENTS.md 编辑器~~【M3 剔除：编辑器已随本仓 `b5652c0`/PR #34 移植，含 APPEND_SYSTEM.md；`95e7e0d` 仅剩登出流程待移植】）+ `dc3f14c`（ARCHITECTURE.md 边界）+ `a3515dd`（设计文档 299 行，v3 在 `docs/superpowers/specs/`）。

### 前置：设计稿（本 phase 第一个 deliverable）

1. 把 v3 `a3515dd` 设计文档 + phase 计划（`docs/superpowers/plans/2026-08-16-oauth-phase-0-1.md`）拷入新架构 `docs/superpowers/`，作为基线
2. 决策点：
   - **设备码轮询归属**：Rust HostServer vs picot-bridge extension（v3 在 embedded-server；新架构映射）
   - **token 存储**：写入 pi 认证存储（`~/.pi/agent/auth.json` 格式）——确认 bridge/Rust 访问方式与 pi-mono 文档（`docs/rpc.md` auth 相关段）；注意新架构已有 `picot-config.ts` 的 `set_api_key`/`remove_api_key` 写 auth.json 先例可参照
   - **登出流程**：`95e7e0d` 的登出部分
   - ~~命令策略：v3 `protocol/picot-core-commands.json` 允许 oauth 命令——新架构 `protocol/` 对应文件需加白名单~~
     **【M1 修正】新架构无 `protocol/` 目录，`host_server.rs`/`picot-bridge.ts` 亦无任何命令白名单机制**（已核）。v3 的白名单由 `extensions/command-policy.ts` 消费，服务于 remote/host 通道。新架构**是否需要等价物、挂在哪一层**（bridge 命令枚举 vs Rust 侧校验 vs 不需要）是本 phase 设计稿必须回答的问题，不是给既有文件加条目
3. 安全评审：deviceless 轮询、csrf/边界（dc3f14c 更新过 REST 端点与 OAuth 边界）；**【L5】ARCHITECTURE.md OAuth 边界增量随本 phase 落地，不等 Phase 5**

### 移植

按设计稿实施。ui 部分（models-oauth-login.js）落到新架构 `models-page.js`（P3 已完成 settings 拆分，天然承接）。~~AGENTS.md 编辑器是独立组件，可评估拆出单独 PR 或随本 phase~~（已剔除，见上）。

### 验收

- 人工测试：Codex 设备码全流程（浏览器授权→token 落盘→模型可用→登出）
- 安全评审记录入 PR
- 全量测试 + check + check:rust

---

## Phase 5：其他（功能点 8+12+9 + 文档收尾）

> Dr. Lin 确认按功能分组；本 phase 收纳无法归入聊天/右侧栏/包管理/认证域的小件与文档。

- **8** `306f161` Windows 启动目录回退（已核：新架构 `native_pi_manager.rs:122` `.current_dir(&spec.cwd)` 无回退；v3 回退 home + 报错优化）——纯 Rust
- **12** `e2567dd` 跨会话切换延刷新护栏与状态清空（v3 `routing.js`/`state.js`；新架构对应物是 `app.js` 的 `adoptTarget`/`navigationGeneration`（`:1213`）路由语义，需语义移植而非文件移植）
- **9** `cc4b32a` markitdown uv/pipx CLI 支持（已核：新架构 `markitdown_preview.rs` 仅 `python -m markitdown` 探测（`:81/:112/:160`），无 uv/pipx CLI 候选）——纯 Rust
- **（源自 `b5bb9ae`）** `scripts/install.sh` Snap/curl 安装硬化（240 行重写）+ `extensions/skill-installation.test.ts` TOCTOU 回归测试（+59）
- **文档收尾**：拷贝 v3 `docs/superpowers/specs/2026-08-10-message-toolbar-design.md`（历史存档）；~~评估新架构无 ARCHITECTURE.md 的 ADR 决策~~【L5 调整】settings/models 拆分、paste-offload（3c）、OAuth 边界（Phase 4）的架构增量已前移至各 phase 交付；本 phase 仅收尾：汇总回顾 + 评估是否仍有遗漏 ADR

### 验收

- 每项独立小 PR 或一 PR 多 commit（分开评、分开审）
- `bun run test` + `check` + `check:rust` 全绿

---

## 每 phase 标准流程（通用）

1. 实现（TDD：先失败测试 → 最小改动转绿）
2. 聚焦验证 → `bun run test` / `check` / `check:rust`（按面）
3. hunk review + reviewer 子代理双评审，修复评审意见
4. 人工测试（各 phase 验收清单）
5. 单 PR（正文含：v3 提交映射、差异审计、验证结果、遗留/设计决策）
6. 不合并多 phase 内容；每 PR 保持一个主题

## 已确认分组与顺序

| Phase | 内容 | 功能点 | v3 提交 | 预计规模 |
| --- | --- | --- | --- | --- |
| 1 | Package manager（审计+缺口）+ Git pill 隐藏与硬化 | 1+2+7 | b42ccde/f9a7ea3, e0ed776/49564e0, b5bb9ae(git 域) | 中 |
| 2a | Info panel / session-tree + 触发入口设计 | 3 | 5dd2bb9, bbdfafa | 大 |
| 3 | 用户折叠 + fork/branch + 粘贴转存 + 预览热重载 + chips | 4+5+10+11 | 09868a4, c6f4e43, 95f0b9f, 7fb1d29, 718b348(docs) | 大（内部分步） |
| 4 | Codex OAuth（先设计稿；编辑器已剔除） | 6 | 6f2f5a0, 95e7e0d(登出), dc3f14c, a3515dd | 大 |
| 5 | Windows 回退 + 切换护栏 + markitdown CLI + 安装脚本/skills 测试 + 文档收尾 | 8+12+9+docs | 306f161, e2567dd, cc4b32a, b5bb9ae(install/skills 域) | 中 |
