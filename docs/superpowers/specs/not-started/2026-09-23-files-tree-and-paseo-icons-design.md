# Files 面板：树形导航、Paseo 图标与受限文件操作

**状态：** Approved — 2026-09-23 Dr. Lin 拍板，待实施  
**范围：** Picot 右侧 Files 面板（树形导航、工具条、右键菜单、拖拽），以及 Files 与 Git 面板共用的文件图标解析。File Preview tab 共用同一个 `createFileTypeIcon()`，会同步换图标——该连带影响已拍板接受。  
**参照：** Paseo `packages/app/src/components/file-explorer-pane.tsx`、`file-explorer/tree.ts`、`components/material-file-icons.ts`、`components/file-icon-svg.ts`。  
**不在范围：** 搜索、排序、Git 状态、文件监视器、递归全量扫描、回收站、批量操作、拖放到外部应用、目录图标更换（Paseo 的图标表里没有目录图标）。

## 1. 目标

将 Picot Files 从单层目录浏览器改为真正的懒加载树，同时使用 Paseo Files panel 的文件图标语言。保持现有「文件预览」「拖入 composer 生成 @ 引用」「显示隐藏文件」「刷新」「在文件管理器中打开」能力。

用户动作：

- 点目录：原地展开/收起；不再进入目录再按「返回上级」。
- 点文件：保持当前预览行为。
- 拖文件或目录到 composer：插入 workspace 相对的 `@` 引用。
- 文件/目录右键：执行安全、单项的创建、重命名、删除、复制路径与添加到聊天。

## 2. 已验证事实

| 事实 | 证据 |
| --- | --- |
| Picot 当前仅维护 `currentPath`；目录点击调用 `load(path)`，返回依赖 `#file-sidebar-up` | `public/workspace/file-browser.js` |
| Host 已能列任意受权 workspace 子目录：`list_files(workspace_id, relative_path)`，目录优先、名称排序，且 `safe_join` 保证路径不越 root | `src-tauri/src/host_data.rs::list_files` |
| Picot 已有文件读写数据面：`file_read` / `file_write`；写操作使用 `operation_scope(..., "workspace-files")` 与 mutation registry、idempotency key | `src-tauri/src/host_server.rs` |
| 当前 custom mouse drag 只允许文件；`toMentionPath` 本身可计算任意 workspace 内路径 | `public/workspace/file-browser.js::onItemMouseDown/toMentionPath` |
| Paseo 用 `directories: Map<path, ExplorerDirectory>` + `expandedPaths: Set<path>`，只在展开时取 listing，flatten 成 `{entry, depth}` 行 | `paseo/.../file-explorer/tree.ts` |
| Paseo 按 workspace 持久化 expanded paths，恢复时最多递归请求 5 层 | `MAX_AUTO_EXPANDED_DIRECTORY_DEPTH = 5` |
| Paseo 图标来自 MIT `vscode-material-icon-theme`；53 个 SVG/扩展映射，显示前统一以 `ICON_CHROMA = 0.65` 降饱和 | `paseo/.../material-file-icons.ts`、`file-icon-svg.ts`、`docs/file-icons.md` |
| Picot 已使用同一 MIT 上游，但只有 21 个 Picot 自绘简化图标 | `public/file-type-icons.js`、`public/icons/material-file-theme/SOURCE.md` |

## 3. 拍板决策

1. Files 改为懒加载树；展开状态按 workspace 持久化，恢复上限 5 层。
2. 删除「返回上级」按钮。树中此导航语义冗余。
3. 工具条加入 **新建文件**、**新建文件夹**。
4. 加入单项右键文件操作：创建、重命名、删除、复制路径、添加到 composer；保留原生打开/预览能力。
5. 保留拖到 composer，**目录同样支持**。
6. 图标改用 Paseo Files 的 53 项 Material 图标表与统一降饱和规则；不增加 npm/Bun 运行时依赖，不加载远程资源。找不到类型的文件（未知扩展名、无扩展名、表内无对应项）统一落到 Paseo `_default` 通用文件图标；目录图标不换。

## 4. 前端树模型

### 4.1 状态

`FileBrowser` 以 workspace-relative POSIX 路径为唯一键。root 就是 workspace root，也就是 cwd，写作 `"."`；这个 `"."` 与 host `file_create` 的 `parentPath`、`list_files` 的 `relative_path` 同义。

```js
{
  workspaceRoot,
  directoryListings: Map<relativePath, { entries, loadedAtMs }>,
  expandedPaths: Set<relativePath>,
  selectedPath: relativePath | null,
  pendingListingPaths: Set<relativePath>,
  pendingEdit: null | { kind: "create-file" | "create-folder" | "rename", parentPath?, path? }
}
```

- **不做递归扫描。** 首次只请求 root；用户展开目录才请求该目录。已缓存 listing 重开不再请求，刷新才重取。
- 单一纯函数 `flattenFileTree(directoryListings, expandedPaths, showHidden)` 输出 preorder 行 `{ entry, depth, expanded, loading }`。目录优先、名字排序沿用 host 当前语义。
- `selectedPath` 与 `expandedPaths` 分离：目录被选中不等于展开，文件被选中不等于当前预览失效。
- workspace 切换或 workspace generation 变更时，先废弃未完成请求（现有 `loadSequence` 语义保留），清空内存 cache 与该 workspace 的 persisted expanded paths，再走初始化流程。

### 4.2 展开状态持久化

- 只存浏览器本地缓存：`localStorage`，key 按 canonical workspace root 分区，值仅存去重后的 relative directory path 数组。不引入 DB、IndexedDB，也不让 host 存这份状态。
- root 永远视为展开，不写入持久化状态。
- **写入即裁剪到 5 层**：深度 >5 的目录 path 不写入存储。用户仍可展开到任意深度，只是重启后不自动恢复。写入与恢复共用同一个上限，避免「存了但永远不恢复」的静默丢弃。深度从 root 起算：root 是深度 0，root 的直接子目录是深度 1。
- 恢复：先请求 root；只对 persisted path 的祖先已加载且仍是目录者继续请求；最大深度 5。不存在/无权限/变成文件的路径从存储中剔除。
- 折叠目录只移除该目录及其全部后代的 expanded 标记；listing cache 留在内存，重新展开无需 I/O。

### 4.3 行交互与可访问性

| 行 | 单击 | 双击 | 拖至 composer |
| --- | --- | --- | --- |
| 目录 | 选择 + 展开/收起 | 无额外动作 | 插入 `@relative/path/` |
| 文件 | 选择 + 既有 preview | 保持既有原生 app 打开 | 插入 `@relative/path` |

- 目录在名称前有 16px disclosure chevron；展开时旋转 90°，加载时显示小 spinner。
- 每层缩进 12px；行起始 12px；行图标 16px——对齐 Paseo tree primitives。
- 键盘：目录行 `Enter`/`Space` 展开，左右箭头收起/展开；文件行 `Enter` 开预览。焦点与 `aria-expanded` / `aria-selected` 必须同步。
- 现有 WKWebView custom mousedown drag 保留；放开目录排除条件。4px 位移阈值内释放仍走单击（目录选择+展开）；超过阈值才视为 drag，命中 composer 插入引用并阻止后续 click。目录引用强制尾随 `/`，让 Pi 原生补全/文件提及语义明确为目录。

## 5. 工具条与右键菜单

### 5.1 工具条

Files tab 激活时，工具条顺序：

```text
新建文件 | 新建文件夹 | 刷新 | 显示/隐藏文件 | 在文件管理器中打开 | 关闭
```

- 移除 `file-sidebar-up` DOM、事件绑定、icon 与 locale 文案。
- 新建文件/文件夹默认创建于 root；若选中目录，默认创建于该目录。
- 创建/重命名在树内显示单行 input；Enter 提交，Escape/空名取消，blur 提交。新建成功后刷新父目录，并自动选中新文件；新建目录后保持父目录展开。
- 当没有 Registered workspace、mutation 正在提交、或 host 未声明写操作可用时，新建按钮 disabled 并给出诚实 tooltip。

### 5.2 右键菜单

| 目标 | 操作 |
| --- | --- |
| 文件 | 预览、在系统应用打开、添加到 composer、复制相对路径、复制绝对路径、重命名、删除 |
| 目录 | 展开/收起、添加到 composer、复制相对路径、复制绝对路径、在文件管理器显示、新建文件、新建文件夹、重命名、删除 |
| 空白区 | 新建文件、新建文件夹、刷新 |

菜单只暴露 host 明确支持的操作；失败统一 toast，不在 UI 拼接 host 细节。

## 6. Host 文件变更契约

### 6.1 新操作

在既有 `file_write` 同一条 host 控制数据面新增三条显式操作；不造通用 shell / 任意路径 API：

| operation | 输入 | 成功结果 | 行为 |
| --- | --- | --- | --- |
| `file_create` | `parentPath`, `name`, `kind: "file"\|"directory"`, `idempotencyKey` | `relativePath`, `kind` | 创建新空文件或空目录；目标必须不存在 |
| `file_rename` | `path`, `name`, `idempotencyKey` | `relativePath` | 同父目录内改名；目标必须不存在 |
| `file_delete` | `path`, `idempotencyKey` | `deletedPath` | 删除文件或**空目录** |

每项都：

- 只允许 Registered desktop owner 的当前 workspace；走 `operation_scope(context, "workspace-files")` 与既有 mutation registry。
- 用 workspace root + `safe_join` 解析每个 path；拒绝绝对路径、`..`、NUL、空名、含 `/` 或 `\\` 的 name、跨 workspace path。
- `file_create` 的 `parentPath` 允许 `"."`（= workspace root，即 cwd），新建默认落在这里；`file_rename` / `file_delete` 的 `path` 拒绝 `"."` 或任何解析后等于 workspace root 的值。
- `file_create` 用 `create_new`；绝不覆盖已有文件。
- `file_rename` 只接受 basename，防止它兼作 move API。
- `file_delete` 目录仅 `remove_dir`：非空返回 `directory_not_empty`。**不递归删除、不回收站、不 undo。**这是安全边界和 YAGNI，不是一期缺口。
- 完成/重复完成均返回确定性结果；pending duplicate 保持既有 `duplicate_pending` 语义。

### 6.2 错误码与同步

闭集错误码：`invalid_path`、`invalid_name`、`not_found`、`already_exists`、`directory_not_empty`、`permission_denied`、`temporarily_unavailable`、`io_failed`、`duplicate_pending`。WebView 显示本地化通用文案；host 不回显绝对路径或 OS error。

`temporarily_unavailable`（仅 list 返回）：parent 路径或整个 workspace root 当前不可达——如外接磁盘未挂载、网络 share 暂时掉线。语义上不视作删除。前端应保留 listing cache 与 expanded 状态、不报错、不刷新预览 tab；state 显示为 stale + 重试提示。

**不可达判定：N = 3，计数单位是 root listing 失败次数，不带时间窗口。**

- 只有 root（`"."`）listing 返回 `temporarily_unavailable` 才让 `rootUnreachableStreak` +1。子目录 listing 失败只把该行标 stale + 就地重试，不计入。
- 任意一次 list 成功（root 或子目录）把计数归零。
- 计数到 3 才判定该 workspace 不可达：丢弃该 workspace 的 listing cache 与其持久化展开状态，界面显示 workspace 级重试。
- 不引入自动轮询或计时器。每次失败都来自一次显式动作（初始化、刷新、展开、重试点击），单次抖动会被随后一次成功归零。选 3 而不是 1，是因为单次 ENOENT 分不清「volume 掉线」和「一次瞬时 I/O 抖动」；选 3 而不是更多，是因为用户连点 3 次仍失败时，继续攥着缓存是不诚实的。
- `rootUnreachableStreak` 只存在内存，随 FileBrowser 实例销毁重置，不持久化。因此 stale 状态的出口必须是一个**可见的重试按钮**，不能只依赖工具条刷新——否则用户不点，计数永远不涨，workspace 不可达也永远不会被判定。

变更成功后 host 返回 canonical relative path。前端只失效受影响目录 listing：创建/删除失效 parent；重命名失效 parent；目录重命名额外移除 cache、expanded、selected 中该路径前缀的所有状态。无需全树 reload。

预览 tab 必须跟着路径走：

- 删除：关闭 FilePreviewPanel 中匹配路径的 tab，并清理 `file-tab-state.js` 的持久化项。
- 重命名文件：同目录改名、内容不变，所以不关 tab，而是把 FilePreviewPanel 与 `file-tab-state.js` 中匹配旧 path 的 tab 改写为新 path。
- 重命名目录：对匹配该前缀的每个 tab 改写前缀。

列表 mutation 路径解析同走 `safe_join`，但 ENOENT/ENOTCONN 等 transient 错误必须按 `temporarily_unavailable` 分类返回，不得当作权威删除信号——外接卷掉线不应让用户以为文件被改了。详见 §8 mount 抖动边界。

## 7. Paseo 图标迁移

### 7.1 来源与许可

- 将 Paseo `material-file-icons.ts` 的 53 项 SVG vocabulary 与 `EXTENSION_TO_ICON` 映射 vendor 到 Picot；它们来自 `vscode-material-icon-theme`（MIT），来源固定为 Paseo 当前 `material-icon-theme` 5.32.0 快照。
- **补录（2026-09-24 拍板）**：Paseo 的清单不含任何 office 字形，另从**同一** pin 的
  5.32.0 上游包 verbatim 拷 4 个——`pdf`、`word`、`powerpoint`、`table`——放进独立的
  `PICOT_FILE_ICON_SVG` / `PICOT_EXTENSION_TO_ICON` 块，Paseo 两个 verbatim 块保持原样可 diff。
  扩展映射照抄上游 `material-icons.json`：`pdf`；`doc`/`docx`/`odt`/`rtf`→`word`；
  `ppt`/`pptx`/`pptm`/`odp`→`powerpoint`；`xls`/`xlsx`/`xlsm`/`ods`/`csv`→`table`。
  上游没有 Excel 品牌字形（整个表格家族统一 `table`），跟随上游选择，不自造图形。
  `doc`/`docx`/`rtf`/`odt`/`ppt`/`pptx`/`odp`/`xls`/`xlsx`/`ods` 恰为 Picot anydoc office
  预览认的十种后缀。
- `SOURCE.md` 更新精确 source、版本（5.32.0）/快照日期、完整 MIT attribution；不从运行时下载图标。
- 替换范围是当前 21 项 Picot 自绘 icon 里的 17 项**文件**图标（含通用 `file`）。4 项目录图标（`folder`、`folder-open`、`folder-git`、`folder-git-open`）保留，因为 Paseo 的 53 项表里没有目录图标——它的目录用的是 lucide。不新增 package。

### 7.2 渲染

- 保留 Picot 单一 `createFileTypeIcon()` 调用面，供 Files、Git、Preview tab 继续共用。
- 内部换为 Paseo 的 filename → vendor SVG lookup；`isDirectory=true` 时短路 extension map，只按 expanded 选择独立 folder/folder-open 图标，目录名永不进入 extension lookup。
- 复制 Paseo 的统一 `ICON_CHROMA = 0.65` 规则：对 trusted inline SVG 的 hex fill 做一次缓存后降饱和；一个常量控制整套视觉密度。不得逐图调色。Picot 保留的 4 项目录图标同样过这条规则（`folder-git` 的 `#f1959b` 明显比 Paseo 图标饱和，不过规则就会在同一个面板里留下两种视觉密度）。
- 覆盖 Paseo 的 53 项扩展映射。
- **兜底**：未知扩展名、无扩展名、表内无对应项，一律落 Paseo `_default`（Material 通用 file 图标，`#90a4ae`）。它同时替换 Picot 现在自绘的 `file` 图标。
- Picot 已有的特殊名表保留，重指向 Paseo 表内已有的名字：`package.json` → `json`、lock files → `lock`、`Cargo.toml` → `toml`、`Dockerfile` / `tsconfig.json` / vite config → `settings`。`.env` 与 `.gitignore` 原本是自绘 `env`，Paseo 表内没有 env 项，**已拍板改指 `settings`**（保住「配置类」信号，且不发明表外图标）。

## 8. 不变量与安全

### 8.1 Mount / share 抖动边界

文件扫描目标与 shared project root 走 `read_dir` 时遇到的暂时性 ENOENT（含外接磁盘未挂载、网络 share 短暂掉线、APFS volume 未挂载）不得当作"项目被删除"。host 一律返回 `temporarily_unavailable`，前端保留 listing cache、保留展开状态、保留对应 preview tab，只显示 stale + 重试；只有同一 workspace root 连续 3 次 root listing 失败（判定见 §6.2）才允许把 cache 与展开状态算作过期。这一 reconcile 关键与 workspace registration 体系等价（workspace root 可达性必须先于内容判断）。

删除路径 ENOENT 同理不报错，返回 `not_found` + 前端继续失效受影响 listing 即可；不会与"用户改了另一份工作区"混淆，因为前端严格走相对路径授权。

### 8.2 一般不变量

- tree cache 不是文件系统权威；每次 list/mutation 都经 host workspace 授权和路径校验。
- 隐藏文件默认语义保持现有行为。切换显示隐藏文件只改变渲染和后续 lazy listing；不得把隐藏文件意外持久化为可见状态。
- 文件/目录拖入 composer 只插文本 `@` 引用，不读取内容、不扩大 Pi 对 workspace 之外的访问范围。
- 新 mutation 不接 LAN、relay、browser child webview 或 Pi runtime 直连；仍为 host 所有者数据面。
- 因新增 workspace 写操作与树形惰性 I/O，实施时更新 `ARCHITECTURE.md` 对文件数据面、授权和刷新契约的说明。

## 9. 测试计划

### 前端单元测试

- `flattenFileTree`：深度、preorder、目录优先、折叠后代不渲染、隐藏项过滤。
- 展开：首次展开只请求目标目录；二次展开命中 cache；并发展开不串路径；workspace 切换忽略旧响应。
- 持久化：每 workspace 隔离；恢复最多五层；缺失目录/文件替换路径自动清理；折叠删除后代 expanded 状态。
- 行：文件仍开 preview；目录不再导航 currentPath；键盘/ARIA；目录拖入插入 `@dir/`，文件仍插入 `@file`。
- inline create/rename：Enter、Escape、空名、失败、成功后的最小 cache invalidation。
- 菜单与工具条：root/选中目录默认 parent；`up` 不再存在；写操作 unavailable 时 disabled。
- 图标：代表性 53 项 extension + special names + generic fallback；缓存与 folder open/closed 状态。
- 兜底：未知扩展名、无扩展名、`.env` / `.gitignore` 分别落 `_default` / `settings`；目录名永不进入 extension lookup；目录图标与 Paseo 文件图标共用同一条降饱和规则。
- 不可达判定：root listing 连续失败 3 次才丢弃 cache 与持久化展开状态；中途一次成功归零；子目录失败不计数；`rootUnreachableStreak` 随 FileBrowser 销毁重置；stale 状态必须渲染出可点的重试按钮。
- 重命名：文件预览 tab 改写 path 而非关闭；目录重命名改写 tab path 前缀。

### Rust 单元测试

- create/rename/delete 的 Registered owner 与 workspace root 门禁。
- `..`、绝对路径、separator/name 注入、根删除、NUL、跨 workspace 均拒绝。
- create 不覆盖；rename 不跨父目录；delete 文件成功、空目录成功、非空目录拒绝。
- idempotency：accepted、duplicate pending、duplicate completed。
- 成功响应只含相对路径；错误响应不泄露 OS/绝对路径。

### 集成与回归

- 真 fixture：展开三层目录、刷新子目录、新建文件/文件夹、重命名、删除空目录，确认仅目标父 listing 变化。
- 将文件与目录都拖到 composer，确认 Pi 原生 `@` 语义与 workspace 边界不变。
- `bun run vitest run public/file-browser.test.js public/file-type-icons.test.js` → `bun run check` → `bun run check:rust` → `bun run test`。

## 10. 验收条件

- Files 同屏展示任意展开深度的目录树；不再有返回上级按钮，也不因展开触发全目录扫描。
- 重启/切换 workspace 后只恢复该 workspace 上次展开的目录，最多五层。
- 新建文件、新建文件夹、重命名、删除文件/空目录及右键菜单完整工作；路径永不越 workspace root。
- 文件和目录均可拖入 composer，分别生成无歧义的 `@file` / `@directory/` 相对引用。
- Files 与 Git 使用同一套 Paseo Material 图标解析（Preview tab 因共用解析器同步生效）；未知类型有通用图标兜底；无网络图标请求、无新增运行时依赖。
- 重命名文件后，已打开的预览 tab 指向新路径，不丢失、不报错。
