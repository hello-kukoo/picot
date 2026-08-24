# Git History Panel 设计

**日期：** 2026-08-24（2026-08-24 评审修订）
**状态：** 草案，已评审修订，待实现
**参考：** [Git Panel 与 Git Diff 设计](2026-07-26-git-panel-design.md)（下称首期设计）；复用其 broker 传输与 diff 渲染管道，不新增 Git HTTP 路由。

## 目标

在右侧 Git panel 内增加 **Changes | History** 文字 sub-tab（外层页签仍为 icon toggle，视觉层级：icon > 文字，不构成嵌套 tab 困惑）。

- **Changes sub-tab：** 现状不变。
- **History sub-tab：** 上下两个 section，各自独立滚动。
  - 上部：当前 workspace 的 commit log 平铺列表，首拉 50 条，底部"更多"追加下一批。
  - 下部：选中 commit 的详情 = 完整 commit message + 改动文件列表。未选中时显示空态文案。

## 非目标

- tree 式 timeline / 分支图形化；分支、tag 图标装饰。
- log 行内显示 hash；行级右键菜单或行内操作按钮。
- push / pull / fetch / rebase / revert / cherry-pick 等远程或改写历史的操作。
- 自动滚动加载（IntersectionObserver）。
- commit 搜索、过滤、按作者/日期筛选。
- **第二父侧提交可见性**（`--first-parent` 列表的已知限制，见下）。

## UI 结构与交互

### Log 列表（上 section）

- 行内容：`subject（单行截断）+ relative time + author name`。无 hash，无图标。
- 平铺线性列表，不做 tree。
- 空态（unborn repo）：显示"没有历史记录"一句话。
- 分页：首拉 50 条；列表底部"更多"文字式按钮追加下一批，式样复用左栏 session tree 底部的 `.project-sessions-toggle`（`t("sidebar.showMore")` 同款视觉），不做实心按钮。
- **翻页终止**：本批条数 < limit 时隐藏"更多"按钮；host 端 `before~1` 不可解析时返回空批并置 `hasMore: false`（双保险，防止 root commit 处 `<before>~1` exit 128 崩溃）。

### 详情（下 section）

- 空态：未选中时显示"点击提交查看详情"，不自动选中第一条（避免隐式请求，简化状态机）。
- 点击 log 行 → 拉取单条详情并显示：完整 commit message（含 body）+ name-status 文件列表。
- 操作集中在详情区，不进 log 行：
  - **Copy hash** 按钮（复制完整 OID，按钮旁展示 short 形式）。
- 点文件列表中的文件 → 在既有 `FilePreviewPanel` 以 side-by-side diff tab 打开该文件在此次 commit 的改动。

### 刷新时机

- commit 成功后若 History sub-tab 可见，自动刷新 log 列表。
- 手动刷新沿用 panel 头部既有 refresh 按钮，同时刷新 Changes 与 History。

## 信任边界与传输

全部沿用首期设计的 owner-scoped broker 模式：不新增 REST 路由；命令经 `git_command` 帧、generic Pi forwarding 之前的 dispatcher；要求 Native client class、owner registry 派生 cwd、`workspaceGeneration` 匹配；Rust 侧以参数数组运行 Git，不经过 shell，不信任浏览器传入的绝对路径。

新增三个只读子命令。**字段名与现有 dispatcher 对齐：帧内判别字段为 `/command/type`**（broker_ws.rs:1206），不是 `kind`：

```text
{ type: "git_command", requestId, workspaceGeneration,
  command: { type: "log", limit: 50, before?: <oid> } }

{ type: "git_command", requestId, workspaceGeneration,
  command: { type: "log_detail", oid: <oid> } }

{ type: "git_command", requestId, workspaceGeneration,
  command: { type: "commit_diff", commitOid: <oid>, pathBytesBase64 } }
```

`commit_diff` 是独立子命令而非 `diff` 的 comparison 变体：首期 diff 的授权模型把路径绑定在 **当前 workspace status snapshot entry** 上，而 commit diff 是历史状态，文件大多不在当前 snapshot，entry 匹配天然失败。因此 commit diff 的授权模型为：**`commitOid` 授权 + host 端从该 commit 自身的 name-status 重推导 path**——host 先跑该 commit 的 name-status，验证 `pathBytesBase64` 属于其中，再出 diff。不携带也不使用 `snapshotId`。

- `oid` / `commitOid` / `before` 必须由 host 端校验为 40/64 位十六进制（64 兼容 sha256 repo，防御性）且 `git rev-parse --verify <oid>^{commit}` 通过，杜绝注入。
- 响应帧沿用既有命名风格：`git_log` / `git_log_detail` / `git_commit_diff`，均携带 `requestId + workspaceGeneration`。

### 命令与格式

- 列表：`git --no-pager log --first-parent --max-count=<limit> [--format=<fmt>] <before>~1`（有 `before` 时）`--format=<fmt> -z`（NUL 分隔，subject/body 含换行或引号不炸）。列表请求只带轻字段：`oid`、subject（单行）、author name、author unix time。不带 body。
  - **`--first-parent` 为定案**：不加则分页不精确——merge 恰在页边界时整支第二父提交会从列表中消失（实测 8 页模拟：547 唯一 commit 中 161 个 second-parent-only commit 仅 14 个能翻到）。加 `--first-parent` 后 `before~1` 续拉在第一父链上精确。已知限制：merge 的第二父侧提交不出现在列表中，与"不做分支图形化"的非目标一致。
- 详情：`git --no-pager log -1 --format=<fmt-with-body> -z <oid>` + `git --no-pager diff-tree --no-commit-id --name-status -r -z -M -C <oid>`，一次请求返回两部分。
  - **merge commit 文件列表**：`diff-tree` 对 merge commit（不带 `-m/-c/--cc`）是 no-op，输出恒为空。正确命令为 `git --no-pager diff --name-status -r -z -M -C <oid>^1 <oid>`。（`-M -C`：diff-tree 不读 diff.renames 配置，无此 flag 则 rename/copy 检测失效）host 端对 merge commit（parent 数 > 1，可从 name-status 前置的 `--pretty=%P` 或单独 rev-parse 判定）自动切换到该形式，对第一父 diff。
  - root commit 判定同源（parent 数 = 0）。
- 文件 diff：
  - 普通 commit：`git --no-pager diff-tree -p <oid> -- <pathbytes>`
  - merge commit：`git --no-pager diff <oid>^1 <oid> -- <pathbytes>`
  - root commit：`git --no-pager diff-tree -p --root <oid> -- <pathbytes>`
  - 路径参数一律经 `--literal-pathspecs`（与首期一致）。
- **name-status 解析器为新建**：现有 `parse_porcelain_v2_z` 只解析 porcelain v2 status，不能复用于 diff-tree/diff 的 name-status 输出。新解析器需处理：NUL 分隔、rename/copy 的 `R<score>`/`C<score>` score 后缀、连续 NUL、path 中含引号/换行。

### 竞态与乱序

- 快速连点 commit A、B 时，A 的详情响应后到不得覆盖 B：沿用首期 requestId 绑定模式——前端记录当前 pending `requestId`，响应帧 `requestId` 不匹配即丢弃。
- History 状态挂 `workspaceGeneration`：workspace 切换时清空列表与详情并按需重拉，沿用既有 `gitResponseMatchesGeneration` 模式。
- log 与 log_detail 的 requestId 通道相互独立，互不清除。

### 资源限制

- `limit` 由 host 钳制（1–200，默认 50），忽略浏览器传入的更大值。
- log 输出设 stdout 上限与读 deadline。deadline 沿用既有 `git_os` 路径（当前为 `GIT_WRITE_DEADLINE` 30s；实现时如为 log 新增专用 helper，需在 spec 修订中注明实际值），超限返回截断错误而非挂死。
- 详情 message 与文件列表设条数/字节数上限，超限时 message 截断并在 UI 标注。

### 渲染器回退（rename / 空 diff）

rename/copy、binary 等 commit diff 可能为 0 hunks；现有渲染器会误报 "Diff is empty"。commit diff 分支必须携带 `fallbackReason`（如 rename-only），渲染器据此显示"此文件在本次提交中仅重命名/复制"而非空 diff 文案。

## 边界情况

| 情况 | 行为 |
| --- | --- |
| unborn repo（零 commit） | log 空态："没有历史记录" |
| merge commit 文件列表 | `git diff --name-status <oid>^1 <oid>`（diff-tree 对 merge 恒空）；显示 merge 相对第一父**引入**的内容（GitHub 式）——第一父侧已有文件不列出 |
| merge commit 文件 diff | `git diff <oid>^1 <oid> -- <path>` |
| root commit | diff 加 `--root` |
| `before` = root commit | host 端 rev-parse 校验失败 → 空批 + `hasMore: false`；前端批 < limit 亦隐藏"更多" |
| 大 repo 分页 | 第一父链上 `before~1` 续拉，禁 `--skip` |
| 第二父侧提交 | 不可见（`--first-parent` 已知限制，非目标） |
| workspace 切换 | 清空重拉 |
| commit 成功 | History 可见时自动刷新列表 |
| subject/body 含换行、引号、NUL 相邻字符 | `-z` NUL 分隔解析，不按行分割 |
| rename/copy 0 hunks | `fallbackReason` 提示，不显示 "Diff is empty" |

## 测试与验收

1. Rust 单元测试：log/log_detail/commit_diff 解析（新 name-status 解析器：NUL、空 body、`R100`/`C75` score 后缀、rename/copy 原路径、连续 NUL）、oid 校验拒绝注入、limit 钳制、merge 判定与 `<oid>^1` 切换、root 终止、deadline。
2. broker 测试：`log` / `log_detail` / `commit_diff` 三命令路由（`/command/type` 判别）、workspaceGeneration 拒绝、非 Native client 拒绝、响应帧 shape。
3. 前端 Vitest：sub-tab 切换状态机、分页追加与批 < limit 隐藏"更多"、requestId 乱序丢弃、空态文案、Copy hash（clipboard 权限回退）、点文件打开 diff 的 descriptor 构造（`type: "commit_diff"` + `commitOid`）、fallbackReason 渲染。
4. i18n：**4 locale（en/zh/ja/es）**全量补齐（"没有历史记录"、"点击提交查看详情"、"更多"、Copy hash、History/Changes 标签、fallbackReason 文案；`git.comparison.*` 现仅有 staged/changes/untracked，新增键四语言同步）。
5. 完成前运行聚焦测试、完整 `bun run test`、`bun run check`、`bun run check:rust`。
6. 真实开发应用中截图或等效交互证据：History 列表、详情、文件 diff 打开（含 merge commit 与 rename 文件）、unborn repo 空态、workspace 切换。

## 受影响的架构边界

- `src-tauri/src/git_service.rs`：新增 `log` / `log_detail` / `commit_diff` 只读方法、**新建 diff-tree/diff name-status NUL 解析器**、merge/root 判定与命令切换。
- `src-tauri/src/broker_ws.rs`：`git_command` dispatcher 新增 `log` / `log_detail` / `commit_diff` 路由（`/command/type` 判别）。
- `public/git-client.js`：新增 `log` / `logDetail` / `commitDiff` 方法。
- `public/git-panel.js`：sub-tab 状态机；History 渲染若超约 50 行拆出 `public/git-history-panel.js`（模块纪律）。
- `public/app.js`：新增 `git_log` / `git_log_detail` / `git_commit_diff` 帧监听接线、workspace 切换时 History 状态清理、refresh 按钮扩展（现有 git 接线位于 app.js:1582-1745 一带，同模式扩展）。
- `public/git-diff-renderer.js`：commit diff 分支的 `fallbackReason` 空态处理。
- `public/index.html`：sub-tab 与两 section 骨架。
- `public/locales/{en,zh,ja,es}.json`：新增键四语言同步。
- `ARCHITECTURE.md`：实现后补记 Git History 命令、commit_diff 授权模型（commitOid + name-status 重推导，区别于 snapshot entry 模型）与验证契约（并入既有 Git panel 章节即可）。
