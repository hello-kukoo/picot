# Pi 系统提示词加载机制

本文基于源码讨论整理，覆盖 `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md` 三者的加载规则、相互作用，以及几个常见混淆点。

## 一、概览

Pi 的最终系统提示词由 `buildSystemPrompt()` 一次性拼装，拼装顺序固定：

```
(customPrompt ?? 默认模板)
  + appendSystemPrompt       ← APPEND_SYSTEM.md / --append-system-prompt
  + <project_context>        ← AGENTS.md / CLAUDE.md（多层级联）
  + formatSkillsForPrompt()  ← 可发现的所有 skills
  + "Current working directory: ${cwd}"
```

`SYSTEM.md` 和 `AGENTS.md` 由同一个 `DefaultResourceLoader` 分别处理，属于两套**完全独立**的机制，互不触发：

| 维度       | `SYSTEM.md`              | `AGENTS.md` / `CLAUDE.md`                        |
| ---------- | ------------------------ | ------------------------------------------------ |
| 作用       | 替换默认系统提示词骨架   | 以 `<project_context>` 块的形式追加到提示词尾部 |
| 来源字段   | `customPrompt`           | `contextFiles`                                    |
| 多层叠加   | 否（项目或全局二选一）   | 是（全局 + 多个祖先目录 + 当前目录，全部合并）   |
| 加载入口   | `discoverSystemPromptFile` | `loadProjectContextFiles` / `loadContextFileFromDir` |

有 `SYSTEM.md` 时默认模板（identity 行 + 工具列表 + guidelines + Pi 文档指针）整段丢失；没有 `SYSTEM.md` 时走默认模板；`AGENTS.md` **不管有没有 `SYSTEM.md` 都会加载**，始终出现在 `<project_context>` 块中。

## 二、`SYSTEM.md` 加载规则

`packages/coding-agent/src/core/resource-loader.ts:966-979` 的 `discoverSystemPromptFile()`：

1. `<cwd>/.pi/SYSTEM.md` —— 项目级；要求 `settingsManager.isProjectTrusted() && existsSync`
2. `~/.pi/agent/SYSTEM.md` —— 全局；不需要项目信任

两项命中其一即返回，后续不再查找。覆盖关系：

- `--system-prompt <text>` CLI 参数通过 `systemPromptSource` 注入，优先级高于文件（`resource-loader.ts:474` 的 `this.systemPromptSource ?? this.discoverSystemPromptFile()`）。
- `SYSTEM.md` 出现在 `trust-manager.ts:34` 的 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 名单里，项目级版本受项目信任闸门控制。`--approve` / `--no-approve` 间接影响它是否被采用（不信任则回退到全局）。

## 三、`APPEND_SYSTEM.md` 加载规则

`resource-loader.ts:981-991` 的 `discoverAppendSystemPromptFile()`，查找顺序与 `SYSTEM.md` 一致：

1. `<cwd>/.pi/APPEND_SYSTEM.md`（项目受信任时）
2. `~/.pi/agent/APPEND_SYSTEM.md`（全局）

由于 `appendSystemPrompt` 是数组（`resource-loader.ts:176`），CLI 的 `--append-system-prompt` 与文件**叠加**而不是互斥，多个值在 `agent-session.ts:1037` 用 `\n\n` join。最终追加位置始终在 `<project_context>` 之前。

## 四、`AGENTS.md` 加载规则

`resource-loader.ts:50-110` 的 `loadProjectContextFiles()` + `loadContextFileFromDir()`：

1. `~/.pi/agent/AGENTS.md`（全局）
2. 沿父目录向上逐级遍历直到文件系统根
3. 最后是当前目录

候选文件名按序查找：`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。所有命中的文件全部合并进 `<project_context>`，closest-wins 是单文件粒度——同名多份不会去重，但 `seenPaths` 集合会阻止完全相同路径重复出现。

禁用：`--no-context-files` 或 `-nc`（注意只禁 `AGENTS.md` / `CLAUDE.md`，**不影响** `SYSTEM.md` / `APPEND_SYSTEM.md`）。

## 五、`--no-session` 与系统提示词的关系

**无关。`--no-session` 不影响任何提示词加载行为。**

`packages/coding-agent/src/main.ts:269-271`：

```ts
if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
    return SessionManager.inMemory(cwd, ...);
}
```

`--no-session` 只是让 `SessionManager` 走内存版（不落盘），`DefaultResourceLoader` 的创建在 session manager 之前，由 `main.ts:663` 的 `resourceLoaderOptions` 注入，与 `noSession` 标志无关。

禁用 `SYSTEM.md` / `APPEND_SYSTEM.md` 没有专门的 CLI 开关，真正相关的是：

- `--system-prompt <text>` —— 覆盖 `SYSTEM.md`（也覆盖默认模板）
- `--append-system-prompt <text>` —— 与 `APPEND_SYSTEM.md` 叠加
- `--no-context-files` / `-nc` —— **只**禁 `AGENTS.md`，不影响前两者
- `--approve` / `--no-approve` —— 改变项目信任，间接影响项目级 `SYSTEM.md` 是否被采用

## 六、默认 `SYSTEM.md` 是什么

**仓库里没有默认的 `SYSTEM.md` 文件。** 默认提示词不是 Markdown，是 `packages/coding-agent/src/core/system-prompt.ts` 第 119-138 行 `buildSystemPrompt()` else 分支里硬编码的模板字面量，由四段组成：

1. Identity 行：`You are an expert coding assistant operating inside pi, a coding agent harness.`
2. `Available tools:` 列表 —— 由 `selectedTools` 与 `toolSnippets` 动态决定，默认 `[read, bash, edit, write]`
3. `Guidelines:` —— 动态 + 固定两条（`Be concise in your responses`、`Show file paths clearly when working with files`）
4. Pi 文档指针（`README.md`、`docs/`、`examples/`）—— `getReadmePath/getDocsPath/getExamplesPath` 在运行时根据包安装方式动态算路径；提示词要求模型"只在用户问到 pi 自身时"才读这些

`grep "expert coding assistant"` 在 `packages/coding-agent/src` 下唯一命中就是 `system-prompt.ts:121`，印证没有打包的 `SYSTEM.md`。

## 七、关键源码索引

- `packages/coding-agent/src/core/system-prompt.ts` —— 最终拼装（`customPrompt` + `appendSystemPrompt` + `<project_context>` 三段）
- `packages/coding-agent/src/core/resource-loader.ts:50-110` —— `AGENTS.md` / `CLAUDE.md` 多层发现
- `packages/coding-agent/src/core/resource-loader.ts:472-490` —— `SYSTEM.md` / `APPEND_SYSTEM.md` 与 CLI 标志的优先级
- `packages/coding-agent/src/core/resource-loader.ts:965-991` —— `SYSTEM.md` / `APPEND_SYSTEM.md` 项目-全局二选一
- `packages/coding-agent/src/core/trust-manager.ts:30-38` —— `SYSTEM.md` / `APPEND_SYSTEM.md` 属信任闸门资源
- `packages/coding-agent/src/core/agent-session.ts:1030-1052` —— `appendSystemPrompt` 在多次源时 `\n\n` join
- `packages/coding-agent/src/main.ts:269-271` —— `--no-session` 仅切换到 `SessionManager.inMemory()`
- `packages/coding-agent/src/cli/args.ts:104-105, 169-170` —— `--no-session` 与 `--no-context-files` 解析

## 八、实战用法：多角色（RPC headless）

场景：Pi 通过 `--mode rpc` headless 方式调用，需要在 marketing、tech-writer、code-reviewer 等不同 role 之间切换。

### A + C 的边界

两条路径在最终拼装的同一段 `customPrompt` 位置生效，**后者覆盖前者**，无法自动组合：

| 情况 | 走法 | 例 |
|---|---|---|
| 通用身份，可能跨项目使用 | A：`~/.pi/agent/roles/<name>.md` + `--system-prompt` | techwriter 在多个目录里都能用 |
| 身份只在某个项目里成立 | C：`<project>/.pi/SYSTEM.md` | marketing 是为 `~/work/brand-site/` 专属 |
| 通用身份 + 项目专属知识 | A 为主，`AGENTS.md` 提供项目知识 | A 决定角色，`AGENTS.md` 注入术语表 |

### 三个实际坑

**坑 1：RPC 下项目级 SYSTEM.md 受信任闸门静默忽略。** `usage.md` 明确："Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources." 也就是 RPC 默认信任值 `"ask"` 等价于"不信任"，项目级 `SYSTEM.md` 静默失效，看不到任何报错。修复三选一：

- `cd <project> && pi`，按提示信任（一次性）
- 临时：`pi --mode rpc --approve`
- 全局：把 `~/.pi/agent/settings.json` 设成 `{ "defaultProjectTrust": "always" }` —— 注意这等价于让本机所有项目都能加载自己的 `SYSTEM.md`/`extensions` 等，开/关取决于本机是不是 headless RPC 专用环境

路径 A 完全不受这个坑影响（`~/.pi/agent/` 永远是 trusted-by-definition）。

**坑 2：`--system-prompt` 静默覆盖项目级 SYSTEM.md。** `resource-loader.ts:474` 的优先级 `this.systemPromptSource ?? this.discoverSystemPromptFile()` 让 CLI 短路文件发现，且不打印任何警告。把它当作"显式覆盖逃生口"使用；只要 CLI 包装里固定传某个 role，对应项目里的 `.pi/SYSTEM.md` 就成了摆设。

**坑 3：A 和 C 无法自动组合。** Pi 没有 `# include` 机制。如果想"通用 role + 项目补丁"，三种折中：

- 把通用部分抄进项目 `.pi/SYSTEM.md`（最简单，但改通用行为要同步多份）
- 项目级留空，全部走 A（动态，但失去项目内 review 时所见即所得）
- 项目独有补丁放进项目级 `APPEND_SYSTEM.md`（追加在 SYSTEM.md/默认骨架之后），与 SYSTEM.md 解耦——这是 Pi 设计里最接近"分层"的做法

### 推荐目录布局

```
~/.pi/agent/
  roles/
    marketing.md        ← 通用 marketing persona
    tech-writer.md      ← 通用 tech-writer persona
    code-reviewer.md
  APPEND_SYSTEM.md      ← 全局通用纪律：语言、格式、不泄 prompt
  settings.json         ← { "defaultProjectTrust": "always" }
                         （headless RPC 专用环境才设）

~/work/brand-site/
  .pi/
    SYSTEM.md           ← 这个品牌独有的身份/禁用词/语气（薄）
    APPEND_SYSTEM.md    ← 项目独有 patch（可选）
  AGENTS.md             ← 项目知识：品牌术语表、产品清单
```

启动：

```bash
# 跨项目营销：通用 persona 走 A，再切到项目目录让 AGENTS.md 自动注入
pi --mode rpc --no-session \
  --system-prompt "$(cat ~/.pi/agent/roles/marketing.md)" \
  --cwd ~/work/brand-site

# 在 brand-site 里需要项目级 persona 时（C 路径）：
#  首次需先 trust：cd ~/work/brand-site && pi --approve
#  之后：cd ~/work/brand-site && pi --mode rpc --no-session
```

shell router 把这个固定下来：

```bash
#!/usr/bin/env bash
# pi-role <role-name> [extra-flags...]
ROLE="$1"; shift || { echo "usage: pi-role <role> [flags...]" >&2; exit 1; }
case "$ROLE" in
  marketing|tech-writer|code-reviewer) ;;
  *) echo "unknown role: $ROLE" >&2; exit 1 ;;
esac
exec pi --mode rpc --no-session \
  --system-prompt "$(cat "$HOME/.pi/agent/roles/$ROLE.md")" \
  "$@"
```

### 一条非编程角色 SYSTEM.md 的写法示例

默认模板里 "expert coding assistant" 那段对营销/写作场景是噪声。重写时建议保留三件事——identity、一条工具白名单声明、`APPEND_SYSTEM`/AGENTS context 注入位置——其它可省：

```markdown
# Role: marketing copywriter

You write landing-page copy and ad creatives for {{BRAND}}.
Voice: concise, evidence-driven, no jargon.
You may read files and run shell commands; you may not edit or write source code.

When asked for a draft, return a single self-contained deliverable in markdown.
When asked for revisions, only change the parts the user named — do not rewrite the rest.

After every assistant turn, end with a one-line "Open questions:" list when anything is unresolved.
```

注意：这一段会**替换**整个默认骨架（identity、工具列表、Pi 文档指针全部消失）。如果角色需要工具，把可用工具白名单显式写出来——默认展示哪些工具靠的是这段的"facts about you"，不是隐式约定。

## 九、常见误解

1. **"默认 SYSTEM.md 是某个文件"** —— 不是。是源码里的硬编码模板。
2. **"`--no-session` 不加载 SYSTEM.md"** —— 错。它管的是会话落盘，与资源加载无关。
3. **"`SYSTEM.md` 比 `AGENTS.md` 优先级高"** —— 错。两者是平行机制，前者替换骨架、后者追加上下文块，谁也不吞掉谁。
4. **"`APPEND_SYSTEM.md` 会替换默认提示词"** —— 错。它只是 append；替换是 `SYSTEM.md` 的工作。
5. **"`--no-context-files` 会禁用 SYSTEM.md"** —— 错。它的 `noContextFiles` 分支只影响 `agentsFiles`，`SYSTEM.md` / `APPEND_SYSTEM.md` 走独立路径。
