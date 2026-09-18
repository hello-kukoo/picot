# Landing 配置运行时（bridge 服务 runtime）设计

## 状态

v1，2026-09-18。当日 grilling 会话（Dr. Lin）逐支拍板。前置事实全部经代码核实，
关键锚点：`landing.js:314`（隐藏名单）、`pi_launch.rs:263`（sessionless 契约）、
`main.rs:3240` 一带（ephemeral 候选管线）、`config-gateway.js` 头注释（配置数据面）、
upstream `main.ts:359`（`--no-session` → `SessionManager.inMemory`）。

上游 spec：`2026-09-14-landing-page-design.md`（landing 架构与「Pi 绑定页签
landing 全藏」的既成决议，本 spec 修订其数据面部分）。

## 问题

全新安装冷启动进 landing。Models、MCP、技能·软件包三个配置面的数据面是
ConfigGateway——它借 `picot-config` 扩展命令搭活 Pi runtime 的便车
（RPC prompt 进、`ctx.ui.notify` 出），而冷启动刻意零 Pi 进程。结果是：

1. 三个面在 landing 全藏（`LANDING_HIDDEN_SETTINGS_TABS` + 软件包子页排除），
   用户在进任何项目之前无处配置模型、MCP、包技能；
2. 旧的首启引导（工作区 shell 的 `maybeAutoOpenEmptyModelsDropdown` 空态弹层，
   `app.js:3971`）只在 app.js 里存在，landing 阶段永不出现；
3. 用户对「必须先配模型」零感知，这正是本次问题的起点。

Pi 进程本身不需要模型就能 spawn（`NativeLaunchSpec` 无 model 字段，模型经
`set_model` RPC 事后选择），所以工作区路径没有断：进项目后空态弹层会引导配置。
缺口纯粹在 landing 阶段：能力缺失 + 无感知。

## 方案一句话

landing 期间按需派生一个 sessionless、toolless 的 Pi 进程，专职当
picot-bridge 的宿主，为 ConfigGateway 全族 ops（模型目录/密钥/OAuth、MCP、
包技能清单）供数；进工作区即杀，工作区配置路径一字不动。

## 决议

| # | 决策点 | 决议 |
| --- | --- | --- |
| 1 | 载体 | landing 专属 **bridge 服务 runtime**：`--no-session` + `--no-tools`，cwd `~/.pi/tmp`，加载 picot-bridge，永不注册工作区、永不信任 cwd |
| 2 | 范围 | **A：landing-only 懒派生**。工作区照旧 foreground runtime 承载 ConfigGateway，`config-readiness.js` 不动。B（全局常驻配置面）留作二期 |
| 3 | 覆盖面 | Models 页、MCP 页（全局装有 pi-mcp-adapter 才显示）、技能·软件包子页。全部降级为 **global-only**（landing 无 project 可言，与 extensions/skills 的既有降级模式一致） |
| 4 | 生 | 用户激活任一 bridge 面时懒派生，页内 loading；冷启动仍零派生 |
| 5 | 死 | `enterWorkspace` 的 commit sweep 里杀（锁 Quick Chat 的同一处），复用 ephemeral registry 的 generation-checked 清理与窗口关闭 teardown，不新造生命周期管理器。landing 是单向的（全代码无返回路径），runtime 死一次即终 |
| 6 | 首启引导 | **条件卡片 (iii)**：检测到零凭据时 landing 显示「先配置模型」卡片，点击直达设置 Models 页签。检测走廉价 host 控制面 op |
| 7 | configuration 页签 | 维持隐藏，不进本期（project-scope 语义，无人点名） |

## 运行时契约

- `NativeRuntimeType` 新增 `Config` 变体。不复用休眠的 `Standby`
  （`#[allow(dead_code)]`，文档语义是 side-chat 预热池，挪用弄脏契约）。
  launch 契约把 `Config` 加入 sessionless 集合（拒绝携带 session path），
  `no_tools` 恒真。
- cwd `~/.pi/tmp`：host 派生前确保目录存在。该路径在 2026-09-03 决策中失去的
  是「工作区」身份，不是可用性；此 runtime 不注册、不进 sidebar、bucket 无涉。
- `extensions: vec![picot-bridge]`，`agent_root` 显式传入（凭据读写走
  `~/.pi/agent/`，与 cwd 无关），ephemeral registry 里登记为**非会话 kind**，
  会话分类、running 保护、sidebar 渲染一概不得把它当会话。
- 与 Quick Chat runtime 并存时互不干扰：各自独立定址三元组、各自的
  ConfigGateway 实例，都死于 commit sweep。

## 定址与就绪

- `landing.js` 自建 ConfigGateway 与 OAuth gateway（现状：landing 无 ConfigGateway，
  `landing.js:88` 注释）：`runtime.request` 走 `wsClient.sendRuntime` 同一
  v2 `runtime_request` 通道，`getTarget()` 返回 config runtime 的
  workspace/session/instance 三元组。
- 就绪门比工作区更简单：spawn 控制命令本身就是「等健康才返回」
  （`main.rs:3240` 候选管线：spawn → health-wait → generation-checked 提交），
  所以 `waitUntilReady` = spawn op resolve，不需要 foreground snapshot 门。
- OAuth 登录链在 Pi 进程内跑（`picot-config.ts:1088`），landing 行为与工作区
  平价，列入手动冒烟验证。回调监听与宿主网络行为随 runtime 继承，与
  工作区路径同源，`--no-tools` 不影响（它禁的是 agent 工具调用，不是端口监听）；
  不新增任何回调机制。

## 首启检测与卡片

- 新 host 控制面 op `has_any_credentials`：`~/.pi/agent/auth.json` 存在且非空，
  或 `models.json` 含带密钥的 provider，或 host env 命中任一 provider envKey。
  host env 即内嵌 Pi 继承的 env（fff 先例，`fff_config.rs` 注释）。
- provider envKey 清单：v1 在 host 侧复制 `picot-config.ts` 的清单，配一个
  **清单同步测试**（两边清单相等）防漂移。若后续清单增长过快，再议由扩展侧
  提供枚举 op。
- 卡片只在零凭据时渲染；设置面板关闭时重查，配置成功即消失。点击行为：
  打开设置面板并选中 Models 页签（触发懒派生）。

## ARCHITECTURE.md 修订（硬同步项）

第 46 行冷启动 invariant 增补：「冷启动仍零派生；landing 配置面按需派生
bridge 服务 runtime（sessionless/toolless，不注册工作区，global-only）」。
代码落地不同步此段即失败交付。memory bank 同步记录本决议。

## 验证

### Rust 单测

- `Config` 变体 launch 契约：sessionless（带 session path 报错）、toolless、
  bridge 扩展在列、cwd 指向 `~/.pi/tmp`；
- ephemeral registry 登记/清理：commit sweep 杀 config runtime；窗口关闭
  teardown 覆盖；kind 分类不含会话语义；
- `has_any_credentials` 真值表：auth.json 存在/空、models.json 带 key、
  env 命中、全无；
- 清单同步测试：host envKey 清单 == picot-config.ts 清单。

### 前端（vitest）

- landing 打开 Models/MCP/软件包子页触发懒派生（首次），loading 态渲染；
- 重复激活不重复派生；spawn 失败出错误态而非挂死；
- 零凭据 → 卡片渲染，点击打开设置 Models；有凭据 → 不渲染；
- 进工作区后 config runtime 停止（无进程泄漏断言）；
- 工作区 shell 回归：Models/MCP/软件包行为与现在一致。

### 手动 e2e（scratch HOME，本会话验证过的配方）

```bash
mkdir -p /tmp/picot-fresh
cd ~/tmp/PI/picot-v3
env -i HOME=/tmp/picot-fresh PATH="$PATH" USER="$USER" bun run dev
```

1. 冷启动 → landing，`ps` 无 Pi 子进程；零凭据卡片出现；
2. 卡片 → 设置 Models → runtime 派生（loading → 页面可用）→ 配一个 key；
3. 关闭设置 → 卡片消失；
4. MCP 页签：装/不装全局 pi-mcp-adapter 两种状态下的显示与隐藏；
5. OAuth 登录从 landing 走通；
6. 添加项目 → 进工作区 → config runtime 进程消失，工作区 Models 可用；
7. 新会话可建、可对话（链路本身没断，回归确认）。

## 二期议题（不在本期）

- B 方案：config runtime 升格常驻全局配置面，工作区也走它并删除
  `config-readiness.js`。代价是配置变更需要 fan-out 通知 N 个活 runtime，
  失效语义吃掉省下的复杂度；待 A 落地验证后再议。
- configuration 页签 landing 化（global agents.md / inline config 编辑）。
