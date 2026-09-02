---
name: update-memory
description: 增量更新 .memory/MEMORY.md —— 扫描上次游标之后的新 pi session，归纳决策/批评教训/探索主题，合并进 MEMORY.md 与 topics/。当用户要求"更新记忆"、"回填 memory"、提到 update-memory 或 .memory 目录时使用。
tags: [memory, sessions, documentation]
---

# Picot 记忆库增量更新

## 用途

把 `~/.pi/agent/sessions/--Users-linyong-tmp-PI-picot-v3--/` 中自上次游标以来的
主会话归纳进记忆库。subagent 会话由脚本自动跳过（子目录内的 session.jsonl，
以及根目录下首行带 `parentSession` 字段的文件）。

**职责边界：**

- **本 skill 负责**：增量扫描、摘要提取、归类合并、游标推进
- **本 skill 不做**：修改 ARCHITECTURE.md；把规则直接写入 docs/engineering-lessons.md（只建议晋升候选，由 Dr. Lin 决定）

## 记忆库结构

```text
.memory/                  # 已被主 repo gitignore；内部有独立 git 仓库（见流程步骤 9）
├── MEMORY.md             # 索引 + 决策日志 + 教训 + 主题索引（保持 <300 行）
├── topics/<slug>.md      # wiki 式主题页
├── notes/                # 分批归纳笔记（长期保留的细节层，见步骤 3）
├── tools/extract_sessions.py   # 提取脚本（uv 运行）
└── digests/              # 会话摘要（一次性中间产物，可随时重建，每轮清理）
```

`.memory/` 自身维护一个**独立 git 仓库**（`git -C .memory …`）：主 repo 忽略
整个目录，嵌套仓库不受影响。每次更新完成后提交一次，消息含 cursor 文件名——
这是"保人改优先"唯一的兜底：agent 误覆盖人改内容时可回滚。

## 流程

1. **读游标**：从 `.memory/MEMORY.md` frontmatter 取 `cursor`（最后已处理的
   session 文件名）。
2. **列新会话**：

   ```bash
   uv run .memory/tools/extract_sessions.py --after "<cursor>"
   ```

   输出到 `.memory/digests/`，含 `_index.json`。文件名字典序=时间序。脚本默认
   `--active-within 30`（分钟）：以**文件尾部最新 message 记录的时间**判定
   活跃（内容判活，非 mtime —— Picot GUI 重开旧会话只追加 custom 记录、
   刷新 mtime 但不算活跃），活跃文件跳过。
   **诚实暴露窗口**：`--after` 是严格大于比较，cursor 指向的文件本身被
   resume 续写时，续写内容**永不再被扫描**（不存在"下轮覆盖"）。补救规则见
   步骤 6。另：--after 指向的文件不在目录时脚本打 notice（可能已被 picot
   清理），属预期路径，继续执行。
3. **归纳**：逐个读 digest，按三类归档：
   - **决策**：明确的方向选择/方案取舍。格式 `[MM-DD HH:MM] 决策。理由。否：被否方案`，**一条决策一行**，同刻多个决策分行写；行数预算不够时把细节下沉到 notes，不在索引行里堆叠。日常 bug 流水账不算决策。
   - **批评与教训**：Dr. Lin 的不满、纠正、返工指令 → 根因 → 得出的规则。来源标注到 **〔MM-DD HH:MM〕**（一天多个 session，只有日期无法溯源）。
   - **探索主题**：概念澄清、Pi 源码/TUI/RPC 探索等可复用知识 → 写或更新
     `topics/<slug>.md`（frontmatter 含 created/updated/source_sessions）。
     **建页判据是知识密度而非跨会话频次**：凡含外部系统契约/原语、非显然
     的实验结论、可复用方法论的主题，即使只出现在一两个会话也直接建页。
   - **分批笔记**：会话量大时（>10 个）分批，每批派一个 worker 并行归纳。
     每个 worker **必须用独立输出目录** `--out .memory/digests/batch-N/`（并行
     共用同一目录会互相覆盖 `_index.json`）。每批归纳结果写入
     `.memory/notes/batch-<YYYYMMDD>-<N>.md`，分节名与现有 notes 文件一致：
     `## 决策 / ## 批评与教训 / ## 探索主题候选 / ## 开放问题`，每条带完整"主题｜决策｜理由｜被否方案｜来源"。
     notes 是**长期保留的细节层**：MEMORY.md 索引行放不下的一句理由、被否方案、
     上下文都留在 notes 里，索引行可写「详见 notes/batch-…」。
   - **去重规则**：会话中途曾直改过 MEMORY.md 的文件（常见：本会话边修
     记忆库边干活），正式 digest 轮合并前先按时间戳查重 —— 已存在的条目跳过，
     只补新内容。重扫场景（见步骤 6）同此规则，防重复累加与重复合并。
4. **合并（保人改优先）**：先读现有 MEMORY.md 再改。若某节有 Dr. Lin 手写内
   容（措辞风格明显非 agent 生成、或带 `<!-- human -->` 标记），保留原文，
   agent 内容以追加方式合并，绝不整节重写覆盖。
5. **蒸馏候选**：发现可固化为硬规则的教训时，在回复中列出"建议晋升到
   docs/engineering-lessons.md 的条目"，等 Dr. Lin 确认后再动那个文件。
6. **推进游标（以目录实况为权威，不用 _index.json；游标只进不退，唯一例外
   见 b）**：全部批次归纳合并完成后，运行：

   ```bash
   uv run .memory/tools/extract_sessions.py --print-cursor
   ```

   设 stored = frontmatter 现值，print = 上述输出：
   - a) print ≥ stored（常态）：写入 `cursor: print`。**例外**：区间
     (stored, print] 内存在活跃文件（看 stderr skip 清单）时，cursor 只能推进到
     **第一个活跃文件之前**的最后已处理文件；活跃文件紧邻 stored 则保持
     stored 不动 —— 防止跨越仍在追加的文件造成丢尾，待其静默后下轮重扫。
   - b) print < stored 且 cursor 文件仍活跃（尾部有新 message）—— 存在未入库
     尾部：**回退 stored := print**，下轮重扫区间文件并按去重规则合并，
     补齐尾部内容。判定 cursor 文件是否活跃：看脚本 stderr 的
     `live(appending…)` 跳过清单（--print-cursor 或 digest 模式都会输出）。
   - c) print < stored 且 cursor 文件不在目录（已被 picot 清理）：保持 stored，
     无损失。
   - d) 其他异常（print < stored 且无法解释）：停下报告 Dr. Lin，不要首动。
   `last_updated` 取当前 ISO 时间。`_index.json` 只用于统计条数，不做 cursor
   来源。`sessions_total` **按本轮实际处理的 digest 条数累加**（重扫补尾的
   已计会话不重复累加）；与目录实况明显不符时先校准再累加。
7. **一致性自检（改完 MEMORY.md 必跑）**：
   - 主题索引表中每个链接 ↔ `topics/` 下实际文件双向核对：无重复行、无死链、
     无漏列的新建页。
   - 教训/决策条目来源格式合规（〔MM-DD HH:MM〕）。
   - `wc -l .memory/MEMORY.md` < 300。
   - frontmatter cursor ≥ `--print-cursor` 输出。**仅正式更新轮（本轮刚执行
     过步骤 6）强制此单调性检查**：stored < print 说明上轮未按规则推进，需
     排查。meta 提交轮（只改内容、跳过步骤 6）不查——步骤 6-b 回退后
     stored < print 是合法中间态，待下轮重扫补尾后恢复。
   - 已否决方案节无重复条目。
   历史上主题索引曾整行重复插入——本步骤就是为拦截这类合并事故。
8. **清理**：删除 `.memory/digests/` 本轮生成的摘要文件（含 batch-N 子目录）。
   `notes/` 不删——它是长期细节层。
9. **提交内部仓库**：`git -C .memory add -A && git -C .memory commit -m
   "memory update: <cursor 文件名>（+N sessions）"`。**维护性/meta 提交
   （非正式更新轮）同样要先刷新 `last_updated` 再提交**，防字段漂移。

## 语言与格式约定

- 全中文，代码标识符/路径/命令保留英文。
- MEMORY.md 正文六节固定顺序：项目速览 / 决策日志 / 教训与批评 / 已否决方案 /
  主题索引 / 开放问题。决策日志倒序（新的在上）。
- 每条记录必须带来源 session 文件名前缀或 〔MM-DD HH:MM〕 时间戳，便于溯源。
- **候选主题淘汰**：主题索引下方的候选清单连续 **3 轮更新未被晋升或未被引用**
  即删除（删除前在回复中列出，给 Dr. Lin 最后一次保留机会）。候选不能只进不出。
  每轮更新后在候选行尾刷新「末次审查：YYYY-MM-DD」标记，作为淘汰计数的记账依据。

## 注意

- digest 里助手内容是截断要点。深挖细节的顺序：先查 `notes/` 里该批次的完整
  笔记；notes 不够时再由 agent 对原始 jsonl
  （`~/.pi/agent/sessions/--Users-linyong-tmp-PI-picot-v3--/<file>`）做定向二
  次摘要 —— jsonl 是机器格式，不适合人直接读，一切深挖都经 agent 归纳。
- 脚本的 `NOISE_PREFIXES` 硬编码 pi 注入块格式，pi 升级后可能漂移；digest
  开始混入 reminder/context 噪音时按脚本内注释更新该列表。
- `.memory/` 不进主 repo git；不要在 MEMORY.md 里放密钥或敏感凭据类信息。
- 触发覆盖面：自动触发仅 Pi TUI 的 `/new`（`.pi/extensions/auto-memory.ts`）；
  Picot GUI 不做此机制 —— 记忆库是 workspace 私有物，Dr. Lin 定调 GUI 无需覆盖。
  skill 与扩展均留在本地不进主 repo。
