---
name: upgrade-embedded-pi
description: Use when upgrading Picot's bundled embedded Pi runtime, changing scripts/pi-version.json, or evaluating whether a new Pi release, release note, RPC/session/provider change, or security fix can affect Picot.
tags: [pi, upgrade, compatibility, rpc, release, security]
---

# 升级 Picot 内置 Pi

## 核心原则

**内置 Pi 升级不是单纯改版本号。** 必须证明新 release 可获取、
Picot 使用的边界没有未处理的变化、真实 embedded binary 能通过 RPC
smoke，并且最终 diff 没有污染。

不要因为“Pi 更新频繁”“release note 很短”或“smoke 通过”而跳过兼容性
审查。Pi 的内部实现可以变化；Picot 经过的 CLI、stdio/RPC、extension、
session、provider/config 和安全边界不能无证据地变化。

本 skill 只指导升级和影响审查，不新增自动化脚本，不修改 Pi 上游源码，
不自动提交或推送。

## 触发前提

开始前：

1. 读取项目根目录的 `AGENTS.md`、相关 `ARCHITECTURE.md` 章节和本 skill。
2. 执行：

   ```bash
   git status --short --untracked-files=all
   git diff --stat
   cat scripts/pi-version.json
   ```

3. 记录当前版本、目标版本、Picot 分支和所有既有改动。现有改动归属
   不清时停止并询问；不得 `git reset`、`git clean`、`git restore`、覆盖
   文件或删除 fixture。
4. 确认唯一版本来源是 `scripts/pi-version.json`，确认
   `src-tauri/resources/pi/` 是 gitignored 构建产物。不要把用户 `$PATH`
   上的 Pi 当作 embedded Pi。

## 执行流程

### 1. 核验 release 和资产

在修改 pin 前，核验目标版本的可信上游 release：

- 查看 GitHub release、tag、发布日期、完整 release notes 和 source commit；
- 按 `scripts/fetch-pi-binary.js` 的实际 URL、平台和架构检查目标资产是否
  存在；
- 如果仓库发生重定向，记录最终 canonical repository，并确认 tag 与资产
  属于同一个 release；
- 读取 `SHA256SUMS` 或 GitHub asset digest。只有拿到官方 checksum 才能
  添加 `scripts/pi-version.json` 的 `sha256`，不能猜测或手填；
- 仅 npm 包版本存在不等于 embedded binary release 资产存在。

release/tag/资产无法核验、平台资产缺失、版本不一致或 checksum 无法确认时，
**No-Go**。

### 2. 建立 Picot 接触面清单

读取 `ARCHITECTURE.md` 中 embedded Pi、RPC、session、provider、security
相关章节，并搜索实际边界：

```bash
grep -RInE \
  'resources/pi|pi-version|fetch:pi|Command::new|spawn|stdin|stdout|stderr' \\
  src-tauri extensions scripts public tests
grep -RInE \
  '--mode|rpc|session|provider|model|extension' \\
  src-tauri extensions scripts public tests
```

整理清单，至少包含：

```text
Picot file:line | Pi 输入/输出 | 字段/命令/API | 最终消费者 | 对应测试
```

必须确认：

- Pi 的启动参数、cwd/workspace、stdin/stdout/stderr 和退出处理；
- RPC/JSON 事件是透传还是被 Picot 解析、重组、持久化或渲染；
- session 是 Pi 自己管理还是 Picot 读取/恢复/路由；
- provider/model/auth/config 是否由 Picot 构造或解析；
- extension/server adapter 的 API 和生命周期；
- 文件路径、静态资源、权限和 IPC 安全边界。

### 3. 审查 release notes 和 Pi source

先通读完整 release notes，不只看标题。把每条变更分为：

| 分类 | 必查问题 |
| --- | --- |
| RPC/JSON | 事件名、命令、字段、类型、delta、错误、stdout 是否变化？ |
| Session | 创建、恢复、文件格式、ID、cwd、生命周期是否变化？ |
| Extension | 注册 API、事件、回调签名、加载和退出生命周期是否变化？ |
| Provider/config | provider、stream、tool、usage、finish reason 是否变化？ |
| Security | 修复路径是否经过 Picot 的 embedded Pi 或 Picot 自己的 wrapper？ |
| Pi 内部 | 只改变 CLI/TUI/theme/内部算法且不流过 Picot 边界？ |

遇到 breaking change、安全修复、模糊摘要或直接相关关键词时，必须检查
source diff。优先使用上游 tag 的 compare/diff 或 source tarball；不必把完整
Pi 源码引入 Picot：

```bash
# 例：在临时目录检查上游 source，不写入 Picot 仓库
mkdir -p /tmp/pi-source-review
# 获取并解压目标 release source 后：
git diff <old-tag>..<new-tag> -- \
  packages/coding-agent packages/protocol packages/agent packages/client \
  packages/ai packages/tui
```

针对每条相关变更追踪：

```text
Pi release note 条目
→ old/new source 文件与符号
→ Picot transport/parser/wrapper file:line
→ UI/state/persistence 的最终消费者
→ focused test 或真实 smoke
→ 结论：继承 / Picot 需要修改 / 不触达
```

“Pi 已经修复，所以 Picot 安全”不是充分证据。必须说明 Picot 是否经过该路径；如果是 Picot 自己的路径，仍需修复或验证。

**直接相关而未完成 source 对照时 No-Go：** RPC schema、session
persistence/API、extension API/lifecycle、provider stream/config、路径/静态
服务/权限/IPC 和安全边界。

### 4. 先修改 pin，再获取资源

只有审查没有阻断项后，才修改 `scripts/pi-version.json` 的 `version`。
不直接编辑 `src-tauri/resources/pi/`，不顺手升级 `package.json` 中的 Pi
`devDependency`；后者只有在用户明确要求或兼容性证据要求时才处理。

然后执行：

```bash
bun run fetch:pi
./src-tauri/resources/pi/pi --version  # Windows 使用 pi.exe
```

确认实际版本、目标平台/架构和 checksum（若 pin 了 checksum）。`fetch:pi`
失败、binary 版本不匹配或产生非预期 tracked 改动时停止。

### 5. 审查 RPC fixture 漂移

先不更新 fixture 运行：

```bash
bun run smoke:pi-rpc
```

如果因新版本或 fixture 缺失失败，先记录失败原因，不要立即用 `--update` 把失败变绿。确认 release/source 审查完成后，才运行：

```bash
bun run smoke:pi-rpc -- --update
```

然后人工 review 新 fixture 与旧 fixture 的 diff，至少检查：

- `commands`；
- `stateFields`；
- `commandSources`；
- `eventTypes`；
- `promptAcceptance`；
- 任何字段删除、重命名、类型变化、顺序变化和错误响应变化。

fixture 必须来自真实目标 binary。保留旧版本 fixture；不得复制旧 fixture、
手工猜测 golden output，或只因 smoke 能通过就接受 contract drift。审查后再
运行一次不带 `--update` 的 smoke：

```bash
bun run smoke:pi-rpc
```

contract 漂移无法解释、真实输出与 Picot 消费路径不一致、或只更新 fixture 未处理代码时 **No-Go**。

### 6. 按影响面验证

至少执行：

```bash
bun run smoke:pi-rpc
bun run check
bun run test
bun run check:rust
```

如果修改了 extension 或构建流程，增加：

```bash
bun run build:extensions
```

对 RPC/session/跨进程变化，定向验证顺序为：

1. parser/state/extension 的 focused tests；
2. 新旧 RPC fixture/replay；
3. 真实 embedded binary 启动、prompt、事件流、tool/错误、退出；
4. session 新建、持久化、重启恢复（如 Picot 触达 session）；
5. provider/config/stream/tool/usage/error（如 Picot 触达 provider 层）；
6. 全量 `bun run test`、`bun run check`、`bun run check:rust`。

如果目标版本影响 loopback、文件路径、静态资源、locale 或跨进程通信，
不能只跑 smoke，必须跑完整 test。测试失败且无法证明与本次升级无关时
No-Go；不能删除、减弱或跳过失败测试。

## Go / No-Go 门槛

只有全部满足才报告升级完成：

- release、tag、平台资产和实际 embedded binary 版本可核验；
- 所有 release note 条目均已映射到 Picot file:line，或有明确“不触达”证据；
- 直接相关的 Pi source diff 已审查；
- RPC/extension/session/provider 相关验证通过；
- fixture 漂移有原因、有真实输出、有人工 review；
- smoke、相关测试、全量 test/check/check:rust 均通过；
- 未覆盖 `$PATH` Pi、未绕过 checksum、未使用 destructive git 命令；
- 最终 diff 无意外 lockfile、日志、构建产物或无关文件。

任一高风险边界未审查、版本/资产无法确认、contract 漂移无解释、真实 binary 失败、测试失败或工作树污染，停止并报告具体阻断项，不给出“兼容”结论。

## 最终审计和交付边界

执行：

```bash
git status --short --untracked-files=all
git diff --check
git diff --stat
git diff -- scripts/pi-version.json
git diff -- tests/fixtures/pi-rpc/<new-version>/contract.json
```

正常情况下，允许作为本次升级提交的 tracked 文件是：

```text
scripts/pi-version.json
tests/fixtures/pi-rpc/<new-version>/contract.json  # 只有确实新增且已审查
```

不得提交：

```text
src-tauri/resources/pi/
.cache/pi-binaries/
package-lock.json
临时 source/release 文件
无关用户改动
```

向用户汇报时必须包含：旧/新版本、release/source 审查结论、涉及的 Picot
接触面、fixture 是否漂移、验证命令和结果、剩余风险，以及最终建议提交
文件。不要未经用户授权执行 commit、tag、push。

## 常见错误

| 诱因 | 正确处理 |
| --- | --- |
| “release note 没写 breaking change” | 检查 source diff 和 Picot 接触面；摘要不是证明。 |
| “smoke 通过就够了” | 先审查 fixture drift，再跑完整验证；smoke 只覆盖有限 RPC contract。 |
| “直接 `--update`” | 先无 update 观察失败，再人工 review真实新输出，最后重跑 locked smoke。 |
| “Pi 上游修了安全问题” | 逐条证明 Picot 经过该路径，区分 Pi 继承修复与 Picot 自身边界。 |
| “40MB 下载太慢” | 不关闭 checksum、不手工替换、不使用 PATH 中的 Pi。 |
| “工作树有改动，先 reset/clean” | 记录并保护既有改动；归属不清时停止询问。 |
| “package.json 里的 Pi 版本也顺便同步” | 只有用户明确要求或兼容性证据要求时才改，避免扩大范围。 |

## 完成前自检

- [ ] 已核验 release/tag/平台资产和实际 binary 版本。
- [ ] 已读取完整 release notes。
- [ ] 已检查所有相关 breaking/security 条目的 source diff 和 Picot 路径。
- [ ] 已先运行不带 `--update` 的 smoke，再审查后更新 fixture。
- [ ] 已保留旧 fixture，解释所有 contract 漂移。
- [ ] 已运行 focused tests、`bun run test`、`bun run check`、`bun run check:rust`（按影响面适用）。
- [ ] 已检查 `git diff`，没有覆盖既有改动或生成意外文件。
- [ ] 未提交资源目录，未执行未经授权的 commit/tag/push。
