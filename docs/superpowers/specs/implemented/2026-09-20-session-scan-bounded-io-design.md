# Session 扫描有界 IO（head/tail 双窗口）

**状态：** Implemented — 2026-09-22（`host_data.rs` 双窗口扫描，偏差已记入 ARCHITECTURE.md 侧栏章节）
**日期：** 2026-09-20
**参照：** Paseo `packages/server/src/server/agent/providers/pi/session-descriptor.ts`（bucket 列表性能）；upstream `~/tmp/PI/picot/src-tauri/src/host_data.rs::parse_session_summary_with_metadata`

## 问题

侧栏刷新（`workspace_sessions`）调用 `read_workspace_session_bucket`，对注册 bucket 内
每个 `.jsonl` 执行 `scan_session_sidebar_visibility`（`src-tauri/src/host_data.rs:1138`）。
该函数逐行读取并完整 `serde_json::from_str` 解析，早停条件是
`header.is_some() && user_messages > 0 && first_message.is_some() && name_sealed`。

Pi 的行为决定了两类最坏情况：

1. **有名 session 也扫大半文件。** Pi 在 agent「settle」名字后才追加 `session_info`
   条目，位置靠近当时的文件尾。扫描必须读到该条目 `name_sealed` 才停。
2. **无名 session 扫全文件。** `name_sealed` 永不置位，循环读到 EOF，期间每一行
   （包括巨大的 tool_output 行）都被完整反序列化。

侧栏只需要每条 session 的：`id`、`timestamp`、`cwd`、`parentSession`、`name`、
`first_message`、`mtime`。这些字段全部来自文件头部（首行 `session` 条目 + 早期
user message）与文件尾部（settled name），中间内容对侧栏无用。

## 已验证事实

| 事实 | 证据 |
| --- | --- |
| v3 逐行线性扫描 + `name_sealed` 早停 | `picot-v3/src-tauri/src/host_data.rs:1138-1212` |
| upstream 同样线性扫描，早停条件 `line_count > 50 && first_message.is_some() && name.is_some()`；注释明说 session_info 由 agent settle 后追加在文件尾，不能更早断 | `picot/src-tauri/src/host_data.rs:2119-2184` |
| 无名 session 全文件扫描在 upstream 同样存在（`name` 永不 Some） | 同上，循环无行数上限 |
| v3 排序键优先 mtime（不依赖内容） | `host_data.rs:1373 session_activity_time`（mtime → timestamp → ctime） |
| TOCTOU 防护是前后元数据比对，与读取方式无关 | `host_data.rs:1075 sidebar_file_metadata_matches` |
| Paseo 方案：head 64KB + tail 256KB 两个有界窗口；head 行数上限 2000；preview 缺失时接受降级（注释明说） | `paseo/.../session-descriptor.ts:18-27, 263-320` |
| Paseo tail 倒序解析取 title（最新 `session_info`）、lastActivity、model | 同上 `parseSessionTail` |
| `user_messages == 0 && line_count <= 4` 是唯一用到行数/计数的有效性守卫 | `host_data.rs:1198-1201` |
| 扫描无结果缓存，每次刷新重扫内容（before/after 元数据比对仅防 TOCTOU） | `classify_sidebar_file`，`cache_path` 只做路径规范化 |

## 设计

### 双窗口读取

`scan_session_sidebar_visibility` 改为两段读取，语义对齐 Paseo：

1. **HEAD 窗口**：`HEAD_BYTES = 64 KiB`，`HEAD_LINE_LIMIT = 2000` 行。
   - 首行 `session` 条目解析出 `id / timestamp / cwd / parentSession`。
   - 窗口内首个 user message 取 `first_message`（截 120 字符，现状不变）。
   - 窗口内计数 `user_messages`、`line_count`（供有效性守卫）。
   - 窗口内出现的 `session_info` name 作为候选。
   - 满足现行早停条件即停（窗口内早停仍有效，减少解析量）。
2. **TAIL 窗口**：`TAIL_BYTES = 256 KiB`，从 EOF 倒读。
   - 倒序解析，取**最新**一条 `session_info` 的 `name`（settled name 在尾部，
     这正是 upstream 必须线性扫到尾部才能拿到的东西）。
   - tail 命中则覆盖 head 候选 name。

字节窗口边界截断一行 JSON 时该行解析失败即跳过，无正确性影响（Paseo 同构处理）。

### 不变的部分

- TOCTOU 前后元数据比对、`cache_path` 规范化、并发 worker 划分、
  workspace 匹配（`session_header_matches_workspace`）、排序、投影字段——全部不动。
- 有效性守卫语义不变（窗口内 `user_messages == 0 && line_count <= 4` 仍然只在
  「小文件且无 user message」时判无效；大文件即使窗口内无 user message，
  `line_count > 4` 依然产出 header，与现状一致）。

### 降级接受

- preamble 超过 HEAD 窗口仍无 user message：`first_message = null`，侧栏退化为
  name + 时间展示。Pi session 首条 user message 几乎总在头部几 KB 内。
- settled name 距 EOF 超过 TAIL 窗口：`name` 退化。256KB 尾部窗口内无
  `session_info` 的活跃 session 属于极端长会话且从未被打开命名的情形。

两个上限常量集中定义，留标定空间（硬件标定原则：物理世界的文件形态会漂）。

## 与 upstream 的关系

这是**有依据偏离**，不是回归修复：upstream 同样存在线性扫全文件的最坏情况。
偏离理由是 Picot 的侧栏刷新频率与 bucket 规模（注册工作区内全量 jsonl）使
O(文件大小) 不可接受；Paseo 已验证双窗口在生产可用。按仓库规则，本节即
偏差记录，落地时在 `ARCHITECTURE.md` 扫描章节同步标注。

## 测试计划

1. fixture：无名 session（无任何 `session_info`）、5000 行、含多个 >10KB 的
   tool_output 行。断言：读取字节数 ≤ HEAD + TAIL（把读取量做成函数返回值或
   注入 reader 计数）；header/first_message 字段正确。
2. fixture：`session_info` 在文件尾部 256KB 内。断言 name 取自 tail 且为最新一条。
3. fixture：`session_info` 距 EOF > 256KB。断言 name 为空、不报错。
4. 既有 `scan`/sidebar 投影测试全绿（字段集不变）。
5. `bun run check:rust`；手测大 bucket（>100 session）刷新耗时对比。

## 验收条件

- 无名大 session 的扫描成本从 O(文件) 降到 O(320KB) 上界。
- 侧栏投影字段与排序行为与现状逐字段一致（除上述两处明确降级）。
- upstream 偏差已记录于本 spec 与 ARCHITECTURE.md。
