# Picot 行级 Code Review 工作流设计

**状态：** Draft，待 Dr. Lin 评审
**日期：** 2026-09-22
**参照：** Hunk live session 的行级评论协议；Paseo `review/` 与 `git/diff-document/` 的 diff 行锚定和评论投影。二者仅作交互与数据模型参考，不引入运行时依赖。

## 目标

在 Picot 内建一套面向 AI 与人类协作的代码 review 工作流：

1. 从 composer Command Palette 的 **Review changes** 显式启动 review。
2. reviewer 模型对冻结 diff 做 review，把 finding 写为可见、可定位的行级评论。
3. 人类可在同一 Review Diff 页对 old/new/context 行新增自由文本评论。
4. fixer 模型只读当前 open 评论并改代码，不能新增、修改、删除或关闭评论。
5. fixer 正常结束且确有 diff 变化时，自动启动一次复审 reviewer；复审 reviewer 逐条关闭已解决问题或新增问题。
6. Review Diff 页始终投影当前 JSONL 中的评论；关闭评论后从默认 diff 视图消失。

## 非目标

- 不使用 Git branch、Git worktree、Git notes、GitHub Pull Request review API 或 sqlite。
- 不替代外置 Hunk，不连接 Hunk daemon，不同步 Hunk live session。
- 不审完整文件；v1 只允许对冻结 diff 的 old/new/context 行评论。
- 不做全量 Pi slash command 到 Command Palette 的投影。本期只加 Review changes。
- 不搬运公司扩展中的完整 `review.ts`。Picot 新实现只借其 `/review` 目标选择、Pi session fork 和回主会话的交互思路；公司扩展的实现继续只服务 TUI。
- 不自动循环 fix/review；fix 后最多自动复审一次。
- 不让完整 review 报告成为 fixer 的执行来源。fixer 只消费可锚定的 open 评论。

## 已验证事实

1. Picot 当前 Git diff 是 `public/git-diff-renderer.js`：只读双栏渲染，按 unified patch 解析行号，最多 600 个对齐行；没有行 gutter 交互或评论投影。
2. Git 数据面在 Rust `git_service.rs`，现有 Git panel 使用 owner-scoped status/diff/history/commit/push。Picot 能识别既有 Git worktree（`extensions/workspace-info.ts`），但没有创建、回收或切换 worktree 的生命周期子系统。
3. Pi extension 可通过 `pi.registerTool()` 注册 tool，并以 `pi.setActiveTools()` 按运行时启停；tool execute 层可继续校验 session/run/role。
4. Pi session fork 隔离会话历史，不隔离同一 workspace 的文件系统。外置 review extension 以 `reviewOriginId` 保存 fork 起点，完成后回原 session。
5. Picot 私有临时根是 `~/.pi/tmp`（`src-tauri/src/temp_resources.rs`）。现有模块只管理 quick-chat 子目录；review JSONL 必须建立自己的目录、权限和 24h cleanup，不能复用 quick-chat 的 token 删除函数。
6. Hunk 的 live comment 最小锚点是 `filePath + oldLine/newLine + summary/rationale + author`，agent 批量写入走 `hunk session comment apply --stdin`。这证明行级评论可作为 review→fix artifact，但 Hunk session 不应成为 Picot 的持久权威。
7. Paseo 的 review draft 是本地 state，评论锚点为 `filePath + side + lineNumber`，发送给 agent 时附 hunk header 与目标行前后各三行上下文。Picot 需要保留相同的上下文冗余，但评论不在发送后清空。

## 基本原则与安全边界

### JSONL 是唯一 review artifact

每次 review run 有一个 append-only JSONL 文件。reviewer、人类、fixer、自动复审和 Review Diff 页都以它为唯一评论来源。

- reviewer 的完整聊天报告是叙述，不是 fixer 的任务清单。
- fixer 的 tool 只返回当前 `open` 且非 `stale` 的评论投影。
- WebView 不直接读写 `~/.pi/tmp`；内建 review extension 是 JSONL 唯一读写者。
- Rust 不复制 JSONL 状态，也不建立 sqlite 镜像。

### 只接受冻结 snapshot 上的锚点

reviewer 即使自行运行 `git diff`，也不能把非冻结 snapshot 的行写入评论 artifact。`review_comment_add` 在 extension 侧验证 target 是否属于该 run 的 snapshot；不匹配直接拒绝。

### 最小权限

| 阶段 | 可用工具 | 禁止 |
| --- | --- | --- |
| 初审 reviewer | `review_diff_read`、`review_comment_add` | resolve、修改评论、fix 任务 |
| fixer | `review_comment_list` | add/update/resolve 评论 |
| 自动复审 reviewer | `review_diff_read`、`review_comment_add`、`review_comment_resolve` | 修改既有评论正文 |
| 人类 | Review Diff 页 add/resolve | 手写 stale |

`review_comment_resolve` 只接受 `fixed` 或 `dismissed`；`stale` 只由系统在重锚失败时产生。

### 仅一个 active run

每个 workspace 同时最多一个含 open/stale 评论的 review run。再次点击 Review changes 时，Palette 显示“继续 Review”，不新建 snapshot，防止 fixer 面对两份冻结 diff。

## Review run 与 JSONL

### 文件位置与生命周期

文件位于：

```text
~/.pi/tmp/reviews/<run-id>.jsonl
```

- `reviews/` 和文件均设 owner-only 权限。
- 有 open/stale 评论的 run 可跨 Picot 重启恢复 24 小时。
- 超过 24 小时未活动，由 review extension 的独立 cleanup 扫描删除。
- reviewer 关闭最后一条评论，或初审/复审无任何评论结束时，立即删除 JSONL。
- 文件删除后，已打开的 Review Diff 页只保留内存完成态，显示“完成，无 open 评论”；用户手动关闭页面。

### 首事件：冻结 snapshot

首条事件必须是 `run.created`，完整保存规范化 diff snapshot。未提交改动不能仅凭 base SHA 在重启后可靠重建，因此 run 必须保存完整文件、hunk、old/new 行和上下文。

```ts
type ReviewRunCreated = {
  type: "run.created";
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
  cwd: string;
  baseRef: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  pathspec: string[];
  ignoreWhitespace: boolean;
  reviewerModel: { provider: string; id: string };
  snapshot: ReviewDiffSnapshot;
};

type ReviewDiffSnapshot = {
  files: Array<{
    filePath: string;
    status: "added" | "modified" | "deleted" | "renamed";
    hunks: Array<{
      header: string;
      oldStart: number;
      newStart: number;
      lines: ReviewDiffLine[];
    }>;
  }>;
};

type ReviewDiffLine = {
  side: "old" | "new";
  lineNumber: number;
  kind: "add" | "remove" | "context";
  text: string;
};
```

超过 Review Diff 页既有 patch 上限或无法规范化的二进制/rename/copy diff，不允许启动 run；UI 显示已有 Git panel 对应 fallback 原因。

### 评论事件

JSONL 只追加事件，不原地重写。读取时从首个 snapshot 与全部后续事件投影当前状态。

```ts
type ReviewCommentTarget = {
  filePath: string;
  side: "old" | "new";
  lineNumber: number;
  lineText: string;
  hunkHeader: string;
  context: Array<{ side: "old" | "new"; lineNumber: number; text: string }>;
};

type ReviewCommentAdded = {
  type: "comment.added";
  id: string;
  createdAt: string;
  author: { kind: "human" | "reviewer"; model?: { provider: string; id: string } };
  target: ReviewCommentTarget;
  body: string;
};

type ReviewCommentResolved = {
  type: "comment.resolved";
  id: string;
  resolvedAt: string;
  author: { kind: "human" | "reviewer"; model?: { provider: string; id: string } };
  resolution: "fixed" | "dismissed";
};

type ReviewCommentStale = {
  type: "comment.stale";
  id: string;
  markedAt: string;
  reason: "target_not_found" | "target_ambiguous";
};

type ReviewReport = {
  type: "review.report";
  createdAt: string;
  reviewerSessionId: string;
  phase: "initial" | "verification";
  body: string;
};
```

评论正文统一是自由文本 `body`。不预建 severity、summary、rationale 分类；模型和人类都用同一形状，差别只在 author 元数据。

## 重锚与 stale

运行 fixer 后、自动复审前，以及用户手动刷新 diff 时，系统针对所有 open 评论重新比对当前 diff：

1. 以 `filePath + side + lineText + hunkHeader + 前后各三行 context` 搜索当前 diff。
2. 唯一匹配则更新内存投影到新位置，不新增 JSONL event。
3. 找不到或有多个匹配，追加 `comment.stale`。
4. stale 评论从默认 diff 投影移入独立折叠区，显示原 target 与正文。
5. stale 不进入 fixer 输入，也不进入自动复审输入。人类可将其 `dismissed`，或在新位置新增评论。

不按裸 `lineNumber` 重定位。行插入/删除后继续使用旧行号会让 fixer 改错代码。

若 review 期间发生 checkout、merge、rebase 或其他使当前 Git 基线不再对应 run 的操作，系统将整份 snapshot 标为失效：全部 open 评论进入 stale 折叠区，页面提示重新启动 review。不得把旧 snapshot 的评论重定向到另一个 Git 基线。

## 会话与执行流程

### 启动

1. 用户从 composer Command Palette 点 **Review changes**。
2. 用户选择范围（未提交改动 / base ref / paths）和 reviewer model。
3. extension 冻结 snapshot，创建 JSONL，打开独立 Review Diff 页。
4. 从当前 Pi session fork review branch（Pi session tree 概念，不是 Git branch）。该 fork 只隔离聊天历史，不创建 Git branch/worktree。
5. 初审 reviewer 调 `review_diff_read` 按需取 snapshot；finding 调 `review_comment_add` 逐条写入 JSONL。
6. reviewer 正常结束后写 `review.report`，自动回 origin 主 session。review branch 留在 session tree，供用户查看完整报告。

### 人类补充

reviewer 运行期间和结束后，人类都可在 Review Diff 页的 old/new/context 行 gutter 添加自由文本评论。每次添加即时 append JSONL。

启动 fixer 时冻结当前 open、非 stale 评论列表。fixer 运行中新增的人类评论不要求本次 fixer 处理，但会进入后续自动复审。

### 修复与自动复审

1. 用户在 Review Diff 页点 **修复 Open 评论**，选择 fixer model。
2. Picot 回到主 session 运行 fixer，并只启用 `review_comment_list`；fixer 首次调用取得启动时冻结的 open 评论投影（anchor、body、context、snapshot metadata）。
3. fixer 不能添加、修改、关闭或删除评论。
4. fixer 正常 `agent_end` 后，host 比较 fixer 前后 diff snapshot：只有确有变化才自动从主 session fork 一次 verification review branch。
5. verification reviewer 固定复用 run 创建时选择的 reviewer model；它读取所有当前 open、非 stale 评论（含 fixer 运行中人类新增项），逐条 `fixed/dismissed` 或新增问题。
6. 自动复审只运行一次。仍有 open 评论即停止，等待人类再次点修复；不再自动循环。
7. verification reviewer 结束后追加 `review.report`，自动回主 session。

### 重启恢复

重启后，24 小时内的 active JSONL 可恢复 Review Diff 页和冻结 snapshot。用户点“重新 Review”时从**当前**主 session 新 fork reviewer；不尝试续接已中断的旧 agent turn。旧 reviewer branch 仍只作为 session tree 历史。

## Review Diff 页

新增独立 Review Diff 页，不修改普通 Git panel 的 per-file diff 语义。页面由 run snapshot 直接渲染，至少包含：

- 文件树、文件/hunk 评论计数、完整 snapshot diff。
- old/new 双栏行号 gutter；old/new/context 行均可添加评论，空侧不提供按钮。
- open 评论行内 thread，支持 human add 与 human resolve。
- stale 评论折叠区；默认不投影到原 diff 行。
- 当前 run 状态、Open 数量、Review changes / 修复 Open 评论 / 重新 Review 控制。
- 最新 `review.report` 的“查看完整报告”入口；报告正文也可从 reviewer branch session 查看。
- 完成内存态：JSONL 删除后仍显示结果，直到用户关闭页面。

现有 `public/git-diff-renderer.js` 的 unified patch 解析逻辑可抽为共享纯模块；Review Diff 页必须新建自己的渲染和评论 overlay，不把 run 状态塞进现有 600 行只读 per-file renderer。

## Extension 与 tool 契约

内建 extension 负责：run 创建/恢复/cleanup、JSONL 投影、Pi session fork/回 origin、角色化工具、snapshot target 校验、review prompt 和自动复审编排。

建议 tool 契约：

```ts
review_diff_read({ runId, filePath?, hunkIndex? })
  // 仅 reviewer；返回冻结 snapshot 的指定部分

review_comment_add({ runId, target, body })
  // 仅 reviewer；target 必须命中冻结 snapshot

review_comment_list({ runId })
  // 仅 fixer；返回启动 fixer 时冻结的 open/non-stale 投影

review_comment_resolve({ runId, commentId, resolution })
  // 仅 verification reviewer；resolution=fixed|dismissed
```

所有 tool execute 均校验：当前 run id、当前 Pi session 对应角色、阶段允许的操作、target 是否属于 snapshot。`pi.setActiveTools()` 只控制可见性；execute 校验是不可绕过的授权层。

## 完整报告与执行权威

reviewer 可以输出完整代码 review 报告，概括范围、风险和无行级锚点的背景。报告写入 `review.report` JSONL event，并保留在 reviewer branch 聊天历史。

但只有 open、非 stale 的 JSONL 行级评论进入 fixer 输入。若报告中出现需要修的 finding，reviewer 或人类必须补一条行级评论；不允许 fixer 把叙述报告当作第二份 backlog。

## 清理与错误处理

| 情况 | 行为 |
| --- | --- |
| 无法创建冻结 snapshot | 不创建 run，显示 Git fallback 原因 |
| 目标行不属于 snapshot | 拒绝 `review_comment_add`，不写 JSONL |
| reviewer/fixer 被停止或报错 | 保留 active JSONL；不自动复审 |
| fixer 无 diff 变化 | 不自动复审，页面显示原因 |
| 关闭最后一条评论 | 立即删除 JSONL，页面转完成内存态 |
| 超过 24h 无活动 | extension cleanup 删除 JSONL |
| JSONL 损坏 | 不尝试猜测恢复；隔离文件、页面显示不可恢复错误，允许新建 review |

## 测试与验证

1. **extension unit tests**：JSONL event 投影；append-only；权限矩阵；snapshot target 拒绝；唯一重锚/ambiguous/not-found stale；24h cleanup；一 workspace 一 active run；fix 前后 diff 变化判定。
2. **renderer tests**：old/new/context gutter add 条件；open 评论 inline 投影；resolve 后默认隐藏；stale 折叠；完成内存态。
3. **会话流程 tests**：初审 fork→返回 origin；fixer tool 只读；正常 fix 触发一次 verification fork；stop/error/no-diff 不触发；第二轮仍有 open 不再自动循环。
4. **host/UI integration**：Command Palette Review changes action、Review Diff 页打开、ConfigGateway/extension response 路由、重启后 24h active run 恢复。
5. **手动验证**：人工添加 old/new/context 评论；reviewer 添加评论；fixer 修复；verification reviewer `fixed/dismissed`；中途退出重启；diff 行漂移后 stale；最后关闭评论立即删 JSONL。

## Follow-up

- 全量 Pi slash command inventory 投影到 Command Palette。
- 全文件 review 与任意源文件行评论。
- 导入/导出 Hunk comments（一次性转换，不做 live sync）。
- review 历史持久化与跨设备共享。当前设计刻意不做，避免把临时协作 artifact 变成另一套 issue tracker。
- 实施时更新 `ARCHITECTURE.md`：新增 review 子系统的 extension ownership、`~/.pi/tmp/reviews/` 的 owner-only 临时资源与 cleanup 生命周期、Pi session fork（非 Git branch）边界，以及 Review Diff 页的验证契约。
