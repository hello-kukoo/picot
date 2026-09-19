# @ 提及路径语义与搜索根设计

**状态：** Approved — 2026-09-19 Dr. Lin 拍板（含评审修订 v2 与三个待确认项：
① Windows `..` 取 (a) 维持现状 + 文档说明；② UNC 不可达在菜单空态区渲染一行
错误；③ `truncated` 仅保留数据字段不加 UI）。实施中（第一步：契约 A + 对齐清单）。
**日期：** 2026-09-19
**演化关系：** 扩展并部分取代 `docs/superpowers/specs/2026-07-25-at-file-mention-design.md`。
07-25 的「路径语法与根」表格仍是本 spec 的目标语法；但其实现层描述属于
embedded-server 时代（`/api/file-mentions`），且其中「插入绝对路径」的读法与
native upstream 参考实现相反，以本 spec 为准。

## 问题

在 composer 用 `@` 选中文件后，插入的是绝对路径（`@/Users/linyong/tmp/PI/picot-v3/public/app.js`）。
Pi TUI 插入的是相对当前 cwd 的路径（`@public/app.js`）。

成因是三处事实叠加：

1. **07-25 spec 要求的是相对形式。** 原文：「Their output preserves the visible form
   rather than replacing it with an absolute filesystem path.」，表格给出
   `@foo` → `@src/foo.ts`。
2. **native upstream 参考实现插入的也是相对形式。**
   `~/tmp/PI/picot/public/ui/at-file-mention.js:300` 的 `buildAtMentionValue(relativePath, …)`
   注释写明「mirroring the Rust `build_file_mention_candidate` (host_data.rs)」。
3. **v3 迁移时 Rust 侧 candidate 构造被删、前端补拼 workspace root。**
   `public/ui/at-file-mention.js:82` 用 live workspace root 把 host 返回的
   workspace 相对路径重新绝对化。

`.memory/MEMORY.md` 07-25 条目的措辞（「@ 文件引用对齐 Pi TUI 完整路径语义」）把
spec 的「**接受** `@/`、`@~/`、`@../` 输入形式」误写为「插入完整路径」，是本次
走偏的直接诱因，已在本轮修正。

## 已验证事实

| 事实 | 证据 |
| --- | --- |
| Pi core **没有** `@` 展开机制（`expandMentions`/`fileMention` 全量搜索零命中）；`@path` 只是模型看到的纯文本 | `@earendil-works/pi-coding-agent/dist` 全量搜索 |
| 解析发生在模型调用 `read` 时：`resolveToCwd(path, cwd)` → `normalizePath`：剥 `@` 前缀、展开 `~`、绝对路径直用、否则相对 cwd 拼接 | `dist/core/tools/path-utils.js`、`dist/utils/paths.js` |
| 因此根语法**只影响搜索**，不影响解析：四种形式 Pi 都能读到 | 同上 |
| primary runtime 的 spawn cwd = canonical 注册 workspace root | spawn 路径以 `native_launch_spec_for(static_dir, runtime_type, cwd, …)` 的 `cwd`（= 注册 workspace root）落地（`pi_launch.rs`）；数值行号随代码漂移，以函数为锚 |
| Pi TUI 用 cwd 相对：`basePath = sessionManager.getCwd()`，`fd --base-directory <root>` 输出相对路径并原样进 `value` | `pi-tui/dist/autocomplete.js:100,585`；本机实测 `fd --base-directory <root>` 输出 `AGENTS.md`、`src-tauri/src/git_service.rs` |
| upstream 显式**拒绝** `@/` 与任何 `..` 组件（`InvalidMentionQuery`） | `~/tmp/PI/picot/src-tauri/src/host_data.rs:526` |
| upstream `@~/` 无展开：`safe_join(root, "~/…")` 失败 → 静默返回空列表 | 同上 |
| v3 丢失 upstream 的 `IGNORED_MENTION_DIRS`、作用域 base + fuzzy 拆分、`truncated` 标志、Rust candidate 构造 | v3 `src-tauri/src/host_data.rs` 中 `IGNORED`、`rsplit_once`、`truncated` 零命中 |

## 目标

1. **恢复 upstream 语义**（相对插入 + 被丢掉的行为），使 v3 与参考实现一致。
2. **在此之上扩展搜索根**，使 `@./`、`@../`、`@~/`、`@/`(POSIX)、Windows
   `@C:/`、`@//server/share/` 可用，对齐 07-25 spec 的语法表格。

第 2 项是**有意背离 upstream**（upstream 用守卫禁止它）。裸 `@` 的首层列举
特例（契约 B）是第二处。按 `AGENTS.md`，这类改动必须在本文档与
`ARCHITECTURE.md` 中显式标记，防止后续 agent 以「对齐 upstream」为名删除。

## 非目标

- 不新增设置开关、不新增环境变量、不引入新 crate 依赖。
- 不做敏感路径过滤（`.ssh`/`.aws`/`auth.json` 照常出现，与 TUI 一致）。
- 不改文件**读写**的 containment（`safe_join` 与 workspace 根限制不变）；本次
  只改变「列举」范围。
- 不做盘符**列表**形式（07-25 表格里没有 `@C:` 这类「列出所有盘符」的输入）。
- 不隐藏 `truncated` 之外的 UI 变更；不新增 composer 交互。

## 契约 A — 插入形式（第一步）

`build_file_mention_candidate` 回到 Rust 侧，前端不再拼 root。

| 位置 | 变化 |
| --- | --- |
| `src-tauri/src/host_data.rs` | 恢复 upstream 的 `FileMentionCandidate { value, label, description, is_directory }` 构造与 `is_quoted_display` 判定 |
| `public/ui/at-file-mention.js:82` | 删除 `` `${root}/${entry.relativePath}` `` 拼接；`value` 直用 host 返回值 |
| `public/ui/at-file-mention.js:56` | `buildMentionCandidate` 的注释「Mirrors the Pi TUI `@<absolute-path>` semantics」为错误陈述，必须改写 |

- 插入值 = 用户输入形式的延续：`@foo` → `@src/foo.ts`；`@./foo` → `@./foo.ts`；
  `@../foo` → `@../shared/foo.ts`；`@~/foo` → `@~/Documents/foo.ts`；
  `@/foo` → `@/usr/local/foo.ts`。
- 目录保留尾 `/`；含空格的路径用 `@"…"` 包裹（沿用 upstream `needs_quotes` 判定）。
- **description = 插入 token 的可见形式**（去尾部 `/` 与引号）。`@foo` 显示
  `src/foo.ts`；`@/foo` 显示 `/usr/local/foo.ts`。与 TUI 的 `displayPath` 同构。
- `label` 仍为 basename（目录加 `/`）。

## 契约 B — 路径语法与搜索根（第二步）

| 输入形式 | 搜索根 | 插入/显示形式 |
| --- | --- | --- |
| `@foo` | workspace root（递归，深度上限见契约 C） | `@src/foo.ts` |
| `@src/foo` | workspace root 下的 `src/` | `@src/foo.ts` |
| `@./foo` | workspace root | `@./foo.ts` |
| `@../foo` | workspace 父目录 | `@../shared/foo.ts` |
| `@~/foo` | 宿主进程用户 home（`~` 由 host 展开，浏览器 JS 永不展开） | `@~/Documents/foo.ts` |
| `@/foo`（仅 POSIX） | 文件系统根 | `@/usr/local/foo.ts` |
| `@C:/foo`（Windows） | 具名盘符根 | `@C:/Users/name/foo.ts` |
| `@//server/share/foo`（Windows） | 具名 UNC 共享根 | `@//server/share/foo.ts` |
| `@"my folder/f"` | 上述任一对应根 | `@"my folder/file.ts"` |
| 裸 `@`（空 needle） | workspace root **首层列举**（v3 特例，见下） | 首层条目 |

裸 `@`（空 needle）**保留 v3 现行特例**：立即按名序列出 workspace 根第一层
（跳过点条目，现有测试 `file_mentions_bare_query_lists_workspace_root_first_level`
继续有效）。这是**第二处有意的 upstream 背离**：upstream 空 needle 走递归评分，
首屏结果不可预期；v3 的首层列举是已交付 affordance，打 `@` 即见文件。upstream
作用域拆分（display_base/fuzzy）只作用于**非空 needle**。

作用域目录不存在（如 `@src/` 而 `src/` 不存在）→ **空结果，非错误**（与
「合法但无匹配」同一行）。

平台规则：

- 路径输出在任何平台都用 `/` 分隔（`\` 先归一为 `/`）。
- Windows 裸 `@/` 非法 → `invalidMentionQuery`（Windows 无单一文件系统根）。
  `@C:/` 与 `@//server/share/` 必须显式命名盘符或共享。
- 不实现盘符列表形式；`@C:/` 只校验该盘可达（带超时的探测）。

## 契约 C — 遍历策略与预算

沿用 upstream 的纪律，不引入 `ignore` crate：

- 跳过以 `.` 开头的隐藏文件与目录（`_` 前缀不豁免）。
- 跳过 `IGNORED_MENTION_DIRS`：`.git`、`node_modules`、`dist`、`build`、
  `target`、`.next`、`.nuxt`、`.cache`、`coverage`、`.venv`、`venv`、
  `__pycache__`（照抄 upstream 表，见 `~/tmp/PI/picot/src-tauri/src/host_data.rs:2253`）。
- 深度上限 **4**（相对搜索根）。
- 预算：visited ≤ 10_000、collected ≤ 200、返回 ≤ 20、时间预算 500ms。宽根
  （`@/`、`@~/`）下该预算远比 workspace 根更易触发 `truncated`——这是设计内
  行为，与待确认项 3 同节奏观察。
- 保留 `truncated: bool` 数据字段（upstream 语义）；本轮前端不新增 UI。
- 网络路径（UNC、映射盘）**2s 硬超时**；超时不得阻塞请求线程。
- 递归下钻必须校验子路径仍落在声明的搜索根内（对齐 upstream 的
  `path.starts_with(self.root)` 守卫）。

## 契约 D — 守卫与授权

**守卫（保留 upstream，仅对显式根前缀开窄口）：**

- query 必须以 `@` 开头（前端传入的即为含 `@` 的原始 token）；NUL 拒绝。
- 引号规则**镜像 upstream 的容忍语义**（`strip_suffix('"').unwrap_or(rest)`）：
  词首 `"` 进入 quoted 模式，**未闭合的开启引号被容忍**——正在输入的
  `@"my fold` 每个按键都是合法 query（前端 quote-aware 解析此时仍保持 token
  活跃并发送）；孤立的闭合引号不特殊处理，自然进入 needle。不得发明
  「必须成对」的更严规则：那会让带空格路径在闭合引号前逐键报错。
- `..` 组件：仅在用户**显式输入** `@../` 前缀时合法；`@foo/../../etc` 这类
  词中穿越仍然拒绝。前缀规则允许多级（`@../../foo` 合法，根 = 逐级上溯的
  目录）；POSIX 上多级上溯至 `/` 等价于合法的 `@/`，Windows 落到盘符根的
  不一致由待确认项 1 处理。
- 解析后的根必须精确落在被声明的根上，不得经由符号链接逃逸（canonicalize 后校验）。

**授权（分级）：**

- 帧形状在现有 `workspaceId` 之外增加 `root` 声明字段：
  `{ kind: "workspace" | "home" | "absolute" | "drive" | "unc", value: string }`。
- host 是唯一权威：由 query 前缀解析出 kind+value；帧内 `root` 必须与解析结果
  完全一致，否则 `invalidMentionQuery`。声明字段用于审计与防误用，不构成第二
  来源。
- `kind: "workspace"` 沿用现状：必须等于 `workspaceId` 的注册根。
- 其余 kind：仍需 `current_registered_context` 且 `ctx.workspace_id == frame.workspaceId`
  全等（`host_server.rs:2690-2698` 现有门禁），不新增放行面。
- 不向 LAN/移动端开放：`file_mentions` 保持 desktop capability 专属的数据 op。
- landing owner 仍被 `current_registered_context` 拒绝（无行为变化）。

## 契约 E — error 语义

今天 `@/`、`@../`、`@~/` 在 v3 被当作子串 needle，**静默返回空列表**，与「无匹配」
无法区分。改后：

| 情况 | 行为 |
| --- | --- |
| 非法语法（NUL、词中 `..`、quote 不成对、Windows 裸 `@/`、root 声明不符） | `invalidMentionQuery`（显式错误，沿用 upstream 码） |
| 搜索根不存在/不可达（UNC 超时、盘符不存在） | 显式错误 `mentionRootUnavailable`；前端显示可达性错误，不显示「无匹配」 |
| 合法但无匹配 | 空列表 + 正常空态 |

## 第一步的 upstream 对齐清单

按 upstream 参考实现逐项恢复（每项都要有测试）：

1. Rust 侧 `build_file_mention_candidate` 与 `is_quoted_display`。
2. `InvalidMentionQuery` 守卫（`@` 前缀、NUL、`/` 与 `..` 组件）。
3. `IGNORED_MENTION_DIRS` 过滤。
4. 作用域拆分：`display_base`（目录前缀）与 `fuzzy`（末段）分离，只走该子树。
   **空 needle 不走递归评分**：保留 v3 裸 `@` 首层列举特例（见契约 B），其
   现有测试不删。
5. 评分 `score_mention`、排序、上限 200/10k、`truncated` 上报、返回 20。
6. 递归下钻的 `path.starts_with(root)` 守卫；`safe_join` containment 不变。
7. 前端删除绝对化拼接；改写错误注释；`value` 直用。

## 部署顺序与回滚

1. **契约 A + upstream 对齐清单**：行为等价于 upstream，可独立验证与回滚。
2. **契约 B–E（宽根）**：在 1 之上加语法、root 分级、预算与 Windows 行为。
3. **ARCHITECTURE.md 修订**：containment 章节区分「列举」与「读写」；授权章节
   补 `root` 分级表。按 `AGENTS.md`，跨平台路径与安全边界变更必须同步。

两步各自独立提交、独立回滚（revert commit）。不新增开关来「软回滚」：按
`AGENTS.md`，引入 upstream 没有的开关本身就是走偏信号。

## 验证

**Rust（`host_data` 单测，TDD 先行）：**

- 语法表逐行：`@foo`、`@src/foo`、`@./foo`、`@../foo`、`@~/foo`、`@/foo`、
  `@C:/foo`、`@//server/share/foo`、`@"my folder/f"` 各自解析出正确根与可见形式。
- 守卫矩阵：无 `@` 前缀、NUL、词中 `..`、quote 不成对、Windows 裸 `@/`、
  root 声明与解析不符 → `invalidMentionQuery`。
- 遍历：`IGNORED` 目录被跳过、隐藏项被跳过、深度 4 截止、visited/collected/
  时间预算触发 `truncated`、子路径逃逸被拒。
- candidate 构造：相对 `value`、目录尾 `/`、含空格加引号、description 同形。
- 不可达根：UNC/盘符探测超时返回显式错误（用可控的假根，不依赖真实网络）。

**前端（`public/ui/at-file-mention.test.js`）：**

- 不再出现 workspace root 拼接；`value` 直用；`@./`、`@../`、`@~/` 原样透传。
- description 显示可见形式而非绝对路径（推翻现有
  `expect(buildMentionCandidate("/repo/src/a.ts", …)).toMatchObject({ value: "@/repo/src/a.ts" })`
  这类断言）。

**手工 e2e（框架覆盖不到）：**

- workspace 内选文件 → 插入 `@public/app.js`，发送后 Pi 能读到。
- `@~/Documents/` 列出 home 下游条目；`@/usr/local/` 列出根下游条目。
- UNC 断网：2s 内返回显式错误，UI 不卡。
- Windows：裸 `@/` 报错；`@C:/` 可用。
- 已存在的旧对话（含绝对 `@` token）仍正常：Pi 接受绝对路径，无需迁移。

**验收缺口（诚实标注）：** 当前只有 macOS 环境，Windows drive/UNC 与 2s 超时
无法自动化 e2e，只能靠 Rust 单测 + 手工清单；需在发布前于 Windows 机器走查。

## 风险

1. **containment 语义分裂。** 搜索可越出 workspace，文件读写仍受
   containment 限制。`ARCHITECTURE.md` 必须明写这条分界，否则这是未记录的边界
   松动。这是本 spec 最大的架构影响。
2. **密钥暴露（已决定保持 parity）。** 用户可从 `@~/` 选中
   `~/.pi/agent/auth.json`、`~/.ssh/*`、`~/.aws/*` 并发送给模型。这是同机同用户
   的显式意图，与 TUI 一致；但不做任何过滤意味着没有兜底。此风险在批准时即被
   接受。
3. **记忆措辞致实现漂移。** 本次走偏源于 `.memory` 条目与 spec 表格的语义错位；
   已在 `.memory` 修正，并作为教训记录。
4. **Windows 无自动化覆盖。** 见验收缺口。
5. **深度 4 的召回损失。** 深层嵌套项目（如 `packages/a/src/components/ui/x.tsx`）
   在宽根下搜不到；如需可调，应属独立决策，不悄悄放宽。

## 已决事项（2026-09-19 Dr. Lin 确认，均取推荐项）

1. **Windows 上 `@../` 与「裸 `@/` 非法」的一致性。** 允许 `@../../..` 时，
   多级 `..` 在 Windows 上最终会落到盘符根（`C:\..` → `C:\`），与「裸 `@/`
   非法」形成不一致。可选：(a) 维持现状（裸 `@/` 非法，多级 `..` 合法，承认
   不一致）；(b) Windows 也允许 `@/`，语义为「由盘符 API 列出所有盘符」；
   (c) Windows 上把 `..` 限制在不超过盘符根一代。**倾向 (a) + 文档说明**，因为
   (b) 会引入新语法形式，(c) 的规则难以向用户解释。
2. **UNC 不可达的 UI 形态。** 契约 E 选择显式错误 `mentionRootUnavailable`
   （而非静默空态）。需要确认前端展示方式：复用现有菜单空态区渲染一行错误，
   还是复用 `errors.*` 的消息通道。
3. **`truncated` 是否要 UI → 已决：不加。** 只保留数据字段；若宽根下经常
   触发，菜单底部提示属后续独立决策。

**实施记录：** 两步均已实施并通过验证（2026-09-19）。
第一步（契约 A + 对齐清单 1–7）：Rust `search_file_mentions`（守卫/引号容忍/
作用域拆分/IGNORED/评分/Rust 侧 candidate/预算+深度+时限，裸 `@` 保留 v3
首层特例）、`file_mentions` op 改 `{items, truncated}` 线形、前端删除绝对化。
第二步（契约 B–E）：`classify_mention_body` 根分类（workspace/home/absolute/
drive/unc + 父级链 + 全分支词中 `..` 守卫）、`root` 声明强校验（帧缺失即拒）、
drive/UNC 2s 探测（线程 + 超时，不阻塞请求线程）、walk containment 改按搜索根
并跳过不可读目录（宽根下系统目录不可读是常态）、`mention_root_unavailable`
错误映射、前端 `classifyMentionRoot` 镜像（Windows 判定取 `/Windows/` 大小写
敏感——`/win/i` 会匹配 macOS "darwin"）与菜单空态区错误行（决策 ②）。测试：
Rust 401 单测全绿（含宽根/声明/守卫矩阵），前端 30 项（分类器矩阵 + 契约 E
错误行），全量 1866/0。Windows drive/UNC 走人工清单（spec 验收缺口）。

## 影响面

| 文件 | 变化 |
| --- | --- |
| `src-tauri/src/host_data.rs` | candidate 构造回归 Rust；恢复 IGNORED/作用域/truncated/守卫；新增根解析与分级；新增错误码 |
| `src-tauri/src/host_server.rs` | `file_mentions` 分支增加 `root` 声明校验与错误映射 |
| `public/ui/at-file-mention.js` | 删除绝对化；改写错误注释；description 规则。**约束：不得破坏 2026-09-16 composer spec 刚落地的 C1 router 契约**（`resolveAtMentionToken` 纯解析、router 模式的 `isOpen/handleKeydown/update(trigger)`、quote-aware 空格容忍——宽根前缀 `@..`、`@~` 在该解析下本就是合法 token，无需放宽） |
| `public/app/transport.js` | `fileMentions(query)` 增加 root 声明参数 |
| `public/ui/at-file-mention.test.js` | 断言反转（绝对 → 相对） |
| `public/locales/{en,zh,ja,es}.json` | 新增可达性错误文案（`mentionRootUnavailable`，菜单空态区一行）与 `invalidMentionQuery` 文案（第二步随契约 E） |
| `ARCHITECTURE.md` | containment 分界、授权分级表 |
