# Subagents 设置页设计

**状态：** Draft，待评审；仅设计，尚未实施。

**日期：** 2026-09-30
**原型：** [`../prototypes/2026-09-30-subagent-settings-prototype.html`](../prototypes/2026-09-30-subagent-settings-prototype.html)，离线模拟，非运行证据。

## 1. 目标与边界

在 Picot Settings 新增 Subagents 页：左侧按「当前项目 / 全局」查看子代理定义，右侧只读展示 YAML frontmatter 与 prompt，按页签保存该名字的 model、thinking 覆盖；可在所选作用域创建新 `.md`。列出定义来源、在当前工作区的生效情况及同名遮蔽关系。执行方是已安装的 **Nico `pi-subagents`**，不是 Pi 内核自带的 agent 管理器；本页不启动、删除、编辑或安装子代理，不编辑 package `.md`，不接管 `/run` 或运行中的子代理。

两个页签首先是**文件归属与写入目标**，并非互斥的运行时视图。`/run` 使用当前会话 cwd 下 `agentScope: "both"`；全局设置可能影响项目代理，项目设置也可能覆盖全局定义。UI 不得把「只在该页签列出」译为「只在该页签生效」。原型的五条记录、模型选项、预览值、成功提示全是内存示例；刷新即消失，不可视为实现。

## 2. 核实依据与偏差

下列结论只基于本机安装的 `~/.pi/agent/npm/node_modules/pi-subagents/package.json:4` **0.73.1**、该包源码/文档、仓库代码与 Pi 随仓文档，不代表将来的兼容承诺。

| 依据 | 对本设计的影响 |
| --- | --- |
| `pi-subagents/src/agents/agents.js:216-248,304-314,320-392` | 包代理由包 `package.json` 中 `pi-subagents.agents` **或** `pi.subagents.agents` 声明；扫描项目/全局 npm、`settings.json` 的包源、项目根包，且可能扫描系统 npm root。目录不等于原型中示意的 `<cwd>/.pi/npm/example-review/agents`；实际 npm 路径含 `node_modules`，git/file 包路径又不同。列表须依据配置和 manifest，不递归把所有缓存 `.md` 当成已安装代理。 |
| `pi-subagents/src/agents/agents.js:567-631,2082-2095,2304-2350`；`docs/configuration.md:8-40` | 运行时项目根可能由最近 `.pi`/`.agents` 或 `projectRootResolution: "git-root"` 决定，不必等于 Picot 注册工作区 `<cwd>`。还可扫描递归 `.agents/`、额外 `agentScanDirs`、全局 `~/.agents/`、环境扫描根，并可用 `agentExcludeDirs` 排除；只扫 `<cwd>/.pi/agents/*.md` 会伪称列表等于 `/run`。 |
| `pi-subagents/src/agents/agents.js:1664-1672,1819-1840,2000-2038`；`src/agents/identity.js:1-23` | 递归扫描 `.md`，排除 `.chain.md`；有效文件要求 frontmatter 中 `name`、`description`，`package` 可使运行时名称变成 `package.name`，不能从文件名推断身份。读取原文展示，解析失败保留诊断，不假冒有效代理。 |
| `pi-subagents/src/agents/agent-selection.js:1-23`；`src/agents/agents.js:2570-2574,2631-2638,411-445`；`src/slash/slash-commands.js:85-108,599-647` | `/run` 按 `both` 发现并按运行时名解析；来源优先级 builtin < package < user < project，运行时注册代理还可进入发现结果；同名遮蔽按解析名、alias/localName 等匹配，不能只按显示名判定。异常定义还可能阻断同名调用。 |
| `pi-subagents/docs/agents.md:3-29,200-247`；`docs/models.md:3-41,111-145`；`src/agents/agents.js:966-1024,1270-1323` | 覆盖确为 `subagents.agentOverrides.<runtimeName>.{model,thinking}`；custom/package 代理 user→project 逐字段叠加，项目优先；builtin 的项目覆盖分支优先选项目条目，不照搬 custom 的逐字段合并（待真实场景核对）。frontmatter/默认值、provider 定向覆盖和单次 `/run` 参数也会影响结果。`thinking` 包含 `minimal/xhigh/max`、`false`，原型四档与空值语义不完整。 |
| `node_modules/@earendil-works/pi-coding-agent/docs/settings.md:3-24,330-355`；`ARCHITECTURE.md:295-305` | Pi 项目 `.pi/settings.json` 信任门控，嵌套 JSON 逐层合并；Picot 注册或打开工作区会尝试写 trust，但属于 best-effort，不能据注册状态断言项目配置实际已加载。 |
| `ARCHITECTURE.md:46-50,274-276`；`public/app.js:7219-7250`；`public/landing.js:361-371,466-504` | 现有 Settings 是 `settings-nav-item`/`settings-tab`，主会话的配置桥依赖运行时；landing 无绑定工作区，配置能力依赖按需创建的 global-only bridge。项目页必须隐藏或禁用并明确提示「先进入工作区」。 |
| `src-tauri/src/host_server.rs:2600-2621,2748-2840,2880-2920`；`src-tauri/src/host_config.rs:29-90` | 控制帧只准已认证 desktop owner；现有泛用 `settings_get/put` 的 global 路径硬编码 `~/.pi/agent`，非 global 可走绑定工作区，但 `settings_put` 接受整个对象、会覆盖并发修改，且 `agent_text_file_put` 只准根目录文件名，不可拿来读写嵌套 agent `.md`。需要专用窄操作，不能给 WebView 任意路径写权限。 |

Pi 的资源过滤由 Pi 管，扩展另有其扫描规则：`node_modules/@earendil-works/pi-coding-agent/docs/packages.md:187-245` 定义包过滤与同包作用域覆盖。`pi-subagents` 的包扫描直接读取本地包根与其 manifest，**不保证**逐项等同 Pi 的资源启停列表。需以当前安装版本实测禁用资源、未加载包、同包跨作用域时 `/run` 真正发现集；不可把 package-skills inventory 直接当成子代理权威数据。

## 3. 页面契约

1. 沿现有 Settings 导航新增入口，原型的独立侧栏只是布局示意；沿用 Picot 主题、i18n、焦点及移动宽度适配。左 master 按来源列条目，右 detail 展示 **实际文件原文**、解析出的名称/描述、来源作用域、路径、只读提示、覆盖编辑器；无选择、读取/解析失败、有未保存更改、保存冲突均提供可见状态。不要把原型中的 `baseModel: Inherit parent` 拼成伪造的 YAML。
2. 当前项目 tab：展示所绑定工作区 `<cwd>/.pi/agents` 及本项目安装包的候选；「新建」只写该 `.pi/agents/`，覆盖只写该 `.pi/settings.json`。全局 tab：展示 `~/.pi/agent/agents` 与全局包；「新建」只写该 `agents/`，覆盖只写 `~/.pi/agent/settings.json`。路径用主机解析出的 Pi agent root（尊重 `PI_CODING_AGENT_DIR`），不要把 WebView 中的 `~` 当真实路径。两个 tab 不复制、移动另一作用域的文件；包条目始终只读，覆盖只改 settings。共享包根出现于两种配置时注明双来源，避免重复假装两个不同文件。
3. builtin 不属于项目/全局 `.md` 或用户安装包。为避免漏列默认可运行代理，在全局 tab 增独立「扩展内置 · 只读」组，源路径与 bundled 名称如实显示；项目 tab 可以在状态说明中引用 builtin 作为被遮蔽来源，不把它混作项目文件。若已安装版本内置目录不存在、被 `disableBuiltins` 禁用或与用户定义冲突，按诊断展示，不硬编码 0.73.1 名单。跨页签同名条目继续分开列、以物理文件路径/包身份识别；标「当前工作区生效」「被 X 遮蔽」「禁用」「不可用/待验证」，并指出胜出者路径。全局 tab 的状态依赖当前工作区；无工作区时只标「全局候选，无法判断当前项目最终生效」。
4. 展示两个明确值：**本作用域已保存覆盖**（可编辑）与**当前工作区推算值**（带覆盖来源）。前者留空表示「删除本层字段」，不是强制写入 `"inherit"`；后者可由 global/project 覆盖、frontmatter、扩展默认、parent model、按 provider 覆盖及本次 `/run` 选项决定。builtin 与 custom 合并细节不同，以实际源码和运行结果为准。未掌握 live parent/provider/模型注册表时，只写「需运行时确认」，不得声称固定「生效模型」；保存后提示外部文件已更新、现有 Pi 会话可能仍用旧快照，需 `/reload` 或新会话并用 `/subagents-models`/`/run` 核实（`pi-subagents/docs/agents.md:246-250`、`docs/models.md:154-163`）。
5. 覆盖按 **解析出的 runtime name** 写 `subagents.agentOverrides[name]`，不按文件 basename、显示昵称或 package 的本地名写。每项允许无覆盖 / 合法 Pi 模型 ID / thinking 档位；`thinking: false` 和 `model: "inherit"` 若已有需可读、可保留，不可在用户仅改另一字段时误删。选项取 Pi live model registry 与模型支持档位，或提供可校验 ID 的文本输入；没有 live catalog 时不伪造原型中的两个模型。仅保存 model/thinking，不动同一条目既有 description/tools/disabled 等未知字段。覆盖同名时 settings 是**名字级**而非文件级：两个定义共用同一运行时名时，不可能只覆盖其中某个包文件；详情页须解释并指向同名胜出者。
6. 新建表单至少收集 name、description、**非空 prompt 正文**；修订后的原型已演示 prompt 输入、非空校验及同名来源确认，但创建仍只更新页面内存。实际实现须存标准 YAML frontmatter + 正文；新建后详情仍只读。校验扩展可解析的名字及描述、唯一目标文件名、碰撞/别名提示；有同名全局/包/builtin 时明确「新文件将遮蔽 X」，要求确认，不能静默声称新名字不可用。拒绝空正文、路径分隔符、`.`/`..`、控制字符、超长输入或不合法 YAML；文件名不必等于解析名的旧文件要按内容检测名称冲突。新建失败不遗留半文件。原型的同名判断只用模拟记录，真实来源与遮蔽关系仍需运行时验证。

## 4. 发现与 `/run` 对齐

建议以独立的 host-owned **只读盘点**为最小实施面，再返回结构化结果给 UI：`list(scope, workspaceId?) → {agentRoot, projectRoot?, entries[], diagnostics[], resolutionContext}`。每条候选携带 `runtimeName/localName/source/sourceScope/package identity/filePath/rawDefinition/parsedFields/readOnly/diagnostic`、在 `both` 下的 winner/被遮蔽原因；`getDetail(id)` 根据已盘点的受限真实路径重读并限量返回，避免客户端任意路径探测。磁盘源与当前会话 live 快照须区分。列表按两个页签物理归属投影，但**同一快照必须同时计算 `both` 的胜者**；不可分别调用 `discoverAgents(project)` 和 `discoverAgents(user)` 再拼接：两者的包、默认值、设置解析及合并语义不等价于 `both`（`agents.js:2511-2558`）。

实现前优先评估在受信 Pi 扩展上下文内能否获得精确的发现快照（源码中的 `discoverAgentSnapshot`/`discoverAgentsAll` 和 runtime registry 是内部模块，**不是已确认稳定、可从 Picot 直接导入的 API**；不要把读取另一个 npm 安装副本冒充内嵌 Pi 的 live 实例）。若无法可靠复用，按 0.73.1 的扫描、解析、来源优先、阻断诊断写窄只读适配层，并配与真实 `/run` 的对照测试；若无法证明 parity，就以「磁盘候选」呈现、关闭断言式「生效」标签。不要为了一个设置页重新实现执行器或 package manager。0.73.1 的 `agentScanDirs`、`.agents/`、`~/.agents/`、环境目录、runtime 注册代理可落在两个约定页签之外：至少以「其他来源（只读）」与诊断提示其可影响胜出；无法盘点动态 runtime 注册代理时显式显示「运行时扩展代理未纳入磁盘列表，生效未验证」。筛选不会改变 `/run` 的作用域。

项目 tab 的 `<cwd>` 必须取当前 Registered owner 的 canonical workspace root；但扩展可能在嵌套 `.pi`/`git-root` 解析成别的 projectRoot（`agents.js:567-631`）。**冲突时不允许把写到 `<cwd>/.pi/...` 描述为 `/run` 将读取。**盘点应给出工作区 root 与实际扩展 projectRoot 两者；存在分歧时按已拍板路径约束保留写入目标、禁用「会立即生效」文案，并阻止可能产生误导的创建/覆盖，提示待决的根选择策略。其他 Pi agent root / 启动 env 失配同理报错，不猜。

## 5. 保存、授权与恢复

建议专用 host control op：`subagents_inventory`（读）、`subagents_create`（创建）、`subagents_set_override`（仅该 runtimeName 的两个字段）。最终传输参数为 `scope`, `workspaceId?`, `candidateId/runtimeName`, `expectedRevision`, `model/thinking` 的显式 set/clear 操作，响应附新 revision、更新后的盘点与生效时机提示；标识符仅供 host 在授权快照中查找，**不是前端传任意绝对路径**。具体命名可在实施时调整，权限和行为不可缩水。

- 所有 op 限已认证 desktop owner，拒绝 LAN/browser。项目读写要求当前 Registered owner + 同一 workspaceId/generation + canonical root；进入异步锁前后与实际落盘前复验，跨工作区切换取消旧请求。即使全局 tab 可由 landing 使用，landing 也不能偷偷传 project cwd 或显示「当前项目生效」；全局读写只准 host 解析出的 Pi agent root。项目未受信或信任不可核实时拒绝项目盘点/写入，明确错误，不自动把 `defaultProjectTrust: ask/never` 当成允许。不可复用 host `settings_put` 的宽对象替换或 `agent_text_file_put` 的顶层文件操作（`host_server.rs:2749-2840`）。
- 覆盖写采用锁下重新读取 JSON 对象 → 比对目标 entry/revision → 只修改 `subagents.agentOverrides[name].model/thinking` → 临时文件 + 原子 rename；缺文件可建最小对象，损坏/非对象/超限或 `subagents`/`agentOverrides` 形状非法则**拒写**，不能覆写修复。清空两个字段时删除空 entry，但保留其余未知字段及其他代理和 Pi 配置；保持权限私有，检查符号链接/真实路径与目录逃逸。沿用/核实 `host_config.rs:29-90` 锁与 512KiB 限制，注意其 `write_json` 并不独自完成「锁内读-改-写」，须确保整个事务受同一锁保护；同时核对 Pi/其他扩展各自写 settings 的锁协议。
- 新建只准选中固定 agents 目录，安全验证父目录链及最终路径，`create_new` 排他写入到受限临时文件/最终文件（不得覆盖已有文件、symlink 或 package 文件）；落盘后复读并检查扩展可解析。失败清理新建临时文件；若写入后并发路径变化/验证失败，报告需人工检查，不悄悄声称回滚完成。
- 保存前按 revision 检测外部修改，冲突提示重新载入并保留用户草稿，不做 last-writer-wins。原文件已存在时保留备份/提供明确可恢复副本，故障后可按已保存的上一版恢复；备份不能含超出本功能需要的凭据副本到公开目录。原子替换可避免半写，但不能回滚已运行会话内存状态，外部进程并发写必须通过可重复测试验证。

## 6. 验证矩阵与验收

| 场景 | 必须证明 |
| --- | --- |
| 发现/来源 | 空目录、递归 `.md`、`.chain.md`、非法 YAML、`package` 前缀与 alias、内置、两类 manifest、npm/git/file 包根、系统 npm root、项目根包、排除/额外扫描目录；项目/全局重名与包同名；盘点候选与当前 0.73.1 `/run`、`/subagents-models` 的真实输出对照，差异标诊断。 |
| 覆盖 | builtin/package/全局/项目定义分别覆盖；global 值影响项目定义、project 值影响 global/package/builtin；逐字段 global→project 合并、provider 特定覆盖、frontmatter/default/per-run 优先链；清空本层恢复下一层、不丢其他 JSON 字段；thinking `false/minimal/xhigh/max` 与不支持模型档位报错。 |
| 信任/身份 | Registered 正确 wid、generation 与重绑；landing 仅全局；LAN/browser、伪造 workspaceId、过期 generation、未受信项目均拒绝；nested root 分歧禁误报生效；自定义 `PI_CODING_AGENT_DIR` 与 Windows/macOS/Linux 路径。 |
| 写入/恢复 | `.md` 创建排他、同名遮蔽确认、symlink/`../`/外部路径拒绝；settings 损坏/过大、锁冲突、并发外部改写、磁盘满、原子替换失败、恢复备份；包 `.md` 字节不变、其他设置字段不变。 |
| UI/生效 | 原型 master-detail、选中/空/错/未保存与键盘导航；跨 tab 与跨 workspace 旧详情失效，返回 landing 时项目内容清空；保存后只称「写盘成功」，已运行 Pi 会话 stale 显示并提示 reload/new session；真实模型列表不可用时不显示模拟值。 |

验收门槛：以上盘点与同一 cwd 的 `/run` 输出一致，或者明确降级为候选且不显示未经证实的生效；所有写入限定批准路径、失败不损坏旧文件；项目/全局在 landing 与跨工作区场景不串权；原型中的示意模型、模拟来源与静态路径不能混入真实 UI，用户输入的 prompt 须实际写入并校验。实施后按 `AGENTS.md` 运行聚焦检查及所涉 frontend/host 的相应测试；本轮仅文档，不执行构建或测试。

## 7. 待验证与评审项

1. 当前 Picot 内嵌 Pi 版本见 `scripts/pi-version.json:2`；0.73.1 子代理扩展内部发现接口是否可在该进程合法调用并拿到动态注册代理/实时快照？若否，盘点适配层与 `/run` parity 的可接受降级范围需先实测。
2. 扩展实际 resolved projectRoot 与已定 `<cwd>/.pi/` 写入目标冲突时，产品应禁止写并提示、还是允许调整作用域决策？本稿采取**禁止误导性写入**，不擅自改已拍板的目标路径。
3. Pi 包资源 filter、`autoload:false` delta、全局/项目包源的真正运行时行为与扩展本身的扫描规则是否一致？尤其禁用/未加载的包目录不能凭目录存在显示成有效 `/run`。
4. 模型下拉与 thinking 支持级别、`"inherit"`/`false` 的 UI 命名，以及 runtime 注册代理是否可获得可写 runtimeName，须用 live model registry 与当前会话验证；无法取得则使用校验输入或只读诊断。
5. 修订后的原型已演示非空 prompt 输入与同名来源确认，仍只操作模拟记录。实际创建的 YAML 序列化、真实同名遮蔽判断及确认流程需实现并验证；跨平台原子重命名、symlink 竞态与多写者锁兼容也须用真实文件夹验证。

**取舍：** 保留两个用户已定的写入页签，但状态以实际 `both` 解析为准；保留只读包定义，用名字级 settings 覆盖，不复制包文件；新建仅有限 frontmatter 与 prompt，不建设通用 YAML 编辑器。这样不会让设置页成为另一套与 Nico 执行语义分叉的子代理管理系统。
