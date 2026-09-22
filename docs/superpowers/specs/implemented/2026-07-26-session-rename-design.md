# Session Rename Design

## Goal

让 Picot sidebar 与 Pi TUI 对 session 名称使用同一持久化模型，并允许用户从任意 session row 的操作菜单重命名当前、历史或其他运行中实例所属的 session。

用户可见结果：

1. Pi TUI `/name`、`/resume` + Ctrl-R，以及 Picot 写入的自定义名称，都会在 sidebar 显示；
2. 同一个 session 在项目列表、Recent、Pinned、Archive 与搜索结果中的全部副本会显示同一名称；
3. 空白名称被拒绝，旧名称保持不变；
4. 新建 session 时的预设名称（`pi --mode rpc --name`）不属于本功能。

## Scope

### Included

- 用 Pi 无参 `SessionManager.listAll()` 作为 session 名称权威，同时保留 Picot 现有 JSONL catalog-policy 适配层；
- 新增受路径验证保护的任意 session rename HTTP 端点；
- 在每个 session row 的右键或更多操作菜单中提供 Rename；
- 更新项目列表、Recent、Pinned、Archive、搜索结果中的名称、搜索与错误状态；
- 中英文文案、单元测试、集成测试和架构文档更新。

### Excluded

- 新建 session 的名称输入 UI 或 `--name` 启动参数；
- 将空名称视为清除名称；
- 直接使用 `fs.appendFile` 操作 JSONL；
- 对其他运行中 Pi 实例强制广播其内存中的 `sessionName`；
- 通用 session metadata 编辑器或新的跨端口事件协议。

## Background and invariants

Pi 的 session 名称是 session JSONL 中追加式的 `session_info` 元数据。每次 rename 追加一条记录；`SessionManager.list()` 和 `listAll()` 按文件顺序扫描，最后一条 `session_info.name` 覆盖此前名称。Pi picker 显示 `session.name ?? session.firstMessage`。

Picot 当前的 `parseSessionFile()` 在取得首条用户消息后约 50 行即提前停止。这无法读到通常位于文件尾部的 rename 记录；固定大小的尾部采样也不可靠，因为 rename 后还可以追加任意长的对话。

因此，本功能的不可变约束是：

- Pi `SessionManager` 是 session 名称读写的唯一业务实现；
- `SessionInfo.name` 是 sidebar 的名称真相；
- Pi 的默认 agent root 与 embedded server 的 `PI_AGENT_ROOT` 必须相同；否则无参 `listAll()` 与 Picot 的路径验证会观察不同 session 树；
- 浏览器传入的文件路径永远不可信；
- rename 是 catalog mutation，必须使所有 mutation 前已发出的 catalog 请求永久失效。

## Architecture

### Session catalog

`src-tauri/src/pi_manager.rs` 的 `PiManager::spawn_with_spec_inner()` 是唯一的 Pi 启动注入点。它必须解析一个 agent root：非空的父进程 `PI_CODING_AGENT_DIR` 优先，否则使用 Picot 当前跨平台 home/app-data 解析策略。首次启动时先创建该目录，再 canonicalize，并对每个 Pi 子进程设置 `PI_CODING_AGENT_DIR=<canonical-agent-root>`。

`PI_CODING_AGENT_DIR` 是宿主保留变量；`PiSpawnSpec.environment` 不得提供或覆盖它。`spawn_with_spec_inner()` 在启动前发现该键时必须返回错误，并在应用其余 `spec.environment` 后由宿主写入 canonical 值。embedded server 的 `resolvePiAgentRoot()` 必须优先读取并规范化该环境变量，仅在非 Picot 启动场景下使用现有 fallback。启动与 extension 因而共享同一个 root，保证 Pi 的默认 `getSessionsDir()` 与 Picot 的 `PI_AGENT_ROOT/sessions` 相同。

`GET /api/sessions` 随后必须调用**无参** Pi API：

```ts
const infos = await SessionManager.listAll();
```

无参 `listAll()` 才会枚举默认 sessions root 下的每个项目目录；`listAll(SESSIONS_DIR)` 只扫描该目录直属 `.jsonl`，不能用于 Picot 的 `sessions/<project>/*.jsonl` 布局。

为避免改变现有 catalog 行为，服务端建立 canonical `info.path` → `SessionInfo` 映射，再将它与保留的轻量 catalog-policy 适配层合并。该适配层继续负责：

- 现有的短暂 pipe session 过滤（无用户消息且极短的文件）；
- `firstMessage` 的 120 字截断；
- 现有 `timestamp`、`cwd`、项目分组与 live-instance 合并字段。

适配层不再解析或提供名称；每个保留 session 的 `name` 只能取自对应的 `SessionInfo.name`。这避免 Pi 的 `"(no messages)"` 占位符、完整长消息和临时 session 直接改变现有 sidebar 行为。

所有 sidebar 副本通过同一个 helper 生成标题：

```ts
getSessionDisplayTitle(session) =
  session.name || session.firstMessage || t("sidebar.emptySession");
```

服务端拒绝空名称，catalog-policy 层将缺失的 `firstMessage` 归一为 `null`，因此空 session 始终使用本地化兜底，不泄露 Pi 的 `"(no messages)"`。当前 `parseSessionFileCached()` 中的 `session_info` 解析与 50 行截断不再是名称权威来源。

### Rename service

新增独立端点，而不复用只能改当前 RPC session 的 `/api/rpc` `set_session_name`：

```http
POST /api/sessions/rename
Content-Type: application/json

{
  "filePath": "/absolute/path/to/session.jsonl",
  "name": "my-feature-work"
}
```

服务端对目标 session 的持久化遵循 Pi TUI 的实现：

```ts
const manager = SessionManager.open(canonicalSessionPath);
manager.appendSessionInfo(trimmedName);
```

foreground 优化必须读取单个、同 generation 发布的 active-session binding：

```ts
{ generation, api, sessionFile }
```

每个 `session_start` 同步发布 `api` 与 `ctx.sessionManager.getSessionFile()`；`session_shutdown` 只清理相同 generation 的 binding。rename 请求只读取一次 binding，再把 canonical target path 与该 binding 的 `sessionFile` 比较。匹配时调用该 binding 的 `api.setSessionName(trimmedName)`，使当前进程的内存状态与持久化名称同步。

不得分别读取 `getApi()` 与 `latestCtx`，因为两者可能来自不同 extension generation。若请求期间没有有效 binding，或目标不匹配，端点使用 `SessionManager.open(...).appendSessionInfo(...)`。这与 Pi picker 对任意 session 的操作一致，且不会使用 stale context。

成功响应：

```json
{
  "filePath": "/absolute/path/to/session.jsonl",
  "name": "my-feature-work"
}
```

`name` 是服务端 `trim()` 后实际写入的值。

## Security and error contract

`filePath` 是浏览器输入，rename 端点在写入前必须：

1. 在 route handler 与 JSON 解析之前，以共享的 8 KiB 有界读取语义处理 HTTP body：先拒绝超限 `Content-Length`，再按 UTF-8 字节数增量读取；一旦超过上限立即停止读取并返回 `413`。Node adapter 不得继续累计后续 chunk，Bun adapter 不得先调用无界 `req.text()`，必须流式读取并在超限时取消 reader；
2. 验证请求 JSON 是对象，且 `filePath` 与 `name` 均为 string；
3. 对名称执行 `trim()`；结果为空时返回 `400`，不写入；
4. 以 Unicode code points 计数，名称最多 200 个；超限返回 `400`，不写入；
5. 对 `SESSIONS_DIR` 与目标文件做 canonicalization，包括 realpath；
6. 要求目标为 `.jsonl`，且以真实路径 containment 验证其位于 session root 内；禁止仅使用字符串前缀；
7. 以本次**无参** `SessionManager.listAll()` 的结果确认目标是受管理的 Pi session；不在列表中返回 `404`；
8. 仅对通过验证的 canonical path 调用 `SessionManager.open()`。

v1 的文件系统威胁模型与 Pi TUI Ctrl-R 相同：上述 realpath 与 catalog 校验防止 LAN/浏览器提供的静态路径逃逸，并拒绝验证时已存在的 symlink 逃逸；它不承诺抵御恶意、同 OS 用户进程在验证后替换文件的 TOCTOU race。loopback endpoint 不授予该进程原本没有的文件权限。若未来需要该强度，必须由 Pi core 提供基于已验证目录句柄、禁止跟随链接的原子追加 API；这不属于本功能。

错误语义：

| 状态 | 条件 | 前端行为 |
| --- | --- | --- |
| 200 | rename 已持久化 | 更新同路径副本并刷新 catalog |
| 400 | JSON、字段类型、非空或 200 code points 名称校验失败 | 保留输入和旧名称，显示可读错误 |
| 413 | 请求体超过 8 KiB | 保留输入和旧名称，显示请求过大 |
| 404 | 路径不是已列出的受管理 session | 保留输入和旧名称，显示目标不可用 |
| 500 | SessionManager 打开或追加失败 | 保留输入和旧名称，显示可重试错误 |

端点必须显式加入 `extensions/request-access.ts` 的 `LOOPBACK_ONLY_ROUTES`，并由 Node 与 Bun adapter 共用 `isLoopbackOnlyApiRequest()` 策略拦截。embedded server 监听 `0.0.0.0`；仅写“loopback-only”不会自动限制 LAN 写入，因此此登记是 LAN surface 只读不变量的一部分。端点沿用既有 JSON 错误响应格式。

## Sidebar interaction

### Entry point

每个 session row 的右键或更多操作菜单都有 Rename，覆盖：

- workspace 项目列表；
- Recent；
- Pinned；
- Archive；
- 搜索结果。

点击 Rename 必须阻止 row 的 session switch。所有入口传递同一个稳定标识：`filePath`。

### Editing state

- 点击 Rename 后，标题位置替换为行内文本输入；
- 初始值是 `session.name ?? ""`；不把 `firstMessage` 写入 value；
- 未命名 session 的 `firstMessage` 作为 placeholder；
- Enter 提交；Escape、取消或失焦取消；
- 客户端先 `trim()` 校验空白名称，失败时不发请求；服务端重复同一校验；
- 请求进行时禁用该输入和该 row 的 Rename 动作，防止重复 append；
- 当前未接线且调用 `/api/rpc` 的 `startRename()` 不得继续作为实现基础。

### Success, refresh, and failure

成功后，前端：

1. 在任何乐观更新前执行 `invalidateSessionLoads()`：将新增的单调字段 `loadInvalidatedThrough` 提升为当前 `loadSeq`；
2. `loadCommitted` 继续只表示“实际已渲染的最高 seq”，不得被 mutation 修改；`loadSessions()` 提交前必须同时拒绝 `seq <= loadInvalidatedThrough` 和 `seq < loadCommitted` 的响应；
3. 退出编辑态；
4. 在内存中按 `filePath` 更新所有可见副本的名称；
5. 调用新的 `loadSessions()` 取得 Pi 的权威 catalog，使排序、项目分组、Recent、Pinned、Archive 和其他并发写入收敛；
6. 新 load 的 seq 大于 `loadInvalidatedThrough`；它是唯一可提交的 rename 后 catalog。

失败时，前端保留编辑输入、旧 sidebar 数据和重试能力；不得静默吞掉 fetch 或服务端异常。

显示标题始终由 `getSessionDisplayTitle()` 生成。每个 session row 还保留独立、纯文本的规范化 `name` 与 `firstMessage` 搜索数据；本地搜索对任意非空查询（包括单字符）同时匹配两者，而不是只搜索已渲染标题。`/api/search` 保留至少两个字符的全文消息扫描门槛，并额外匹配最终名称与首条消息；扫描不得因取得三条消息命中而在读取文件尾部最新 `session_info` 之前提前结束。这样用户改名后仍能通过原任务内容定位 session。

## Concurrency and consistency

- Picot 不自行建立 JSONL 锁，不直接写文件；使用 Pi 的 SessionManager append 语义；
- 对同一 session 的并发 rename 按成功追加顺序决定最终名称：最后成功写入的 `session_info` 生效；
- 每次成功后重新读取 catalog，sidebar 最终与 Pi picker 收敛；
- 对其他运行中 Pi 实例，持久化名称与 sidebar 会立即正确；其独立进程的内存 `sessionName` 不在此功能中跨端口强制同步；
- session switch 会重载 extension context；foreground 优化只可使用同 generation 的 active-session binding，不能组合独立读取的 session-bound references。

## Performance

无参 `SessionManager.listAll()` 是名称正确性基线。该调用会完整扫描默认 session root 下各项目目录中的 JSONL；本功能不以 50 行截断或固定尾部采样替代它。

现有缓存保留为 catalog-policy 适配层的缓存，而非名称缓存。`/api/sessions` 仍在 embedded server 的异步请求路径执行，sidebar 在等待时遵循现有 loading/旧列表策略，不阻塞 WebView。实施前后都要针对同一 session catalog 记录 session 数量、冷启动一次耗时与连续三次 warm refresh 耗时，并将结果写入实现 PR/验证记录。若真实历史目录产生可感知退化，后续单独设计缓存层；缓存必须仍以 Pi 的完整扫描名称语义为权威，不能复制或简化 JSONL 的 `session_info` 解释规则。

## Tests

### Backend

1. 首次启动会先创建并 canonicalize agent root；Pi 子进程的保留变量 `PI_CODING_AGENT_DIR` 不能被 `PiSpawnSpec.environment` 覆盖，且与 embedded server 的 `PI_AGENT_ROOT` 相同；无参 `listAll()` 能发现 `sessions/<project>/*.jsonl`，而带根目录参数的调用不被使用；
2. 多条 `session_info` 中最后一条名称胜出；名称位于文件尾部、此前已有多条消息和搜索命中时仍正确读取；
3. 无名称时保持 Picot 的截断 `firstMessage` 与短暂 session 过滤，不泄露 Pi 的 `"(no messages)"` 占位符；
4. rename 历史 session 后，再次无参 `listAll()` 返回新名称；
5. 当前 foreground target 只使用同 generation 的 `{ api, sessionFile }` binding 的 set-name 路径；无有效 binding 时使用目标文件 append 路径；
6. 空白名称、超过 200 code points 的名称、错误 JSON 与字段类型错误返回 `400`；Node 与 Bun adapter 都在完整分配 body 前以 UTF-8 字节数拒绝超过 8 KiB 的请求并返回 `413`；
7. root 外路径、symlink 逃逸、同前缀目录、非 `.jsonl` 与未列出的文件均不能写入；
8. `POST /api/sessions/rename` 被 `isLoopbackOnlyApiRequest()` 标记为 loopback-only，并覆盖 Node 与 Bun adapter 对非 loopback 请求的拒绝；
9. 两个同路径 rename 并发完成后，`listAll()` 显示最后成功追加的名称；
10. `SessionManager.open()` 或 append 失败时返回 `500`，且不返回伪成功。

新增 `extensions/embedded-server-session-rename.test.ts`，复用 `extensions/embedded-server-session-delete.test.ts` 的临时目录、路径 containment 与 live-instance 测试模式；访问边界复用 `extensions/request-access.test.ts` 的共享 Node/Bun access-policy 测试模式。

### Frontend

1. 所有 row 变体通过 `getSessionDisplayTitle()` 渲染 `name || firstMessage || t("sidebar.emptySession")`，且名称以安全纯文本渲染；
2. 所有 Rename 菜单入口将对应 `filePath` 发给新端点，且不触发 session switch；测试同时断言不新增新建名称控件，且 Pi spawn 参数中没有 `--name`；
3. Enter 保存；Escape、取消和失焦不写入；空白输入显示校验错误；
4. rename 成功时 `loadInvalidatedThrough` 会使所有 `seq <= barrier` 的 rename 前请求不能提交；只有 barrier 后的 refresh 可替换乐观名称，且 `loadCommitted` 仍只记录实际渲染；
5. 成功后所有相同 `filePath` 副本更新，后续 catalog refresh 保留该名称；
6. `400`、`413`、`404` 与 `500` 分别显示本地化可读错误；每种失败都保留输入和旧名称，且 `500` 可重试；
7. 本地搜索对单字符及更长查询都分别匹配自定义名称与原始 `firstMessage`；`/api/search` 对至少两个字符的查询读取文件尾部的最终名称，不因消息命中上限提前结束；
8. pin、archive、focus、切换和 stale-load 既有行为保持通过。

新增 `public/session-sidebar-rename.test.js`，复用 `public/sidebar/build-session-item.test.js`、`public/session-sidebar-recent.test.js`、`public/workspace-projects.test.js`、`public/session-sidebar-pinned.test.js` 与 sidebar loading 测试模式。

### Validation commands

实施完成后至少运行：

```bash
bun run vitest run extensions/request-access.test.ts
bun run vitest run extensions/embedded-server-session-rename.test.ts
bun run vitest run public/sidebar/build-session-item.test.js
bun run vitest run public/session-sidebar-rename.test.js
bun run vitest run public/workspace-projects.test.js
bun run check
bun run check:rust
bun run test
```

并记录 session catalog 性能测量结果。

## Documentation changes

实施时更新：

- `ARCHITECTURE.md`：`PiManager::spawn_with_spec_inner()` 的 `PI_CODING_AGENT_DIR` 启动不变量、session catalog 的 Pi authority、rename HTTP 契约、LAN loopback 边界、路径验证、`loadInvalidatedThrough` mutation barrier 和最后写入胜出语义；
- `docs/session-naming.md`：移除“历史 session rename 不可行”与尾部采样建议，改为 SessionManager/TUI 方案；
- `ROADMAP.md`：移除或更新此前 deferred 的 session rename 项；
- `public/locales/en.json` 与 `public/locales/zh.json`：菜单、输入、校验和错误文案，并通过 i18n completeness 测试。

## Acceptance criteria

- Pi TUI 改名、Pi `/name`、Picot rename 均能在 sidebar refresh 后显示相同的最新名称；
- 首次启动可创建并 canonicalize agent root；宿主保留的 `PI_CODING_AGENT_DIR` 不可被 spawn environment 覆盖，且与 embedded `PI_AGENT_ROOT`、无参 `listAll()` 的 session tree 一致；
- 任意可列出的 session 都能从任意 sidebar 副本进入 Rename 并按 Pi TUI 同一同用户文件系统信任模型持久化；
- 任意不可信路径、空白或超长名称、超大请求体、非 loopback 请求或写入失败均不会改动目标 session；
- `seq <= loadInvalidatedThrough` 的 rename 前 catalog 请求不能覆盖 rename 成功后的乐观名称，而 `loadCommitted` 始终只表示实际已渲染的最高 seq；
- 同一 `filePath` 的项目、Recent、Pinned、Archive、搜索显示最终一致；单字符搜索仍可按原始 `firstMessage` 命中已改名 session；
- 未命名 session 使用本地化空标题兜底；session switch、pin、archive、focus、搜索和现有 session list 不回归；
- 前述验证命令通过，且记录性能测量结果。
