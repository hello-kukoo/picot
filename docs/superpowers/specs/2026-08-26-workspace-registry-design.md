# Picot 工作区注册表（Workspace Registry）重构设计

- 日期：2026-08-26
- 状态：待评审
- 作者：Mr. Spock 与 Dr. Lin 讨论定稿
- 涉及分支：`private/features-v3`

---

## 1. 背景与问题

Picot 左侧工具栏的 workspace 列表目前是**推导式**的：每次刷新由
embedded-server 全量扫描 `~/.pi/agent/sessions/**`（当前 27 个 workspace
目录 / 195 个 jsonl / 187MB），解析每个文件的 JSONL header，推导出
"workspace → sessions" 树，前端全量重渲染。

产生三个已确认的问题：

1. **性能与闪动**：`sidebar.loadSessions()` 在 `app.js` 有 8 个触发点
   （切 session、新建对话、跨端口导航等），每次都全量 fetch +
   `replaceChildren` 全树重建。workspace/session 多了以后左栏明显闪动。
2. **列表过长难找**：Pi 历史里所有 cwd 都会出现，无主次。
3. **死目录残留**：物理目录被删/被移动后，workspace 与 session 仍留在
   左栏，选中后 File/Info/Git 全部报错（Pi TUI 无此问题，因为 TUI 是
   先进目录再开 Pi）。Windows 上已修过一个衍生 bug：最后访问的
   workspace 目录被搬家导致 Picot 启动失败。

## 2. 目标与非目标

### 目标

1. **注册制模型**（Codex Desktop App 同款）：左栏 = Picot 自己的注册表；
   用户显式添加/移除项目，持久化在 Picot 已有的 SQLite DB
   （`picot.sqlite3`）中。
2. **左栏不再读取 Pi 全量历史**。列表来自 DB（毫秒级）；某 workspace 的
   sessions 在展开/选中时按需加载（只扫该 workspace 一个目录）。
3. **目录消失自动清理**：刷新时检查每个注册项的物理目录，不存在即删
   DB 行并提示；session 文件永不触碰。
4. **移除不删数据**：「从列表移除」只删 DB 行；重新添加同一目录，
   历史 session 自动回来。
5. **固定默认 workspace**：Picot 启动总是定位到 `~/.pi/tmp`；Quick Chat
   临时目录从 `/tmp` 迁到 `~/.pi/tmp`。启动不再依赖磁盘历史扫描
   （Windows 搬家启动失败问题就此根除）。
6. **`settings_store.rs` 处置**：该模块是 JSON 文件存储且在本分支是死
   代码（零引用），删除；Picot 应用级偏好（theme/locale 等）改存 DB
   `preferences` 表（该表自建库起就存在但从未被读写，本次启用）。

### 非目标（明确不做）

- 不在 DB 中登记 session 级数据（session 列表永远实时扫目录）。
- 不自动发现/导入 Pi TUI 的历史 workspace（首次运行 DB 为空就是空，
  用户手动添加；Dr. Lin 已拍板）。
- 不做 pin 的 cookie→DB 迁移（重新 pin 一次即可，Dr. Lin 已拍板）。
- 不做手动排序 UI（`sort_order` 列本次不加，排序 = pinned 优先 +
  `last_opened_at` 倒序）。
- Cost Dashboard 仍全局扫描（应用级统计，与 workspace 列表无关）。
- 不改 Pi 自身的 `~/.pi/agent/settings.json`（Pi 配置仍归 Pi，
  Picot 经 Pi RPC 读写，避免与 Pi TUI 分叉）。

## 3. 总体设计

```text
                    ┌────────────────────────────────────────┐
                    │  Tauri 主进程（Rust）                    │
                    │  MetadataStore (picot.sqlite3, v3)     │
                    │   ├─ workspaces 表（扩列：注册表本体）   │
                    │   └─ preferences 表（应用偏好，启用）    │
                    │  control_handler 新增命令:              │
                    │   workspace.list/add/remove/pin/touch  │
                    │   preference.get/set/delete            │
                    └────────▲───────────────────────────────┘
                             │ broker-ws（owner 鉴权，现有通道）
   WebView 左栏 ◄─────────────┤
    ├─ workspace 列表 = workspace.list（含 missing 清理 + removed 通知）
    ├─ 展开/选中 → HTTP GET /api/workspace-sessions?path=<canonical>
    │             （embedded-server.ts，只扫一个 project 目录）
    └─ registry_changed 广播 → 各窗口刷新列表
```

职责边界：

- **Rust 拥有 DB**：`MetadataStore` 是应用级唯一实例，包装为
  `Arc<Mutex<MetadataStore>>` 后同时注入 `RemoteAuth` 与 broker control
  handler；全部 DB 操作持同一 mutex，避免同进程多连接写竞争。不得为注册表
  另开 SQLite 连接。迁移、每个单命令写入和 `list` 的「检查并 prune」各自
  在短事务中完成；不需 WAL 多写者设计。
- **embedded-server 不碰 DB**：只负责「给定目录 → 该目录的 sessions」
  的实时扫描（复用现有 `parseSessionFileCached` 进程级缓存）。
- **前端不直接判断 truth**：列表真相在 DB；物理目录存在性由 Rust 在
  `workspace.list` 时顺带检查。

## 4. 数据层设计

### 4.1 DB 位置与 schema

沿用 `app_data_dir/picot.sqlite3`（macOS：
`~/Library/Application Support/works.earendil.picot/picot.sqlite3`），
文件不变、表结构升级：`SCHEMA_VERSION: 1 → 3`。

> 本机现状：该 DB 已是 **v2**（Dr. Lin 另一功能分支写入了
> `company_account_profiles` 表）。因此迁移必须：v0/v1/v2 → v3 全部
> 可达；**不触碰未知表**（`company_account_profiles` 原样保留）。

v3 迁移按版本阶梯执行，**全程同一 transaction，成功后才更新
`user_version`**：

```text
v0 → v1：执行现有 CREATE TABLE IF NOT EXISTS workspaces / paired_devices /
         preferences DDL，并设 user_version=1。
v1 → v2：本分支不假设 v2 的具体表；保留另一分支已有迁移及未知表。
v1 或 v2 → v3：对 workspaces 执行 PRAGMA table_info；仅在列缺失时 ADD
               display_name、pinned INTEGER NOT NULL DEFAULT 0、last_opened_at。
               preferences 已存在则不变；最后设 user_version=3。
```

SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，故不可把三条 `ALTER` 当作 v0
迁移。v2→v3 必须保留 `company_account_profiles` 等未知表。

最终 `workspaces` 形状：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_id` | TEXT PK | UUID（已有，沿用） |
| `canonical_path` | TEXT NOT NULL UNIQUE | realpath 归一后的绝对路径，**唯一身份** |
| `created_at` | INTEGER | 已有 |
| `display_name` | TEXT | 添加时取 `basename`，为将来改名预留 |
| `pinned` | INTEGER NOT NULL DEFAULT 0 | 置顶标记 |
| `last_opened_at` | INTEGER | 打开/切到该 workspace 内 session 时 touch |

排序：`ORDER BY pinned DESC, last_opened_at DESC`（行数 ≤ 百级，无需索引）。

### 4.2 跨分支 schema 纪律（重要）

Dr. Lin 有多个本地分支共用这个 DB 文件。规则：

1. 迁移只做**严格加列/加表**，永不删列删表；DDL 幂等（重跑无害）。
2. `current > SCHEMA_VERSION` 时照旧报错拒绝打开（防旧代码写坏新库）。
3. 本分支升到 v3 后，**写 v2 的那个分支再打开同一文件会拒绝启动**
   （若它走 native runtime）。两个分支最终在 git 合并时汇成一条
   v1→v2→v3 迁移链即可；过渡期内两个分支不要混用同一个 app_data 目录
   运行（或接受其一无法启动）。已向 Dr. Lin 说明，需知悉。
4. **阶梯捷径的后遗症**：本分支把 v1 DB 直接迁到 v3 时永远跳过了 v2 的
   DDL——合并后的代码不得假设 `user_version>=2` ⇒ v2 的表（如
   `company_account_profiles`）存在。另一分支的建表 DDL 必须是
   `CREATE TABLE IF NOT EXISTS`（在 open/使用时懒建），或合并时把
   迁移阶梯改为检测式重建，二者取一，否则捷径库上该功能会报
   `no such table`。

### 4.3 MetadataStore 新增 API（`metadata_store.rs`）

```text
list_and_prune() -> (Vec<WorkspaceRow>, Vec<RemovedWorkspace>)
                                        // 附带 exists 检查：missing 行直接
                                         // DELETE 并放入返回的 removed 集
add(path)     -> Result<WorkspaceRow>   // canonicalize；非目录报错；
                                         // UNIQUE 冲突 → 返回已存在行
                                         //（幂等，added=false）
remove(id)    -> bool
set_pinned(id, bool)
touch_registered_path(canonical_path) -> bool  // 仅已注册项更新 last_opened_at
get(id)       -> Option<WorkspaceRow>

pref_get(key)            -> Option<Value>
pref_set(key, Value)     // upsert（value_json 序列化）
pref_delete(key)
pref_list(prefix)        -> Map<String, Value>
```

`WorkspaceRow { workspace_id, canonical_path, display_name, pinned,
last_opened_at }`（serde camelCase 序列化给前端）。

细节：

- `add` 的 canonicalize 失败（路径不存在）返回明确错误码
  `path_not_found`；不是目录返回 `not_a_directory`。
- `list` 的 exists 检查用 `fs::metadata(path).map(|m| m.is_dir())`；
  false 即 DELETE。**不做宽限期**（Dr. Lin 拍板：直接删）；removed 集
  随响应返回供前端 toast「目录不存在，已从列表移除；会话文件保留」。
- macOS 大小写不敏感文件系统：identity 依赖 canonicalize 输出，天然稳定。
- `reset()` 行为不变（清三张已知表，未知表不动）。
- **touch 触发点**：仅 Rust host 在 workspace open/transition 已成功提交，或
  session switch 已成功路由后，按该操作已验证的 canonical cwd 调
  `touch_registered_path`。前端不得传任意 id 决定排序；未注册 live workspace
  返回 false，且不写 DB。

## 5. Rust 层改造

### 5.1 全部运行时路径打开并共享 DB

`main.rs` 的普通 production setup 与 `setup_native_runtime` 都从同一
`app_data_dir/picot.sqlite3` 打开 `MetadataStore`，并将唯一实例置入
`Arc<Mutex<MetadataStore>>`。`RemoteAuth` 改为持有该共享状态，不再按值
占有 store；broker control handler 也注入同一状态。不得保留 native runtime
「已有逻辑不动」的例外，否则 registry/preferences 在两条运行时路径行为不一致。

### 5.2 broker control 命令（复用现有 `broker_control` 信封）

请求（前端 → broker，owner 鉴权后进 `control_handler`）：

```json
{ "type": "broker_control", "requestId": "…", "command": "workspace.list",
  "args": {} }
```

新增 command：

| command | args | result |
| --- | --- | --- |
| `workspace.list` | `{}` | `{ workspaces: [WorkspaceRow…], removed: [{workspaceId, path}…] }` |
| `workspace.add` | `{ path }` | `{ workspace: WorkspaceRow, added: bool }`；错误 `path_not_found` / `not_a_directory` |
| `workspace.remove` | `{ workspaceId }` | `{ removed: bool }` |
| `workspace.pin` | `{ workspaceId, pinned }` | `{ workspace: WorkspaceRow }` |
| `preference.get` | `{ key }` | `{ value: any \| null }` |
| `preference.set` | `{ key, value }` | `{}` |
| `preference.delete` | `{ key }` | `{}` |
| `preference.list` | `{ prefix? }` | `{ preferences: { key: value } }` |

响应照旧 `control_response { requestId, ok, result|error }`。

**广播**：`workspace.add/remove/pin`（含 `workspace.list` 自动清理）
成功后调用新 broker API，向**所有已鉴权 Native 客户端**各投递一次：

```json
{ "type": "registry_changed", "reason": "added|removed|pinned|pruned" }
```

此 API 遍历 `ui_clients` 中 `authed && class == Native` 的连接；不得复用
`send_owner_event()`，后者只面向单一 owner 当前连接。Remote 客户端不接收
app-global registry 事件。前端收到后重新 `workspace.list`（幂等、便宜）。

**授权矩阵**：所有 `workspace.*` 与 `preference.*` 读写均要求
`Native + verified owner`（handler 首先 `require_native_owner(ctx)`）；Remote
一律返回稳定 `native desktop owner required` 错误。本期不把全局注册表或偏好
开放给 LAN/配对客户端。`touch` **不在公开控制面内**：`touch_registered_path`
是 host 内部 API，仅 Rust 生命周期调用（§4.3），前端无对应命令。
`args.path` 只进 Rust canonicalize，不做 shell 拼接；
`workspace.remove` 只删 DB 行，无文件系统副作用。

### 5.3 启动逻辑改造（生产路径）

现状：`find_latest_session_boot_target()`（扫 `~/.pi/agent/sessions` 找
最新 session 的 cwd）+ `select_fresh_startup_target()`（cwd 失效回退
home）。

改为：

```rust
fn ensure_picot_tmp_root() -> Result<PathBuf, String> {
    let dir = home.join(".pi").join("tmp");
    fs::create_dir_all(&dir)?;
    #[cfg(unix)] fs::set_permissions(&dir, Permissions::from_mode(0o700))?;
    dir.canonicalize().map_err(Into::into)
}

fn default_startup_workspace() -> Result<PathBuf, String> {
    ensure_picot_tmp_root()
}
```

- 启动 cwd **恒为** `~/.pi/tmp`，不读磁盘历史，不恢复上次 workspace
  （现状本来就总是开新 session，只是 cwd 选历史最新的——现在连这个
  依赖也去掉）。
- `find_latest_session_boot_target` / `select_fresh_startup_target` 删除
  （连同其测试改造）。
- `~/.pi/tmp` **不自动注册**进列表：新窗口的 live instance 经现有
  merge 机制临时可见；窗口关了就消失。符合「初始化的 Picot 没有
  项目」。
- `is_invalid_working_directory_error`（os error 267）兜底保留。

### 5.4 Quick Chat 临时目录迁移

`pi_manager.rs`：

- `canonical_temp_root()` 改为调用 §5.3 的 `ensure_picot_tmp_root()`；home
  不可解析时才回退 `env::temp_dir()`，记录 warn，并仍 canonicalize root。
- `create_quick_chat_temp_dir()` 与启动 cwd 均只能通过该 helper 获取 root；
  root 创建、Unix `0o700` 显式设置与 canonicalize 不得分散实现。子目录仍
  显式 `0o700`。
- `cleanup_quick_chat_dir()` 的安全检查（拒删 root、拒 symlink、token 校验）
  都相对该 canonical root 计算。
- 旧 `/tmp` 下遗留 quick-chat 目录不迁移（本就是一次性目录，OS 清理）。
- 权限 0o700 语义不变。

### 5.5 删除 `settings_store.rs`

本分支确认死代码（仅 `mod settings_store;`，零实例化）。删除模块与
mod 声明。其语义归宿：

- **Picot 应用偏好** → DB `preferences` 表（本 SPEC §6）。
- **Pi 自身设置**（thinkingLevel 等）→ 本就不经它，继续走 Pi RPC。
- 若 Dr. Lin 其他分支在用该模块，合并时以本 SPEC 为准裁决。

## 6. 偏好存储（preferences 表启用）

### 6.1 模型

- key：点分命名空间字符串，如 `ui.theme`、`ui.locale`、`ui.sidebar.*`。
- value：任意 JSON（`value_json` 列）。
- 范围：应用全局（所有窗口共享；本表无 per-workspace 语义）。

### 6.2 theme/locale 的双轨策略（防首屏闪白）

现状：theme 存 cookie `pi-studio-theme`（`public/themes.js`），locale
同（`public/i18n.js` cookie）。`bootstrap.html` 在首帧前**同步**读
cookie 应用 theme——这是不能丢的渲染时序约束。

设计：**cookie = 渲染缓存，DB = 持久真相**。

1. 启动：bootstrap 同步读 cookie → 立即应用（首帧正确，不变）。
2. WS 就绪后：`preference.get`（`ui.theme` 等）→ 与 cookie 不一致则
   应用 DB 值并回写 cookie。
3. 用户改 theme：写 DB（`preference.set`）+ 写 cookie（缓存同步）。
4. 结果：换机器/清 cookie 不丢 theme；首帧永远不闪。

新代码一律只写 DB + cookie 双写（经一个统一的 preferences client 模块），
不再新造裸 cookie/localStorage 偏好。

### 6.3 前端模块

新 `public/preferences-client.js`：封装 `preference.get/set/delete/list`
的 broker 调用 + cookie 写通逻辑（theme/locale 双写）。sidebar 折叠态
（`expandedWorkspaces`）等纯内存 UI 态**不进** DB（刷新重置，现状保留）。

## 7. TS 层（embedded-server.ts）

### 7.1 新端点 `GET /api/workspace-sessions?path=<canonical>`

- 仅 loopback（加入 `extensions/request-access.ts` 注册表）。这是性能端点，
  **不是 registry 访问控制边界**：embedded server 不读 DB，不能验证 path
  是否已注册；Native sidebar 只用 broker 返回的注册 path 调用它。
- 行为：给定 canonical path，返回**单个 project** 的 sessions，形状与
  现 `/api/sessions` 里单个 project 条目一致：
  `{ path, dirName, sessions: [...] }`（session 字段含
  `file/filePath/mtime/name/cwd/...`，排序按活跃时间倒序）。
- **dirName 解析**（新模块 `extensions/workspace-dirnames.ts`）：
  - sessions 目录名编码有损（`/`→`-`），不可直接反编码。
  - 实现：readdir `SESSIONS_DIR`，对每个目录：解码名与目标 canonical
    字符串比较，**或**抽样读该目录下 session 文件的 header `cwd` 比对
    （沿用 `serveSessionsList` 的 cwd 多数派推断逻辑）。
  - 同一 canonical 历史上可能对应多个 dirName → 合并其全部 sessions。
  - canonical→dirNames 映射进程级缓存（失效：目录集变化时重建；
    与 `sessionHeaderCache` 同代清理由 `pruneSessionCaches` 顺带处理）。
- 无历史（目录在 sessions 下无对应 dirName）→ `{ path, dirName: null,
  sessions: [] }`，正常 200（新项目常态）。
- 复用 `parseSessionFileCached` / `mergeLiveInstanceSessions` /
  `markChatWorkerSessions` 的单 project 版本（把
  `serveSessionsList` 的 per-project 内层函数提出来共用）。

### 7.2 `/api/sessions` 退役

分阶段：P4 起新端点与旧端点并存；P7 前端全部切换并验证后，删除
`serveSessionsList` 与 `/api/sessions` 路由、`lastSessionProjects`
snapshot、`globalState` 相关缓存键。`/api/sessions/:dirName/:file`
（session 文件内容）、`/delete-batch`、`/rename`、`/switch` 保留——
它们按 dirName+file 操作，与新列表无耦合。

### 7.3 搜索范围限注册表

`GET /api/search?q=&paths=<JSON 数组 of canonical paths>`：

- 传 `paths` 时只扫描这些 canonical 对应的 dirName 集合（复用 §7.1 的
  dirName 映射模块）。此参数是前端性能/产品范围，不是服务端授权。
- 不传 → 维持现状扫全部（过渡期兼容；P7 后 Native 前端一律传）。
- 契约：`paths` 必须为 JSON string array；限制 URL ≤ 8 KiB、数组 ≤ 100 项、
  单项 ≤ 4 KiB。畸形 JSON、非 string 项、超限或空字符串稳定返回 400 JSON
  error；空数组返回正常空结果。实现（实现超集，已按实际行为回标）：
  extension 对请求中的 `path`/`paths` 先经 `fs.realpathSync.native`
  canonicalize（`resolveCanonicalWorkspaceTarget`，失败回退原字符串）再
  与 dirName 解析结果比较——比纯字符串比较更鲁棒（容忍非 canonical
  拼写），非授权边界，canonical 失败不拒请求。Node 与 Bun adapter 共用
  同一 parser/错误形状。
- 左栏内嵌搜索与全局搜索对话框（`session-search-dialog`）都改为传
  registry path 集。

### 7.4 workspace-info 适配

`extensions/workspace-info.ts` 现以 `history:<dirName>` 为主键、靠
`lastSessionProjects` snapshot 反查 path。改为：前端一律用现成的
`path:` 前缀（该分支已支持）传 canonical path；`history:` 分支随
`lastSessionProjects` 一起删除。

## 8. 前端层

### 8.1 Sidebar 数据流重构（`public/sidebar/index.js`，核心）

**数据源**：

- `loadWorkspaces()`：`workspace.list`（broker）→ 注册行；同时拿
  `removed` 集合弹 toast。失败重试沿用现有 retry 骨架。
- `/api/instances`（live 实例）保留，与注册行 merge：实例 cwd ==
  某注册行 canonical → 并入该行（标「运行中」）；未注册 cwd → 独立
  临时行（如默认 workspace 的窗口、Side Chat），id `live:<instanceId>`，
  关窗即消失。
- `app.js` 中 8 处 `loadSessions()` 触发点改义：切 session/新建对话 →
  只失效**当前 workspace** 的 session 缓存并重拉该一个目录；全局刷新按
  钮 → `loadWorkspaces()`（便宜）+ 各展开中目录重拉。

**Workspace 身份**：前端 id 从 `history:<dirName>` / `path:<…>` /
`workspace:<…>` 收敛为 `ws:<workspace_id>`（DB UUID）。session 操作
（switch/rename/delete/archive）仍以 dirName+file 寻址，不变。

**懒加载**：

- workspace 行默认折叠（现状）。展开时才 `GET
  /api/workspace-sessions?path=`，结果按 workspace 缓存于内存；
  「刷新」与该 workspace 内的 session 增删才失效单个缓存项。

**渲染（治闪动）**：

- 抽 `public/sidebar/build-workspace-row.js`（对齐现有
  `build-session-item.js` 模式）。
- 渲染从「全树 `replaceChildren`」改为 **keyed 增量 reconcile**：以
  workspace id 为 key diff 行集合，行内 session 列表同法（key=file）。
  只增删/更新变化的节点；展开态、滚动位置、hover 状态天然保留。
- 骨架屏仅首次（DB 空且无缓存）出现；registry 响应毫秒级，常规刷新
  不再出现空窗。

**空态（onboarding）**：注册表为空 → 显示「添加项目」引导卡（复用
`onboarding.test.js` 骨架），live 临时行照常显示。

### 8.2 添加项目（工具栏按钮）

入口：左栏工具栏「添加项目」按钮（refresh 按钮旁）。

流程：

1. 复用现有 `pick_folder` broker control command：它在 host 内调用已接线的
   `tauri_plugin_dialog`。WebView 不直接调用 `window.__TAURI__`，因此保持
   broker 为唯一常规宿主 IPC 边界；Remote 调用会按 §5.2 被拒绝。现有
   `dialog:default` capability 已满足，P5 不新增插件或扩大 capability。
2. 选定 path → `workspace.add {path}`（Rust canonicalize + 幂等插入）。
3. 响应后：刷新列表 → 新行定位 + 自动展开 → 懒加载
   `/api/workspace-sessions`（即「Pi 检查是否有历史记录」：有历史则
   sessions 直接带出；全新目录则空列表，等用户开聊后自然产生）。
4. `added=false`（已在列表）→ toast「已注册」+ 聚焦/高亮该行，不报错。

**不注册 `~/.pi/tmp` 默认 workspace**（见 §5.3）。

### 8.3 移除操作（workspace 行菜单）

行菜单两项并存，文案明确区分：

- **「从列表移除」**（新，本 SPEC）：`workspace.remove` → 删 DB 行。
  toast：「已从列表移除；目录与会话文件未改动」。若该 workspace 有
  live 实例在跑 → 实例行保留（live merge 兜底），仅注册信息消失。
- **「删除会话文件」**（现有 trash 流程）：保持现状（二次确认 + 走
  `/api/sessions/delete-batch`），与注册表无关。

### 8.4 Pin 与折叠

- Pin：`workspace.pin` 写 DB；sidebar 置顶分组渲染沿用
  `resolvePinnedWorkspaceGroups` 的视觉逻辑，数据源换注册行。
  **cookie pin 不迁移**，`pinned-items.js` 的 pin 语义退役（Dr. Lin
  拍板：重新 pin）。
- 折叠态（`expandedWorkspaces`）：内存态，key 换 `ws:<uuid>`；不进 DB。

### 8.5 Focus 模式

`workspace-focus-sidebar.js` 读 sidebar 的 projects 数据源，自动跟随
新数据源；静态 info card 的 path 字段改用注册行 canonical_path。
Focus 入口语义不变（仍限 active workspace）。

### 8.6 文案（locale keys，四语言）

新增：`sidebar.addProject`（添加项目）、
`sidebar.removeFromList`（从列表移除）、
`sidebar.removedFromList`（已移除 toast）、
`sidebar.workspaceMissingRemoved`（目录不存在，已从列表移除；会话文件
已保留）、`sidebar.alreadyRegistered`（该项目已在列表中）、
`sidebar.emptyRegistryTitle/emptyRegistryHint`（空态引导）、
`sidebar.addProjectDesktopOnly`（仅桌面可用）。
按政策全量补 `en/zh/es/ja` 四份 locale 文件。

## 9. 安全与权限

1. DB 文件 0o600（`MetadataStore::open` 已做，不变）。
2. 所有注册表/偏好命令均要求 `Native + verified owner`；LAN/Remote 不可读写
   此 app-global 状态，也不接收 `registry_changed`。
3. `workspace.add` 的路径来自系统目录选择器（用户显式选择），
   Rust 侧 canonicalize 后只存字符串，无执行面。
4. `cleanup_quick_chat_dir` 迁移后安全边界不变（拒删 root/symlink、
   token 校验、前缀断言全部相对新 root）。
5. `/api/workspace-sessions` loopback-only；它不读 DB，故不宣称 registry
   access-control。若未来要求服务端范围控制，必须改为 Rust owner-scoped broker
   查询或 opaque handle，不能信任浏览器绝对 path。
6. 复用已有 `dialog:default`；不为本功能新增 capability 或 fs 权限。

## 10. 测试策略

| 层 | 测试 | 关键断言 |
| --- | --- | --- |
| Rust `metadata_store.rs` | cargo 单测 | v0/v1/v2→v3 迁移幂等；v2 的未知表保留；`current>3` 拒绝；add 幂等（UNIQUE 去重 added=false）；`list` 自动删 missing 行且 removed 集正确；pref get/set/delete/list 往返；`reset` 不动未知表 |
| Rust broker 命令 | `broker_ws.rs` 契约测试（仿现有） | 各命令 result；Remote 全部拒绝；`registry_changed` 投递全部 Native owner、绝不投递 Remote |
| Rust 启动/临时根 | main.rs + pi_manager.rs 单测 | 两运行时路径共享 store；`ensure_picot_tmp_root` 创建、canonicalize、Unix `0o700`；root 缺失/home fallback；Quick Chat 创建清理正常；旧扫描函数无引用 |
| Rust 生命周期 | main.rs 契约测试 | 成功 open/transition/switch 后仅 touch 已注册 canonical cwd；失败、未注册路径不 touch |
| TS dirName 映射 | `workspace-dirnames.test.ts` | 有损编码（`-` 冲突）经 header cwd 正确解析；一 canonical 多 dirName 合并；无历史返回空 |
| TS 端点 | `embedded-server-session-list.test.ts`（新） | `?path=` 单 project 返回形状与 `/api/sessions` 条目一致；loopback-only；复用 header 缓存 |
| TS 搜索 | `session-search.test.ts` 扩展 | `paths` 限定范围；缺省全量；JSON/类型/上限错误稳定 400；空数组为空结果；Node+Bun adapter 一致 |
| 前端 sidebar | `workspace-registry-*.test.js`（新） | 数据源=registry+live merge；懒加载缓存失效边界；keyed 渲染（DOM 节点复用断言，不闪动）；removed toast；空态；add/remove/pin 流程（mock broker） |
| 前端偏好 | `preferences-client.test.js` | DB 读写 + cookie 写通；bootstrap 首帧 cookie 路径不变 |
| 回归 | 既有 suite | `bun run test` + `bun run check` + `bun run check:rust` 全绿；重点回归 archive-protection / workspace-delete / pagination / super-agent / focus-sidebar / session-sidebar-pinned（数据源 mock 更新） |

## 11. 分阶段实施计划

> 每阶段独立可验证、可停在阶段边界；TDD（先红后绿）。

**P1 — Rust 数据层**
schema v3 迁移 + MetadataStore registry/preferences API + cargo 单测。
验收：`bun run check:rust` 绿；旧 v2 DB 文件迁移后未知表完好。

**P2 — 命令与接线**
共享 MetadataStore 注入 RemoteAuth/control handler + Native-only broker 命令 +
全 Native 客户端 `registry_changed` 广播 + 契约测试。
验收：WS 调 `workspace.add/list/remove/pin` 全链路可用；Remote 被拒绝；两个
不同 Native owner 都收到变更事件。

**P3 — 启动与临时目录**
`~/.pi/tmp` 默认 workspace + Quick Chat root 迁移 + 删除
`find_latest_session_boot_target`/`select_fresh_startup_target`/
`settings_store.rs`。
验收：启动落 `~/.pi/tmp`；Quick Chat 在新 root 创建且清理正常；
`check:rust` 绿。

**P4 — TS 单项目端点**
`workspace-dirnames.ts` + `/api/workspace-sessions` + 测试（旧端点并存）。
验收：对任意已注册路径返回正确 sessions（含有损编码 case）。

**P5 — 前端 sidebar 主重构**
registry 数据源 + 懒加载 + keyed 渲染 + add/remove/pin + 空态 + live
merge + 复用 `pick_folder` broker command + locale 文案 + Focus 适配。
验收：左栏毫秒级刷新无闪动；添加/移除/重加全流程可用；
`bun run check` + sidebar 测试绿。

**P6 — 偏好存储**
preferences-client + theme/locale 双轨写通 + 测试。
验收：改 theme 重启保持；清 cookie 后启动从 DB 恢复且首帧不闪。

**P7 — 收尾与退役**
搜索范围参数 + workspace-info 切 `path:` + 删
`serveSessionsList`/`/api/sessions`/`lastSessionProjects`/`pinned-items.js`
pin 语义 + ARCHITECTURE.md 更新（架构图、模块清单、验证契约）。
验收：`bun run test` 全量绿；`grep -r "loadSessions\|/api/sessions"`
无残留生产引用。

## 12. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| v2 DB 跨分支冲突（§4.2） | 已向 Dr. Lin 说明；过渡期分支不混跑；迁移幂等 + 只加列 |
| 可移动卷/网络盘卸载 → 行被误删 | 接受（Dr. Lin 拍板）；toast 明示；重加即恢复 |
| dirName 有损编码映射错（历史怪路径） | header cwd 多数派兜底 + 单测覆盖；映射失败时该 workspace 显示空列表而非报错 |
| tmp root 创建/权限漏配 → Quick Chat 失败或暴露 | 单一 ensure helper；root/subdir 0700 测试；home fallback 明示日志 |
| sidebar 重构面大（index.js 1351 行） | 分 P5 单阶段内小步 TDD；既有 6 个 sidebar 测试文件作回归护栏 |
| 搜索范围收窄用户感知「搜不到了」 | 空态提示「仅搜索已注册项目」；语义与左栏一致 |
| 回滚 | **代码 revert 不等于 DB rollback**：v1/v2 binary 遇 v3 `user_version` 会拒绝打开。发布前备份 `picot.sqlite3`；故障时只能恢复该备份或使用受控降级工具。各实现阶段可 revert，但数据库 schema 仅支持前向恢复。 |

## 13. 开放问题（实现前需 Dr. Lin 确认）

无阻塞项。两点执行默认（如无异议按此执行）：

1. 添加时 `display_name` 取目录 basename，暂不做改名 UI。
2. live 实例（未注册 cwd 的运行中窗口）在左栏以普通行展示，不加
   「注册」引导按钮（保持 v1 简洁）。
