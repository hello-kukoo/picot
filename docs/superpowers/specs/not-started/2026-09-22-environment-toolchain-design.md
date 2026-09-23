# Picot 环境与工具链维护设计

**状态：** Draft，待 Dr. Lin 评审
**日期：** 2026-09-22

## 目标

在 Settings 新增独立「环境」页，面向非程序员检查、安装和更新 Picot 常用的外部工具：

1. 以确定性的 host 白名单探测显示工具状态、版本和实际路径。
2. 对单项或全部选中工具，启动内嵌 Pi 的无会话 maintenance agent 实际安装或更新。
3. agent 只能使用 Picot 内置的官方文档 URL 与选中工具范围；结束后必须由 host 复检，不能只信 agent 文本或 exit code。
4. 支持 macOS 与 Windows；Landing 同样可打开、检查和维护。
5. 遇管理员权限、UAC、重启、非官方来源或额外工具时停止自动化，展示并允许复制本次实际维护 prompt，交用户手动继续。

## 非目标

- 不把系统工具混入现有「软件包」页。该页管理 Pi 的 npm packages/extensions/skills，不管理 Git/Python 等 OS 工具。
- 不把功能藏进「高级配置」。环境检查与安装是 onboarding/诊断功能，必须独立、易发现。
- 不支持 Linux 安装与更新；v1 不在 Linux 上显示受支持的维护动作。
- 不检查或安装 hunk。Picot 将内建 review/fixer 工作流，Hunk 不属于基础依赖。
- 不检查系统 Bun。Picot 启动使用内嵌 Pi/Bun，系统 Bun 不是前提。
- 不自行实现 Homebrew、winget、UAC、sudo、PATH 或 installer 的完整安装器。
- 不写 sqlite、不新增遥测、不把安装日志上传网络。

## 工具清单与分级

| 分级 | 工具 | 用途 | 官方入口 |
| --- | --- | --- | --- |
| 基础 | git | 版本控制、Git 面板、diff、历史、提交与 push | `https://git-scm.com/downloads` |
| 基础 | python3 | Python 项目、脚本与 agent 工具运行时 | `https://www.python.org/downloads/` |
| 基础 | npm | npm 来源 Pi extension 与 Node 工具 | `https://nodejs.org/en/download` |
| 基础 | uv | Python 工具/项目依赖管理 | `https://docs.astral.sh/uv/getting-started/installation/` |
| 可选 | officecli | Word/Excel/PowerPoint 的 agent 工具 | `https://github.com/iOfficeAI/OfficeCLI#readme` |

基础工具缺失时显著标红，但不阻止 Picot 启动或普通聊天。officecli 缺失标黄，只影响 Office 相关能力。

OfficeCLI 的官方入口固定为 README，而不是固化某条 npm 或 Releases 命令。maintenance agent 必须先读 README 中当前安装说明；README 指向 Releases 时，才下载对应平台 binary。

## 已验证事实

1. Picot 当前「软件包」相关实现（`src-tauri/src/package_manager.rs`、`public/settings/package-manager.js`）只管理 Pi 的 npm package source、extensions、skills 与 prompts，不适合承载系统工具。
2. Picot 已有 Landing 的 `--no-session` Pi runtime 路径；内嵌 Pi 是唯一可启动的 Pi binary，不能调用用户 `$PATH` 里的 `pi`。
3. Pi CLI 支持非持久 prompt 模式：`pi --no-session -p "<prompt>"`。适合一次性维护任务：完成即退出，不写 agent session。
4. `src-tauri/src/pi_launch.rs` 已为内嵌 Pi 子进程扩展 PATH，包含 Homebrew Intel/Apple Silicon、npm global bin 和 Bun 目录等常见路径。
5. `src-tauri/src/temp_resources.rs` 的 `~/.pi/tmp` 是 Picot owner-only 临时根。maintenance runtime 必须使用同一根，但不得复用 quick-chat 专用删除 token 逻辑。
6. OfficeCLI 官方 README 明确将安装 binary 交给 agent skill 指导；其安装路径可能随平台或版本变化，因此 Picot 只固定 README，不复制固定安装脚本。

## 页面位置与可用性

新增 Settings 顶级「环境」页：

- Landing 与已打开 workspace 都可访问。
- 打开页面不自动运行任何 command。初始状态显示「尚未检查」与**检查环境**按钮。
- 检查完成后显示**重新检查**。
- Landing 无可用模型时仍可检查；安装/更新按钮显示“先配置模型”，跳转模型配置页。
- 已有模型时，使用当前默认模型执行 maintenance agent；页面显示本次使用的 provider/model。

## 每项展示与操作

每项工具统一展示：

- 名称、用途、基础/可选级别。
- 状态：尚未检查、检查中、已就绪、缺失、不可执行、需更新、维护中、需人工确认、失败。
- 检测到的版本、实际可执行路径、官方 URL、上次检查时间。
- **检查**、**安装**、**更新**操作；缺失项仅显示安装，已安装项显示更新。
- 可展开的压缩过程日志与**复制详情**；日志不常驻占据页面。

页头提供**检查环境**、**重新检查**与**维护全部**：

- 维护全部仅处理基础工具中缺失或用户明确选择更新的项，以及用户勾选的可选 officecli。
- 执行顺序固定：`git → python3 → npm → uv → officecli`。
- 每项维护后立即 host 复检；失败或需要人工确认时停止后续项。

## Host 白名单探测

检查不使用模型、网络或 WebView shell。Rust host 通过固定 command 白名单启动短进程并解析版本：

| 工具 | 探测命令 | 版本来源 |
| --- | --- | --- |
| git | `git --version` | stdout |
| python3 | macOS/Linux `python3 --version`；Windows `py -3 --version` 后回退 `python --version` | stdout/stderr |
| npm | `npm --version` | stdout |
| uv | `uv --version` | stdout |
| officecli | `officecli --version` | stdout/stderr |

探测必须返回：规范 tool id、可执行路径、版本字符串、状态、失败原因、探测时间。

- 路径查找用与 Pi launch 一致的 PATH 扩展规则。macOS 同时覆盖 `/opt/homebrew/bin` 与 `/usr/local/bin`；不猜测用户 shell rc 文件。
- 找到文件但无执行权限/启动失败为 `不可执行`，与 `缺失` 区分。
- 每条探测设置短超时；超时为失败，不杀主 app。
- host 探测才是页面状态的唯一事实来源。

## Maintenance agent

### 启动与授权

用户点击单项安装/更新，或维护全部，即明确授权**本次选中工具**的官方安装/更新流程。Picot 启动内嵌 Pi：

```text
<embedded-pi> --no-session --approve -p "<maintenance prompt>"
```

- `--no-session`：不创建或污染当前聊天 session。
- `--approve`：用户已在环境页显式授权当前任务；无额外逐 shell command 弹窗。
- 同时最多一个 maintenance runtime；页面关闭不停止任务，其他维护按钮禁用。
- 用户可点**取消维护**；host 终止整个 Pi process tree，随后对已处理项执行 host 复检。
- 维护全部串行执行；一个工具失败、超时或需人工确认则停止。

### Prompt bundle

Picot 随包提供 `extensions/maintenance/install-tools-prompt.md`。它包含：

- 当前 OS 与架构、所选工具、维护动作（install/update）、检查前的版本/路径/状态。
- 上表内置官方 URL；OfficeCLI 使用 README URL。
- 工具范围白名单：只能处理用户本次选择的工具。
- 只使用内置官方 URL 及该官方页面直接链接的资源。
- 每项先确认当前状态，再安装/更新，再运行对应版本命令验证。
- 不得处理其他工具、凭据、项目文件、Git workspace 内容或系统设置。
- 遇 `sudo`、Windows UAC、Homebrew/winget bootstrap、重启、交互式安装器、非内置 URL 或额外依赖时，立即停止，不绕过、不替代、不猜测。
- 最终输出一行 machine-readable JSON（工具结果、是否需人工确认、原因）；此前的文本仅作过程日志。

环境页展示的维护 prompt 与实际传给 `-p` 的内容是**同一份**。暂停/失败时，用户可复制完整 prompt，交当前聊天 agent 或终端自行继续。

### 超时与验证

- 每工具有硬超时；维护全部另有整体硬超时。超时后终止 process tree、停止队列、host 复检。
- agent 的 exit code、自然语言总结和最终 JSON 都不是成功依据。
- 每项结束后 host 重新运行白名单探测；仅当预期 binary 能执行且版本被识别，页面才显示已就绪。
- agent 报成功但复检仍缺失、不可执行或版本未改变时，状态为**需人工确认**，并显示日志、官方 URL 与复制 prompt。

### 需人工确认

下列情况不继续自动化：

- sudo 密码、Windows UAC、管理员 installer 或系统重启。
- Homebrew/winget 等包管理器自身 bootstrap。
- 非内置官方 URL、重定向到未知来源、额外工具/依赖。
- 需要交互输入、许可确认、浏览器登录或 GUI 安装器。

页面显示原因、官方 URL、最后已验证状态和完整可复制 prompt。Picot 不收集密码、不弹伪造 UAC、不试图把交互式提权塞给 `--no-session` agent。

## 跨平台范围

### macOS

- 支持 Apple Silicon 与 Intel PATH。
- agent 可按官方文档使用已存在的 Homebrew、官方 pkg、curl 下载或 release binary。
- 没有 Homebrew 时，bootstrap 属“需人工确认”。

### Windows

- 支持 Git for Windows、Python Launcher、Node.js/npm、uv 与 OfficeCLI 的官方安装路径。
- UAC、winget bootstrap、MSI/EXE GUI installer 属“需人工确认”。
- host 取消维护必须终止整个子进程树，不能只结束外层 Pi。

### Linux

v1 不提供受支持的安装/更新入口；未来单独设计 apt/dnf/pacman/snap 等分发差异与提权体验。

## 状态机

```text
尚未检查
  → 检查中
  → 已就绪 | 缺失 | 不可执行 | 失败

缺失 | 不可执行 | 已就绪
  → 维护中
  → 已就绪 | 需人工确认 | 失败

维护中
  → 已就绪 | 需人工确认 | 失败
```

`需更新` 是用户主动点更新后的维护意图，不由页面联网比较“最新版本”产生。更新是否可用由 maintenance agent 按官方文档判断；最终仍由 host 本地版本探测确认。

## 安全与所有权

- Rust host：唯一执行环境探测、启动/取消 maintenance runtime、捕获 stdout/stderr、解析最终 JSON、执行最终复检。
- Prompt bundle：只定义维护范围和官方来源，不能替代 host 白名单与进程边界。
- WebView：只请求检查/维护、展示状态和日志；不执行 shell、不访问系统 PATH、不直接操作临时文件。
- maintenance agent：一次性、无 session、仅本次 prompt 范围；不读取或写入当前 workspace/session。
- 所有环境维护请求继承 desktop-owner 门禁；Landing 不放开给 LAN/mobile client。

## 测试与验证

1. **Rust probe 单测**：stub command runner，覆盖每个 tool 的 command/版本解析、PATH 命中、缺失、不可执行、超时和 macOS/Windows Python 回退。
2. **Prompt 单测**：选择单项/多项、OS、状态、官方 URL 生成的 prompt；断言 OfficeCLI 指向 README；断言未选工具、workspace、凭据不出现。
3. **维护编排单测**：固定顺序、逐项复检、失败停止、需人工确认停止、单例拒绝、取消 process tree、工具/整体超时。
4. **结果解析单测**：有效/无效最终 JSON；agent 成功但 host 复检失败转需人工确认。
5. **WebView 单测**：初始不自动检查、逐项信息展示、基础/可选样式、Landing 无模型禁用维护、日志展开、复制 prompt、取消/重试状态。
6. **跨平台手测**：macOS ARM/Intel 与 Windows 的缺失/已安装/需 UAC 各一例；真实安装后确认工具进入 Pi launch PATH。

## Follow-up

- 实施时更新 `ARCHITECTURE.md`：环境页的 desktop-owner 边界、host probe 白名单、maintenance runtime lifecycle/进程树取消、prompt bundle 所有权、`~/.pi/tmp` 临时资源边界与最终复检契约。
- Linux 安装支持。
- 已启用 skill/extension 的动态依赖声明与按需工具建议。
- “维护全部”后可选的更新检查策略。当前不做页面联网 version parser。
