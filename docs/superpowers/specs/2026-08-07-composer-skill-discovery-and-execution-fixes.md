# Composer 中 Skill 的发现与执行：问题分析与修复方案

> **Status:** Decided（设计点已与 Dr. Lin 确认，2026-08-07）。本文档取代
> [`2026-07-27-claude-skills-discovery-design.md`](2026-07-27-claude-skills-discovery-design.md)
> 中"写死扫描 `~/.claude/skills` 并提供专属 Enable 按钮"的设计取向。
> 若两者冲突，以本文档为准。
>
> **实现顺序：** 先 Q3（核心发送 bug，影响所有用户），再 Q2（架构清理）。

**实现基线：** Q3 对成功展开的已发现 skill 与 prompt template，其注入文本必须与当前内嵌 Pi TUI 按字节对齐；未知的 slash 输入仍按普通用户文本透传。已命中资源的读取或解析失败是 Picot 明确的产品差异：返回错误且不发送，不宣称与 Pi TUI 的失败路径等价。Q2 是纯删除工作：移除 Discovered 页签写死的 `.claude/skills` 自动发现及其死代码链路，用户加任意目录的 skill 统一走已有的 Install 页签流程。

本文基于源码追踪整理，覆盖三个相互关联的问题：

- **Q1**：composer 输入 `/` 后，skill 列表从哪里来？
- **Q2**：`~/.claude/skills` 在 Settings 页面能看到，composer 的 `/` 菜单却看不到。
- **Q3**：从 `/` 菜单选中一个 skill 后，`/skill:<name>` 发出去却没被当成 skill 命令处理。

Q2 与 Q3 同源——它们共享同一个根因：**Picot 存在两套并行的 skill 发现系统，一套接进 pi，一套没有**。

---

## 一、Q1：`/` 菜单的 skill 列表从哪里来

整条链路分三层。

### 1.1 渲染层（前端）

`public/ui/skill-slash-command.js` 的 `setupSkillSlashCommand()` 负责监听输入框。

- `activeSlashQuery(input)`（L8）用正则 `^\/([^\s/]*)$` 匹配光标前的文本，判断是否处于 slash 输入态。
- 在 `public/app.js:748` 注入该模块时，`loadSkills` 回调实现为：

```js
loadSkills: async () => {
  const response = await rpcCommand({ type: "list_skills" }, null, true);
  if (!response?.success) throw new Error(...);
  return response.data?.skills || [];
}
```

- 结果用 `loadPromise` 缓存一次，按 name / command / description 子串过滤后渲染（L88–96）。

### 1.2 服务端（Picot extension）

`extensions/embedded-server.ts:2252` 的 `case "list_skills"`：

```ts
case "list_skills": {
  const a = requireApi("list_skills");
  if (!a) break;
  sendTo(ws, success("list_skills", { skills: normalizeSkillCommands(a.getCommands()) }));
  break;
}
```

`a` 是**内嵌 pi 进程的 `ExtensionAPI`**。`a.getCommands()` 返回 pi 当前会话的所有 slash command（extension command + prompt template + skill）。

### 1.3 数据源（pi 本体，唯一真相源）

`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1829` 的 `getCommands()`：

```js
const skills = this._resourceLoader.getSkills().skills.map((skill) => ({
  name: `skill:${skill.name}`,
  description: skill.description,
  source: "skill",
  sourceInfo: skill.sourceInfo,
}));
return [...extensionCommands, ...templates, ...skills];
```

Picot 的 `normalizeSkillCommands`（embedded-server.ts:807）再做一次映射：过滤 `source === "skill"`，把 `name` 从 `skill:foo` 改回 `foo`，scope 取自 `sourceInfo.scope`。

### 1.4 结论

`/` 菜单的 skill 列表 = **pi 的 `resourceLoader.getSkills()`**。

pi 默认扫描的 skill 目录（`package-manager.js:1934–1975` + `skills.js:327`）：

| 作用域 | 目录 |
|---|---|
| 用户 | `~/.pi/agent/skills`（mode=pi）、`~/.agents/skills`（mode=agents）|
| 项目（trusted）| `<cwd>/.pi/skills`（mode=pi）、`<cwd>/.agents/skills` 及祖先链（mode=agents）|
| settings.json | `~/.pi/agent/settings.json` 与 `<cwd>/.pi/settings.json` 的 `skills[]` override |

**`~/.claude/skills` 不在 pi 的默认扫描范围内**（在整个 pi SDK 里 grep `.claude`，唯一命中是无关的 bedrock 模型名）。除非用户把它作为 plain-path 条目写进 `settings.json` 的 `skills[]`，否则 pi 看不到它。

---

## 二、Q2：`~/.claude/skills` 在 Settings 看得到、composer `/` 看不到

### 2.1 现象

另一位用户的机器上：`~/.claude/skills` 有内容，Settings → Skills 页面能列出这些 skill，但 composer 输入 `/` 后的菜单里没有它们。

### 2.2 根因：两套并行的发现系统

Picot 维护着两套**互相独立**的 skill 发现逻辑：

| 系统 | 实现位置 | 数据去向 | 是否扫描 `~/.claude/skills` |
| --- | --- | --- | --- |
| **Settings inventory** | `extensions/skill-inventory.ts:423,469` | `list_skill_inventory` RPC → Settings 页面 | **是**（写死扫描全局/项目 `.claude/skills`） |
| **composer `/` 菜单** | pi 本体 `package-manager.js` | `getCommands()` → `/` 菜单与 `/skill:` 执行 | **否**（pi 默认不扫） |

`skill-inventory.ts` 里写死的 `.claude` 逻辑：

```ts
// L423 — globalRoots()
{ dir: join(home, ".claude", "skills"), mode: "agents", baseDir: opts.agentDir, scope: "user", ... }

// L469 — projectRoots()
{ dir: join(opts.cwd, ".claude", "skills"), mode: "agents", ... }

// L505 — isClaudeSkillDir()
return dir === join(home, ".claude", "skills") || dir === join(opts.cwd, ".claude", "skills");
```

这套 inventory 只喂给 Settings 页面，**没有接到 pi 的 `resourceLoader` 上**。所以 composer 的 `/` 菜单和 `/skill:` 执行都看不到这些 skill。

### 2.3 Dr. Lin 的修复原则（已确认）

Pi 默认不扫描 `~/.claude/skills`，这是 pi 有意的跨 harness opt-in 设计。Picot 的 Discovered 页签当初写死扫描 `.claude/skills` 并提供专属 Enable 按钮，造成了“看得到但用不了”的割裂。解法是回归单一发现源：

1. **删除 Discovered 页签里写死的 `.claude/skills` 自动发现**（`skill-inventory.ts` 的 `globalRoots()` L423、`projectRoots()` L469、`isClaudeSkillDir`、`claude-*` kind 判定等）。Discovered 列表此后只反映 pi 的默认扫描结果 + `settings.json` 已配置的 `skills[]` 条目，与 composer `/` 菜单**同一份数据**。
2. **不在 Discovered 页签新增任何“添加目录”入口**。用户若想加入 `~/.claude/skills`（或任意其它目录）的 skill，统一走 **Install 页签**——它已有完整的 “picker 选目录 → 扫描候选 → 勾选 → 写 settings.json” 流程，能完成这件事。`.claude/skills` 不再特殊。
3. 删除上述写死扫描后变成死代码的整条 Claude 专属链路（`mutateClaudeSkillRoot`、`skill_add_root` RPC、`parseSkillAddRootRequest`、前端 Claude 确认对话框与文案）。

### 2.4 这个方向的影响范围

这是纯删除工作，不加任何新功能：

- `extensions/skill-inventory.ts`：删除 `.claude` 相关的 root 声明、`isClaudeSkillDir`、所有 `claude-global`/`claude-project` kind 判定、`.claude` 的 `recommendedEntry`/`baseDir` 特殊处理。
- `extensions/skill-inventory.ts`：删除 `mutateClaudeSkillRoot` 函数与 `ClaudeRootKind` 类型（无调用方后即为死代码）。
- `extensions/embedded-server.ts`：删除 `parseSkillAddRootRequest`、`case "skill_add_root"` handler。
- `public/settings/skills-discovered-tab.js`：删除 `claudeRootOpener`、`beginClaudeRootConfirmation`、`cancelClaudeRootConfirmation`、`addClaudeRoot`、Claude 确认对话框、`isClaude` 分支及 Enable 按钮。
- i18n：移除 Claude 专属文案 key。
- 文档：标注 `2026-07-27-claude-skills-discovery-design.md` 被本文档取代；更新 `ARCHITECTURE.md` 的 Skills 资源边界（删 `.claude/skills` 候选、`{scope,kind}` 契约）。

向后兼容：

- 已经通过现有 Enable 把 `../../.claude/skills` 写进 `settings.json` 的用户，条目保持不变（它本就是合法的 plain-path 条目），pi 继续加载。Discovered 页面将其归为普通 `configured` root 显示。

### 2.5 已决定的设计点

以下决定已与 Dr. Lin 确认：

1. **Discovered 页签删除写死的 `.claude/skills` 扫描，不新增任何添加入口。**
2. **加任意目录（含 `.claude/skills`）的 skill 统一走 Install 页签**的现有流程，不在 Discovered 页签重复建设。
3. **Q2 是纯删除工作**——删死代码 + 清 UI + 清文档，不加新功能、不加新 RPC、不动 Rust。

---

## 三、Q3：`/skill:<name>` 发出去后 pi 没当成 skill 命令

### 3.1 现象

从 `/` 菜单选中一个 skill（例如 `superpowers` 下的 `brainstorming`），composer 里变成 `/skill:brainstorming`。发送后，模型并没有按 SKILL.md 的指令行事，而是自己用 bash + find 去磁盘上找 skill，然后"用自己的方式完成任务"。同样地，`/new`、`/quit` 这类命令发出去也不生效。

### 3.2 根因：Picot 用错了 pi 的发送 API

Picot 的 composer 发消息走 `embedded-server.ts:2361` 的 `case "prompt"`，它调的是 **`a.sendUserMessage(command.message)`**：

```ts
case "prompt": {
  const a = requireApi("prompt");
  if (!a) break;
  if (ctx && !ctx.isIdle()) {
    // streaming → deliverAs steer/followUp
    a.sendUserMessage(command.message, { deliverAs: "steer" /* or followUp */ });
  } else {
    // ...images...
    a.sendUserMessage(command.message);   // ← 关键
  }
  sendTo(ws, success("prompt"));
  break;
}
```

而 pi 的 `sendUserMessage`（`agent-session.js:1103`）内部是这样实现的：

```js
async sendUserMessage(content, options) {
  // ... normalize text/images ...
  // Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
  await this.prompt(text, {
    expandPromptTemplates: false,   // ← 刻意跳过所有 slash / skill / template 展开
    streamingBehavior: options?.deliverAs,
    images,
    source: "extension",
  });
}
```

再看 `prompt()`（`agent-session.js:799`）里依赖 `expandPromptTemplates` 的展开逻辑：

```js
if (expandPromptTemplates && text.startsWith("/")) {
  const handled = await this._tryExecuteExtensionCommand(text);   // /new /login ...
  if (handled) return;
}
...
if (expandPromptTemplates) {
  expandedText = this._expandSkillCommand(expandedText);          // /skill:foo
  expandedText = expandPromptTemplate(expandedText, [...]);       // /my-template
}
```

`expandPromptTemplates: false` 会**同时跳过**这三件事：

| `/` 开头的输入 | pi 正常处理（`expandPromptTemplates:true`） | `sendUserMessage` 处理（`false`） |
| --- | --- | --- |
| `/skill:foo` | 读 SKILL.md 包成 `<skill>` 块注入 prompt | **原样透传**给模型 |
| `/my-template` | 读 template 文件做参数替换注入 prompt | **原样透传**给模型 |
| `/new` `/quit` `/login` | 立即执行 extension command | **原样透传**给模型 |

### 3.3 为什么模型会去 bash + find

当 `sendUserMessage` 把字面 `/skill:brainstorming` 透传给模型时，模型收到的是一条以 `/skill:` 开头、却没有任何 skill 内容的普通用户消息。pi 本身没当命令处理，模型只能自行理解——它会"尽量满足用户"，于是用 bash + find 去磁盘找 `SKILL.md`。这是模型即兴发挥，**不是 Picot 或 pi 的代码在 shell out**。

对比 Pi TUI：`session.prompt(userInput)`（`interactive-mode.js:654`）默认 `expandPromptTemplates: true`，`_expandSkillCommand` 生效，skill 正常展开。所以同样的 `/skill:brainstorming` 在 TUI 里能用，在 Picot 里不能用。

### 3.4 核心约束

**pi 的 ExtensionAPI 不暴露任何"展开 skill/template"的方法**：

- 没有 `getSkills()` / `getPromptTemplates()`
- 没有 `expandSkill` / `expandPrompt`
- extension 唯一能往对话塞文本的口子是 `sendUserMessage`（不展开）和 `sendMessage`（custom message，也不展开）

所以 Picot **无法调 pi 的现成展开 API**，必须在 extension 侧自己复现 pi 的展开逻辑。

### 3.5 数据可得性（好消息）

`getCommands()` 返回的 `SlashCommandInfo`（`slash-commands.d.ts`）里：

```ts
interface SlashCommandInfo {
  name: string;              // skill 是 "skill:foo"，template 是 "my-template"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: SourceInfo;    // ← 含 path
}

interface SourceInfo {
  path: string;     // 对 skill 是 SKILL.md 的绝对路径；对 template 是 .md 绝对路径
  source: string;
  scope: "user" | "project" | "temporary";
  baseDir?: string;  // skill 的目录（strip frontmatter 后正文里相对引用的基准）
}
```

`sourceInfo.path` 经 `createSkillSourceInfo(filePath, baseDir, source)`（`skills.js:90`）设置——**就是 pi 加载时存的 `filePath`**。对 symlink skill，存的是 symlink 路径本身（不是 realpath），Node 的 `readFileSync` 能正确跟随；展开时 `location` 与 `References are relative to ${sourceInfo.baseDir}` 必须保留该元数据的原始语义。所以 Picot 完全有能力自己读文件展开。

### 3.6 Dr. Lin 的分流原则（已确认）

> `/` 是一个 command，在 GUI 里应该会被 btn / menu 实现；`/skill:<foo>`、`/<prompt_foo>` 这种注入 prompt 的，应该要支持。

翻译成 pi 内部的两类 slash command：

| 类别 | pi 内部处理 | Picot 期望 | 处理方式 |
| --- | --- | --- | --- |
| **extension command**（`/new` `/quit` `/login`） | `_tryExecuteExtensionCommand` 立即执行 | **不支持**（GUI 用按钮） | 放行，当普通文本透传即可 |
| **skill**（`/skill:foo`） | `_expandSkillCommand` 注入 prompt | **支持展开** | extension 侧读文件展开 |
| **prompt template**（`/my-template`） | `expandPromptTemplate` 注入 prompt | **支持展开** | extension 侧读文件展开 |

### 3.7 修复方案

在 `extensions/embedded-server.ts` 的 `case "prompt"` 里，调 `sendUserMessage` **之前**加一层分流。该分流在 idle 和 streaming 两个分支都要执行（见 3.8，streaming 也不展开）：

```text
text = command.message
if text 以 "/" 开头:
    commandName = text 第一个 token 去掉前导 "/"
    从 getCommands() 查找:
        (1) source==="skill" 且 name==="skill:"+commandName
            → 命中: 以 sourceInfo.path 读取文件，剥 frontmatter，
                    包成与 Pi 字节一致的 <skill name=.. location=..>...</skill>，
                    拼上剩余 args，用展开后的文本走 sendUserMessage
        (2) source==="prompt" 且 name===commandName
            → 命中: 以 sourceInfo.path 精确定位 template；读文件后先剥 frontmatter，
                    按 Pi 的 parseCommandArgs + substituteArgs 完整语义替换参数，
                    用展开后的文本走 sendUserMessage
        (3) 其它（extension command、未知 /、未知 /skill: 或未知 template）
            → 维持现状: 原样 sendUserMessage（透传）
# idle（含 image content）/ streaming 两分支统一先展开文本，再走各自的 sendUserMessage 路径
# 仅当已命中的 skill/template 的源文件读不到或不能解析时：
# sendTo(ws, error("prompt", message))，不发送；这是 Picot 有意选择的失败策略
# 未命中不是展开错误，必须透传以保持 Pi TUI 兼容
```

展开格式需复现 pi 的两个函数（保持注入内容一致）：

**skill**（复现 `_expandSkillCommand`，`agent-session.js:950`）：

```text
<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${stripFrontmatter(rawContent).trim()}
</skill>
```

尾部若有 args，追加 `\n\n${args}`。

**prompt template**（复现 `expandPromptTemplate` + `substituteArgs`，`prompt-templates.js:221–243` 与 `L29–67`）：以 `sourceInfo.path` 定位 template 文件，读文件后先剥 frontmatter，再按 pi 的 `parseCommandArgs` 解析 args（空格分隔 + 单/双引号），并完整支持 `$1`/`$2`…、`$@`、`$ARGUMENTS`、`${N:-default}`、`${@:-default}`、`${ARGUMENTS:-default}`、`${@:N}` 与 `${@:N:L}`。不得以简化正则替代 `substituteArgs`，也不得递归替换参数值中的占位符。

**关于重名**：pi 的 `dedupePrompts`（`resource-loader.js:702`）与 `loadSkills` 内部的 `skillMap`（`skills.js:305`）已对同名资源做先到先得的 winner 仲裁，`getCommands()` 返回的列表中 name 唯一，不会出现重名。因此展开匹配只需 `find(item => item.name === commandName)`；`sourceInfo.path` 仅用于读取源文件，不需要也不应用于区分重名。

### 3.8 streaming（steer/followUp）也受影响

最初怀疑 streaming 时 pi 的 `steer()`/`followUp()` 自带展开、Q3 只在 idle 发生。源码追踪后**否定**了这个假设：streaming 分支同样不展开。

完整调用链（`sendUserMessage` 在 streaming 时）：

```text
sendUserMessage(msg, {deliverAs:"steer"})
  → prompt(text, {expandPromptTemplates:false, streamingBehavior:"steer", source:"extension"})
      → expandPromptTemplates=false ⇒ 跳过 L823 _expandSkillCommand / L825 expandPromptTemplate
      → isStreaming=true ⇒ 走 L836 _queueSteer(expandedText)
          // ⚠ expandedText 此刻是原始 currentText（展开分支被跳过了）
```

关键点：`prompt()` 的 streaming 分支用 `expandedText` 这个变量名，但因为 `expandPromptTemplates:false` 让 L823-825 的赋值被跳过，该变量实际仍是未展开的原文（L818 的 `currentText`）。`_queueSteer` 是私有方法，注释明确写"already expanded, no extension command check"——它信任入参，不再二次展开。

注意区分：pi 的**公开** `steer()`/`followUp()` 方法（L983/L1000）确实自带展开，但 `sendUserMessage` 并不调用它们——它走的是 `prompt()` + `_queueSteer()`/`_queueFollowUp()`。Picot 的规范入口固定为 `sendUserMessage`；不得依赖公开 `steer()`/`followUp()` 的附带展开，以免将来重构重新造成分叉。

**结论：Q3 在 idle 和 streaming 两个分支都发生。** 修复时两个分支都要在 `sendUserMessage` **之前**做展开；`_queueSteer()` 和 `_queueFollowUp()` 都只接收已展开文本。

### 3.9 已决定的设计点

以下决定已与 Dr. Lin 确认（2026-08-07）：

1. **已命中源文件的展开失败时（文件读不到、frontmatter 不能解析）→ 显式报错并阻止发送**。通过 `sendTo(ws, error("prompt", message))` 返回；未知 skill/template 则维持原文透传。前者是 Picot 为避免把损坏或不完整的命令误交给模型而选择的产品差异；后者保持 Pi TUI 的未知命令语义。两者都符合 AGENTS.md “不要静默吞异常”。

2. **展开逻辑提取为 `extensions/skill-command-expansion.ts` 的纯函数模块**，由 `embedded-server.ts` 调用。该模块接收 `getCommands()` 的元数据和原始文本，返回“已展开 / 原样透传 / 显式失败”的判别结果；这样可对 Pi TUI 语义做独立、确定性的测试，并供未来其他 extension 入口复用。

3. **`getCommands()` 调用成本可接受**——纯内存读取（`resourceLoader.getSkills().skills` 已缓存）。实现以 command name 构建本次调用的索引或做受限查找，优先保证与 Pi 的同名解析和 `sourceInfo.path` 选择语义一致，不为微优化引入跨会话缓存。

---

## 四、三个问题的依赖关系

```text
Q2 (统一发现系统)
  ├── 删除 skill-inventory.ts 写死的 .claude 扫描
  ├── Discovered 页面改为通用"添加 skill 目录"
  └── 结果: Settings 与 composer / 菜单共享同一份 pi skill 数据

Q3 (composer 展开分流)
  └── embedded-server case "prompt" 加展开逻辑
      └── 依赖: getCommands() 提供的 sourceInfo.path (已具备)

Q1 (理解现状)
  └── 无需改动，纯分析
```

**Q2 和 Q3 相互独立，可分别实现。** 但两者一起做后，用户体验才闭环：

- Q2 解决后，`/` 菜单和 Settings 看到的 skill 完全一致（都是 pi 加载的那些）。
- Q3 解决后，`/` 菜单选中的 skill 能正确展开执行。

建议实现顺序：**先 Q3（影响所有用户、修复核心发送 bug），再 Q2（架构清理、影响 Settings 页面）**。

---

## 五、验证清单（实现时）

### Q3

- [ ] TDD：写失败测试——`case "prompt"` 收到 `/skill:foo` 时，展开后的 `sendUserMessage` 参数含 `<skill>` 块。
- [ ] TDD：`/my-template` 展开后含剥离 frontmatter 的正文和 Pi 等价的参数替换。
- [ ] TDD：template 覆盖 `$1`/`$@`/`$ARGUMENTS`、默认值、参数切片以及带引号参数；参数值不递归替换。
- [ ] TDD：同名 template/skill 已被 pi 仲裁唯一（`dedupePrompts`/`skillMap`），展开匹配 `find(item => item.name === commandName)` 始终命中 winner，不需也不应借助 `sourceInfo.path` 区分重名。
- [ ] TDD：`/new`（extension command）维持透传，不被展开。
- [ ] TDD：未知 `/foo`、未知 `/skill:foo` 和未知 `/<template>` 维持透传。
- [ ] TDD：symlink skill 的 `sourceInfo.path` 能正确 `readFileSync`，且 `location` 与 `References are relative to` 两行同 Pi TUI 一致。
- [ ] TDD：skill 有/无 args 的展开文本（含换行与末尾空白）与 Pi TUI 字节级一致。
- [ ] TDD：已命中 skill/template 的展开失败（文件不存在或 frontmatter 不能解析）→ 显式 `sendTo(ws, error("prompt", ...))`；未命中不得报错。
- [ ] TDD：**streaming 分支**（steer/followUp）同样做展开（见 3.8，两分支都要改）。
- [ ] TDD：idle image content 路径也使用展开后的文本，图片本身保持原样。
- [ ] `bun run vitest run extensions/embedded-server-skills.test.ts`
- [ ] `bun run check` + `bun run build:extensions`

### Q2

- [ ] TDD：`skill-inventory.ts` 不再产出 `claude-global` / `claude-project` root；无 `.claude/skills` root 出现在 global/project roots。
- [ ] TDD：`mutateClaudeSkillRoot`、`ClaudeRootKind`、`parseSkillAddRootRequest`、`case "skill_add_root"` 全部删除后，引用它们的测试同步删除/调整，无残留引用。
- [ ] TDD：Discovered 页签不再渲染 Claude 专属 Enable 按钮/确认对话框；已配置的 `../../.claude/skills` 条目仍被识别为普通 `configured` root。
- [ ] TDD：i18n 无 Claude 专属 key 残留引用，不显示 raw key。
- [ ] 更新 / 标注 `2026-07-27-claude-skills-discovery-design.md` 被取代；更新 `ARCHITECTURE.md` Skills 资源边界（删 `.claude/skills` 候选、`{scope,kind}` 契约）。
- [ ] `bun run vitest run extensions/skill-inventory.test.ts extensions/embedded-server-skills.test.ts public/settings/skills-discovered-tab.test.js`
- [ ] `bun run check` + `bun run build:extensions` + `bun run build:frontend`

---

## 六、附录：关键文件与行号速查

### composer `/` 菜单链路

| 文件 | 行 | 作用 |
| --- | --- | --- |
| `public/ui/skill-slash-command.js` | 8 | `activeSlashQuery` 匹配 `/` 输入 |
| `public/app.js` | 748–754 | 注入 + `loadSkills` 发 `list_skills` RPC |
| `extensions/embedded-server.ts` | 2252–2256 | `case "list_skills"` → `getCommands()` |
| `extensions/embedded-server.ts` | 807–830 | `normalizeSkillCommands` 映射 |
| `agent-session.js`（pi 本体） | 1829–1846 | `getCommands()` 构造 skill/template/extension 列表 |
| `package-manager.js`（pi 本体） | 1934–1975 | pi 默认 skill 扫描目录 |

### composer 发送链路（Q3 根因）

| 文件 | 行 | 作用 |
| --- | --- | --- |
| `public/app.js` | 3058–3084 | `sendMessage()` 发 `type:"prompt"` |
| `extensions/embedded-server.ts` | 2361–2421 | `case "prompt"` → **`sendUserMessage`** |
| `agent-session.js`（pi 本体） | 1103–1131 | `sendUserMessage` 用 `expandPromptTemplates:false` |
| `agent-session.js`（pi 本体） | 799–826 | `prompt()` 的展开门控 |
| `agent-session.js`（pi 本体） | 950–975 | `_expandSkillCommand` 展开逻辑 |

### Settings inventory（Q2 写死的 `.claude`）

| 文件 | 行 | 作用 |
| --- | --- | --- |
| `extensions/skill-inventory.ts` | 423 | `globalRoots` 写死 `~/.claude/skills` |
| `extensions/skill-inventory.ts` | 469 | `projectRoots` 写死 `<cwd>/.claude/skills` |
| `extensions/skill-inventory.ts` | 501–536 | `isClaudeSkillDir` / `recommendedEntry` |
| `extensions/skill-inventory.ts` | 1199–1216 | `mutateClaudeSkillRoot`（只接受 claude kind） |
| `extensions/embedded-server.ts` | 885–922 | `parseSkillAddRootRequest`（只接受 claude kind） |
| `public/settings/skills-discovered-tab.js` | 186–229 | Claude root 确认 / 启用 UI |
