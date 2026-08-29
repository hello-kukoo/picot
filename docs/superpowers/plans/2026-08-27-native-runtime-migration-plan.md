# Picot Native Runtime 迁移实施计划

> 依据：`docs/superpowers/specs/2026-08-27-native-runtime-migration-design.md`（**R4.5**）。
> 同步记录：R4 已核验已提交 workspace registry（`7acbc0a`）并标记 Gate R 为 partial；R4.1 收尾 P5/P6/P7 依赖与 endpoint 归属；R4.2 将 Gate R 改为 migration-owned **WP-R.1–R.5**；R4.4 收敛 tmp snapshot、`runtime.*` ingress guard、Foundation/P0 分名与 decision gate 规则；R4.5 双文档评审收尾（Gate B exit D8 修正、Gate D 任务改 GD 命名、P4 依赖对齐 spec、§19 补 3 条停止条件、R2 补拒启场景、WP-R 单包估算、CP 增 P4/P6）；R4.6 锁定 Gate B-design 交接语义（B-GAP owner 归属随 phase exit 关闭，Gate B 文档 §13/§14；spec P1 依赖限定 design closure）；R4.7 同构拆分 Gate C（C-GAP-01–11 随 phase exit 关闭、C-GAP-12 阻塞 design closure，Gate C 文档 §15/§16；spec P1 依赖限定）；R4.8 C-GAP-12 语义精化——源码抽取完成，阻塞项转为 embedded Pi `0.84.2` parity/trust/collision runtime 证据；R4.11 首窗口恢复策略重定（component 测试 + WP-R.6 graceful degradation + runbook；artifact 演练/restore tool deferred v3→v4）。
> 开工门槛（不可协商）：任何改变生产启动路径、WebView origin、认证链、spawn 路径或路由行为的 work package，必须先通过其显式 Gate dependencies，并取得 spec §16 **Blocks** 列指向该 work package 的全部决策。WP-R（§3）仅限 additive authority API 与 `runtime.*` fail-closed 守卫；Foundation F0（§2）仅限只读盘点、测试基建和性能测量；二者不触碰上述生产路径。
> 所有生产迁移 work package 必须以本计划和 R4.4 spec 的较严要求为准。估算基准：1 名熟悉本仓库的工程师全职、每工作包至少一次评审。P3 在 Gate D 完成 adapter prototype 前**不作固定人日承诺**。总排期须在 Gate R/A–D 后重估，且包含至少两个稳定 release 周期。

---

## 1. 总览

### 1.1 交付物

| 类别 | 交付物 | 路径 |
| --- | --- | --- |
| 工具 | 迁移矩阵提取脚本 + 漂移检查 | `scripts/migration-inventory.mjs`、`scripts/check-migration-inventory.mjs` |
| 工具 | mutation 类型单一来源 + parity 测试 | `shared/mutation-types.json` |
| 工具 | 性能基线 harness | `scripts/perf-baseline.mjs` |
| Gate R | authority 收编（WP-R）+ N-1 recovery 演练记录 | WP-R PRs + `docs/superpowers/specs/2026-08-27-registry-runtime-readiness.md` |
| Gate A | 权威迁移矩阵 | `docs/superpowers/specs/2026-08-27-migration-inventory.md` |
| Gate B | protocol v2、capability、LAN、限额设计 | `docs/superpowers/specs/2026-08-27-protocol-v2-capability.md` |
| Gate C | launch/lifecycle contract | `docs/superpowers/specs/2026-08-27-launch-contract.md` |
| Gate D | UI parity、adapter prototype、rollout 政策 | `docs/superpowers/specs/2026-08-27-ui-parity-and-rollout.md` |
| 决策 | D1–D10 回填 spec §16 + 开工许可会议纪要 | R4 spec §16 |
| 代码 | P0–P8 分阶段 PR | 见 §9–§17 |
| 发布 | dogfood → cohort → default-on、N-1 rollback 演练 | 见 §18、§22 |

### 1.2 依赖图

```text
Foundation F0（只读工具/测试基建）
   │
   ├─→ Gate A（矩阵）───────────────────────────────────────────────┐
   ├─→ Gate B/C/D 文档与原型（不可替代 Gate R）─────────────────────┤
   └─→ Gate R（WP-R authority 收编，migration-owned）──────────┤
                                                                        ▼
             P0 前置：Gate R closure + Gate A + Gate C
             （另加各 work package 的 §16 Blocks 决策）
                                          │
                                          ▼
                       P0 ─→ P1 ─→ P2 ─→ P3(dogfood)
                                                   │
                                      P3 ─→ P4 ─→ P5 ─→ P6 ─→ P7 ─→ P8
                                                                        │
                                      2 稳定 release 周期 cohort ──────┘
```

- Gate R、A–D 可各自开展盘点/设计；准入按 spec §6：**migration P0 需 Gate R + A + C + 所有 Blocks 指向 P0 的 §16 决策；P1/P2/P3 需各自显式 Gate dependencies 与 Blocks 决策均通过**。D8 仅阻塞 P7/P8，D10 仅阻塞 P3/P8；二者不阻塞 migration P0。任一 Gate 未过前，只允许 Foundation F0 只读工具与基建（及开工门槛例外中的 WP-R）；不得以共享抽取或任何名义提前触碰生产启动路径、origin、认证链、spawn 或路由。
- P1 不能用 mock、裸 `wid → root` map 或 browser root 填补 Gate R；测试 double 只能验证已交付 API 的调用，不是 authority 临时代替品。
- P3 需 Gate D adapter prototype 证明现有 shell 可经 host origin 工作后才能重新估算和排期。

### 1.3 时间估算与重估点

| 阶段 | 当前估算 | 说明 |
| --- | --- | --- |
| Foundation F0 | 4 人日 | 只读工具、parity 基建、性能基线 |
| Gate R | 4–5 人日（WP-R.1–R.5，见 §3；可与 Phase 0 并行） | registry authority 收编改造 + `runtime.*` namespace + N-1 演练 |
| Gate A | 2 人日 + 评审 | 工具输出后人工复核 |
| Gate B | 5 人日 + 评审 | 协议、capability、Operation Registry wire、完整 in/out limit matrix |
| Gate C | 4 人日 + 评审 | launch contract 逆向取证 |
| Gate D | 4 人日 + adapter prototype + 评审 | parity matrix、namespace、rollout、existing-shell adapter feasibility |
| 决策会 | 0.5 人日 | D1–D10；Gate R evidence 纳入开工许可 |
| P0 | 3 人日 | 零行为抽取 |
| P1 | 12–15 人日 | lifecycle + Operation Registry + turn-bound abort + Gate R authority 收敛 |
| P2 | 9–12 人日 | canonical wire、capability、安全/限额 integration |
| P3 | **Gate D prototype 已量化（2026-08-29）：coding 19–29 人日**（原型证据 §3；不含 P1/P2 substrate 与 dogfood 窗口；static/origin 2–3、映射表 5–8、E2E 5–8、compat 3–5） | host origin + existing UI adapter + 双态 parity；旧「5 人日」作废 |
| P4 | 7–9 人日 | 数据/session + Cost Dashboard complete compatibility operation |
| P5 | 8–10 人日 | files/config + OAuth 唯一 phase ownership |
| P6 | 6–8 人日 | 重集成与 HTTP binary paths |
| P7 | 8–10 人日 | 聊天 RPC 主路径与 protocol completion |
| P8 | 5 人日 + 发布周期 | 删除、artifact、N-1 rollback、文档 |
| **合计** | **Gate D 后重估** | 上表各阶段中位累加约 95–105 人日（另加 F0/Gates/发布周期）；「重估」指 P3 及其后按 adapter prototype 证据重新基线化，非以旧 70–77 人日承诺替代风险 |

### 1.4 协作与 PR 规则

- Gate R/A–D 每份产物完成后，独立 reviewer 对照 R4 exit criteria 逐项审查；Dr. Lin 终审。
- P1/P2/P3/P5/P7 完成时，做一次 spec consistency review，重点防 authority、protocol、OAuth lifecycle 漂移。
- 每 PR：focused test → 相关套件 → `bun run check` / `bun run check:rust`（按改动域）。
- P3–P7 不得向 `public/native/*` 添加功能；该 shell 仅能 bug fix，且 PR 必须声明不扩大能力面。

---

## 2. Foundation F0 — 立即可做的只读工具与测试基建

全部 work package 不得更改生产启动、origin、认证、spawn 或路由。

### WP0.1 迁移矩阵提取脚本（2 人日）

新建 `scripts/migration-inventory.mjs`：

- 解析 `extensions/embedded-server.ts::handleApiRoute`，提取 method + normalized path，必须覆盖 `startsWith` 路由；
- 解析 `handleCommand` command 分发表（switch/case 或 if-chain），提取 command、响应、stream event；不可只 grep `urlPath ===`；
- 提取 `/ws` upgrade、browser connection、OAuth command、`extension_ui_response`；
- 扫描 `public/**/*.js`、HTML、tests、外部脚本/LAN client 的 `fetch(`、`sendControl(`、`postRpc`、URL、`broker_control` command；
- 扫描 `broker_ws.rs::dispatch_control` controls 与 `host_router.rs` v2 frames；
- 输出人读矩阵 `docs/superpowers/specs/2026-08-27-migration-inventory.md`，以及机器 diff `scripts/gen/inventory.json`。

验收：embedded HTTP、`/ws` command/event、静态资源、caller 均可被抽取；抽样与人工核对零差异；route 数量由生成产物记录，**不得在计划中硬编码为删除依据**。

### WP0.2 漂移检查（0.5 人日）

- 新建 `scripts/check-migration-inventory.mjs`：重跑提取并与 `scripts/gen/inventory.json` diff；差异非空即非零退出。
- 接入 `package.json` 的 `check:inventory`；Gate A 后至 P8，修改 embedded surface 或 production caller 的 PR 必须更新矩阵。
- 允许审计 exception，但 exception 必须有原因、owner、失效期限；不得用 exception 长期隐藏 production caller。

### WP0.3 mutation 类型单一来源（1 人日）

- 新建 `shared/mutation-types.json`。当前基线为 **14 项**，与 `public/native/runtime-gateway.js`、`host_router.rs`、`native_pi_manager.rs` 当前三处一致；不是 16 项。
- JSON 成为唯一 source；三处现有列表是被迁移/被验证对象，不得将其“并集”自动视为正确行为。
- Rust 使用 `include_str!` + `OnceLock<HashSet<_>>` 解析，JS 由构建/测试读取 checked fixture；Phase 0 只加 parser/parity test，不切生产行为。
- 对未知 command 明确默认策略，并由 Gate A 决定是否是 mutation；不得因列表缺项静默变 read。

验收：JSON ↔ JS ↔ Rust parity 绿；14 项 baseline 有 fixture；生产路径无 diff。

### WP0.4 性能基线 harness（0.5 人日）

**重定域（2026-08-29，Dr. Lin）：自动基线不跑**；性能改为手工 e2e 时人工判断（P3 dogfood/parity 阶段执行）。`scripts/perf-baseline.mjs` 保留为可选工具（需运行中 legacy server，`PICOT_BASE_URL` 指向；已含 rpc/files 两项自动采样与 prompt/session/cost 的 manual 占位）。原验收「跑通一次并落盘」由本决定替代，报告文件不再作为 F0 交付物。

新建 `scripts/perf-baseline.mjs`，对运行中 legacy embedded-server 记录：

- `/api/rpc get_state` P50/P95（至少 100 样本）；
- prompt → 首个流事件 P50/P95；
- `/api/files` 1k entries；
- session list/search 与 Cost Dashboard（明确 scope/filter）基线；
- OS/version、硬件、embedded Pi version、build mode、session 数、JSONL bytes、目录规模、cache、样本、warmup、percentile 算法。

输出 `docs/superpowers/specs/2026-08-27-perf-baseline.md`。数值不在 Phase 0 判定，通过后作为 P3+ 性能门槛基线。

**Foundation F0 exit：**工具及测试合入；`bun run test`、`bun run check`、`bun run check:rust` 绿；无 production path diff。

> **状态（2026-08-29）：exit 达成。** 三支柱当日全绿（`bun run check` 456 文件含 design-css 通过；`bun run test` 全量；`bun run check:rust`）。既有欠账清偿：style.css 13 项 noDescendingSpecificity 以整体搬移修复（纯重排，行集合守恒验证，计算样式不变）；`community-extensions.json` 按「Picot 为 consumer、不负责生成/上传」原则（Dr. Lin 2026-08-29）自 biome 排除；`scripts/gen/inventory.json` 格式归一。WP0.4 按同日决定重定域为手工 e2e。生产路径零 diff（本阶段改动均为文档/工具/既有欠账）。

---

## 3. Gate R — Registry authority 收编（migration-owned）

registry 已按其自身设计交付（`7acbc0a`）。Gate R 不再是外部等待项：本迁移以下列工作包把已交付实现改造成 spec §3 要求的 host authority contract。WP-R 与 Phase 0 并行启动；全部 PR 为 additive 只读 API + fail-closed 守卫，不触碰开工门槛禁止的生产路径。任何 API mock 仅可用于已交付 contract 的测试，不可替代 readiness。

### 当前交付状态（R4 核验：`7acbc0a`）

registry 已提交 SQLite 数据源、`workspace.list/add/remove/pin` 与 `preference.*` v1 controls、默认 `~/.pi/tmp` 启动根与 Quick Chat 0700/token 清理边界——这些是 Gate R 的有效输入，**不是 Gate R 完成证明**。当前缺口：

| Gate R contract | 当前实现 | 结论 |
| --- | --- | --- |
| `workspace_id_for_canonical_root`（只读） | `MetadataStore::workspace_id_for_path()` 未注册时会写 `add_workspace()` | 不可用作 authority lookup |
| `canonical_root_for_workspace_id` | 仅 `get_workspace(wid)` | 需显式只读 adapter 与稳定 `not_registered` 语义 |
| `owner_current_workspace` 原子快照 | `current_workspace()` 与 `current_workspace_generation()` 分开读取，owner record 无 wid | 存在 TOCTOU；必须新增原子 API |
| `pref_get("runtime.native_origin")` release authority | `preference.set/delete/list` 允许 Native owner 任意 key | 必须增加保留 namespace 与内部 writer policy |

debug native path 的随机 `native-UUID + HashMap<wid, root>` 与 `HostDataPlane` 启动期 map 只能作为当前调试证据；不得被 P1/P3 复用成终态 authority。P1/P3 在 Gate R exit criteria 全部满足前保持 blocked。

### WP-R 工作包（migration-owned，可与 Foundation F0 并行）

| # | 内容 | 代码落点 | 测试 |
| --- | --- | --- | --- |
| WP-R.1 | 拆分只读 `workspace_id_for_canonical_root(&self, root) -> WorkspaceId`（未注册路径返回稳定 `not_registered` 错误，不写 DB）；不复用、不改动写路径 `workspace_id_for_path`（注册语义保留给 sidebar 注册表流程） | `metadata_store.rs`（新增 `&self` 方法，绕过 `add_workspace()` 副作用） | 未注册路径返回 `not_registered` 且 DB 零写入（前后 row count 断言）；已注册路径与 `workspace_id_for_path` 幂等一致 |
| WP-R.2 | `canonical_root_for_workspace_id(&self, wid) -> CanonicalRoot \| not_registered` 显式只读 adapter | `metadata_store.rs`（包 `get_workspace`，返回语义化错误而非裸 `Option`） | wid 不存在/已删除 → 稳定 `not_registered`；root 与注册行一致 |
| WP-R.3 | `OwnerRecord` 增持 `workspace_id: Option<WorkspaceId>`；新增单锁 `owner_current_workspace(&self, owner) -> OwnerWorkspaceSnapshot` 判别联合：`Registered {wid,root,generation}`、`Temporary {root,generation,temporaryKind}`、`NoWorkspace`。unregistered tmp 仅可为 Temporary，不能伪造 wid；v2 target/route/capability/OperationScope 仅接受 Registered | `window_owner.rs`（`create_owner` 与 transition commit 同步维护 wid；调用方 `main.rs`/`broker_ws.rs`/`ephemeral_registry.rs`/`terminal_*` 适配） | variant 三字段同锁一致；transition 不返回混合态；Temporary 无 wid 且 v2 admission fail closed；旧拆分读取等价迁移测试 |
| WP-R.4a | storage/internal rollout authority：`runtime.*` 保留 namespace；新增仅 rollout-authorized internal reader/writer（如 `runtime_pref_get/set("runtime.native_origin")`），reader 的 read/schema/value failure → legacy；writer 记录不含 key/value 的脱敏审计 | `metadata_store.rs` | internal reader/writer authorization；fail closed；审计事件无 key/value |
| WP-R.4b | public ingress closure：以 Foundation F0 / Gate A inventory 列出的**全部** `preference.*` public ingress 为输入，在 dispatch boundary 拒绝 `runtime.*` key、`runtime` 前缀变体、prefix enumeration；未完成 inventory 前不得宣称 namespace exit 达成 | 每个 inventory 命中的 preference control/HTTP/WS adapter；不得只假定 `workspace_controls.rs` | 每个 ingress × get/set/delete/list × `runtime.*`/`runtime` 前缀全拒绝；普通 Native owner 无法读/枚举/写/删；无未盘点 ingress |
| WP-R.5 | R4.11 重定域：component 级 schema/恢复测试保持全绿（`scripts/recovery-rehearsal.mjs` 已有 component 部分）；artifact N-1 演练 deferred 至 v3→v4 窗口（spec §13.2 recovery posture） | `scripts/recovery-rehearsal.mjs`（component）+ 未来窗口 artifact 对 | component 案例全绿；未来窗口义务在案 |
| WP-R.6（R4.11 新增） | DB graceful degradation：`MetadataStore::open` 失败/损坏 → 自动隔离（改名留存）+ 重建 + 脱敏日志；runbook 记录手动恢复路径（删 `picot.sqlite3` 重建） | `metadata_store.rs` | 损坏文件/open 失败注入测试：隔离文件存在、新 DB 创建、app 可启动、日志无敏感内容 |

**WP-R exit = Gate R exit criteria**（spec §3）：四 authority API 可用、无第二 authority、`runtime.*` fail closed、tmp 策略测试齐、N-1 演练记录归档；评审通过后 P1/P3 dependency 解锁。

单包估算：WP-R.1 0.5 / WP-R.2 0.5 / WP-R.3 1–1.5（含 5 处调用方适配）/ WP-R.4 1 / WP-R.5 1 / WP-R.6 0.5–1（R4.11 新增）（人日），合计 4.5–5.5 人日（§1.3）。

### R1 必须可用的 authority API

```text
workspace_id_for_canonical_root(root) -> WorkspaceId | not_registered
canonical_root_for_workspace_id(wid) -> CanonicalRoot | not_registered
owner_current_workspace(owner) -> OwnerWorkspaceSnapshot // atomic

OwnerWorkspaceSnapshot =
  Registered { wid, root, generation }
  | Temporary { root, generation, temporaryKind }
  | NoWorkspace

pref_get("runtime.native_origin") -> Option<bool>
```

要求：

- inverse lookup canonical、只读，无 browser-provided root fallback；`workspace_id_for_canonical_root` **不得**复用会写 DB 的 `workspace_id_for_path`；`canonical_root_for_workspace_id` 以稳定 `not_registered` 失败，不得以隐式 `Option` 或临时 map 表达；
- owner snapshot 原子返回判别联合；仅 Registered 具 wid 且可进入 v2 target/route/capability/OperationScope，Temporary/NoWorkspace 必须走明确 policy 或 fail closed；禁止分别读 cwd、port、generation 后拼接或为 tmp 伪造 wid；
- `~/.pi/tmp` 是未注册、fresh-session、仅 live 可见的 default startup root：不得 add/touch registry，不得跨重启成为 `wid→root` authority；Quick Chat 使用 token 化 0700 child directory，其 child lifecycle、symlink/root-delete guard、cleanup 与 default startup runtime 分别建模测试；
- Rust 可在 launch time 读取 `runtime.native_origin`；`runtime.*` 为保留 rollout namespace：公开 `preference.get/set/delete/list` 对其全部 fail closed，仅 rollout-authorized internal host path 可写并记录脱敏审计事件；read/schema/value 失败均 fail closed 为 legacy，release 不读取 debug env；
- `HostDataPlane` 可只通过 registry adapter 查询，不保留 `workspace_roots: HashMap` 第二权威。
- 契约为强约束：`root`/`wid`/`generation`/`atomic snapshot`/`not_registered` 不得在实现中弱化为泛型 `Option`、裸 map 查询或拆分读取；WP-R 表内签名以本节契约为准（未注册路径的行为由各 WP 的测试列明，不得隐式注册）。

### R2 schema 与 N-1 recovery contract

- 明确 registry schema/version 与 N-1 binary 的 compatibility policy；
- 覆盖 spec §13.2 拒启场景：registry v3 升级后，较低 `user_version` 支持的 N-1 binary 拒绝启动——自动升级前检测并记录 N-1 兼容判定，演练必须包含该场景及其恢复路径（R4.10 首窗口语义：N-1=`0.3.5` 为 registry-less，拒启由 component 测试覆盖；见 spec §13.2）；
- 若 N-1 不兼容，自动升级前必须创建可验证 pre-upgrade DB backup；
- 发布 version-matched controlled restore/downgrade tool；禁止以 git tag/source checkout 充当用户恢复；
- preserve session files，定义 DB restore 失败、目录丢失、缺 workspace 时 recovery UX；
- 真实演练 `N-1 → N → N-1`，记录数据库、preferences、session preservation、static cache、running runtime 的结果。

### Gate R exit / reviewer checklist

- [ ] 四个 API 已合入或作为版本化依赖可用；
- [ ] HostDataPlane adapter、P1 target resolver、P3 flag reader 可只用该 contract 表达；
- [ ] 无裸 root map、URL path 或 browser root authority 回退；
- [ ] fresh DB、old DB upgrade、schema mismatch、missing workspace、missing directory、unregistered tmp covered；
- [ ] DB graceful degradation 实现并测试；runbook 手动恢复路径已记录（R4.11；artifact 演练 deferred 至 v3→v4 窗口）；
- [ ] P1/P2/P3 dependency 已锁定 Gate R。

---

## 4. Gate A — 权威 surface / caller 迁移矩阵（2 人日 + 评审）

输入：WP0.1 输出。任务：

- 逐行补齐 spec §3 Gate A 的全部字段；callers 到函数级；
- registry v1 surface 显式入盘点（spec §5.2 已列基线）：`workspace.list`、`workspace.add/remove/pin`、`preference.*`、`registry_changed` event——均为 `7acbc0a` 新增 controls，每条标注 v2 归宿与 authority，防止 Gate A 漏盘；
- 标记 `host_data.rs` 已实现 primitive，明确其语义限制，防止“已实现”被误当 endpoint parity；
- 每行分配稳定 ID `A-nn`，P8 删除 checklist 只引用行 ID；
- 每行定义 production caller 的 deletion proof：inventory zero hit + manual review；
- 复核 `/ws` command（OAuth、extension UI）、static assets、session export download、Cost Dashboard、search、AGENTS/APPEND_SYSTEM、broker controls、host v2 frames；
- 对 retained compatibility route 标注 owner/context、input/output limit、adapter/terminal mapping，不允许 mock 或 temporary map 充当 authority。

**Cost Dashboard 专项矩阵字段：**`range`、`granularity`、`scope=all|current`、`models`、request/response fields、date bucket、sorting、cache invalidation、legacy JSONL fixture。

评审 checklist：

- [ ] script 输出与矩阵一致或有审计 exception；
- [ ] 任一 caller 可反查 terminal surface/authority；
- [ ] 每行有 deletion proof；
- [ ] 已实现 host primitive 与 legacy compatibility operation 的差异已标注；
- [ ] OAuth 与 extension UI 不被误归为普通 HTTP route。

---

## 5. Gate B — Canonical protocol、capability、LAN、limits（5 人日 + 评审）

产出 `docs/superpowers/specs/2026-08-27-protocol-v2-capability.md`。

### B1 v2 frame / operation wire 定稿

- 每帧字段、必选/可选、类型、稳定 error code；
- hello：desktop capability、remote device token、unpaired client 的明确分支；
- mutation acceptance：`accepted_pending`、`duplicate_pending`、`duplicate_completed`，每个 mutation 均带 host 分配的 `operationId`；
- `operation_status_request` 的 logical-scope authorization、可见字段、Expired/Revoked/Indeterminate 行为；
- turn-start event 的 `turnId`，abort 的 turnId-required/stale-no-op wire；
- event sequence gap → snapshot flow；不得让 client 自动重发 mutation。

### B2 Operation Registry wire 与 lifecycle 约束

P1 实现 substrate，Gate B 定义其 wire/behavior：

```text
OperationScope(ownerId, workspaceId, sessionId, workspaceGeneration)
OperationRecord(Pending | Completed | Indeterminate | Expired | Revoked)
```

明确 execution instance 不是 durable identity；规定 capacity、TTL、eviction、owner revoke、generation change、host restart、runtime crash、terminal atomically complete 的行为。

### B3 Desktop capability

- `host_capability.rs` mint/validate/revoke API 到签名级；
- per-window in-memory credential；不得通过 `/v2/auth/exchange`；
- context mapping：`HostClientContext` ↔ legacy `VerifiedClientContext`；
- redaction 清单；capability 不得出现在 URL、query、sessionStorage、logs、telemetry、error、descriptor；
- lifecycle 规则逐条给出测试名：window destroy、owner revoke、generation change、host restart、cross-owner/cross-wid。

### B4 v1 adapter 与 LAN

- 每个 broker control 映射为 v2、server-side adapter 或 explicitly retired；
- adapter 只在 host server 内转换，禁止 browser 同时维护未文档化第二 WS；定义删除条件；
- LAN 仅在 D4 显式启用后设计/实现：bind policy、QR、pairing scope、command-class matrix；默认 loopback。

### B5 全部 in/out payload 与 backpressure matrix

| Surface | 必须定义/测试 |
| --- | --- |
| WS physical inbound/outbound | 16 MiB；`frame_too_large`；不可截断或半 JSON |
| `runtime_request.command` | 1 MiB（`RUNTIME_REQUEST_COMMAND_MAX_BYTES`）；`command_too_large`；超限转 paste-offload |
| `data_request` / `host_request` | 每个 matrix operation 固定 JSON 上限；不可拿 16 MiB 当通用 file/config tunnel |
| `extension_ui_response` / OAuth response | 小固定 JSON 上限；超限 reject |
| generic HTTP | 1 MiB 默认；route-specific override 明确 |
| paste offload | route ≥4 MiB；opaque handle TTL/cleanup |
| raw/export | validated descriptor streaming；不整体 buffer |
| outbound response/event | serialized byte limit；`response_too_large` fallback |
| outbound snapshot | lower dedicated limit；`snapshot_too_large` + authorized HTTP token/download/bounded summary |
| control progress | 小固定 JSON、request-local monotonic sequence；可 coalesce/drop nonterminal；terminal 不可丢 |

每项必须有 `limit-1`、`limit`、`limit+1` HTTP/WS integration test，并覆盖 slow consumer、cancel/disconnect、broadcast lag。

### B6 安全与 recovery test input

至少覆盖：capability no/invalid/expired/cross-owner/cross-wid/revoked；remote impersonation；subscription 越权；bare loopback HTTP；Operation Registry pending/completed replay、cross-owner status、TTL、host restart、crash Indeterminate；A abort disconnect → A end → B start → old abort retry；duplicate abort；frame/body limits；event sequence gap。

**Gate B exit：**B1–B6 已审查；B6 可直接转 P1/P2/P3/P5 tests；D2/D3/D4 已拍板（spec §16），本 Gate 验证其可实现性；D8 仍待 Gate A external caller 盘点，不在本 Gate 决策；B-GAP-01–14 按 Gate B 文档 §13 的 owner 归属转各 phase 验收（Gate R←04、P1←05–07、P2←01–03/08/10–12、P5←13、P6←09、D8←14），不在本 Gate 关闭。

---

## 6. Gate C — Launch / lifecycle contract（4 人日 + 评审）

产出 `docs/superpowers/specs/2026-08-27-launch-contract.md`。

- 取证 primary、dedicated、Side Chat、Quick Chat、standby、Super Agent/Pi chat、Windows 变体；每行定义 binary resolver、args ordering、stdio、stderr、timeout、probe、exit observer、restart、telemetry、fixture；
- 八态 × trigger transition table：spawn/probe、trust、turn start/end、bridge EOF、child exit、writer fail、frame fatal、stop、suspend/resume；每格有 pending operation 处置；
- 四种 stop ordering：workspace transition、owner revoke、window destroy、app exit；明示 stale ephemeral、standby、secret handle、OAuth generation 回收点；
- Windows Job Object / Unix process group + kill escalation；
- 环境 owner：`PI_CODING_AGENT_DIR`、skill-install secret、static assets、PATH、embedded Pi version；
- `pi_manager.rs` 所有 pub symbol → native replacement / new module / explicit deletion + test 的 P8 table。

**Gate C exit：**每 spawn 调用点归入一项 contract；无未定义 state transition；P8 symbol map 覆盖全部 pub symbol；C-GAP-01–11 按 Gate C 文档 §16 owner 归属转 P1/P2/P3/P5/P8 验收（与 B-GAP 同源项合并追踪），不在本 Gate 关闭；C-GAP-12 的源码抽取与 embedded Pi `0.84.2` parity/trust/collision runtime evidence 已通过 `bun run smoke:gate-c`，不再阻塞 Gate C-design。

---

## 7. Gate D — UI parity、namespace、adapter prototype、rollout（4 人日 + 原型 + 评审）

产出 `docs/superpowers/specs/2026-08-27-ui-parity-and-rollout.md`。

### GD-1 namespace 单一来源

| Route | Entry | 生命周期 |
| --- | --- | --- |
| `/workspaces/:wid/sessions/:sid` | existing `index.html` → `app.js` | P3–P8 production host-origin |
| `/app/workspaces/:wid/sessions/:sid` | `index.html` → `native/app.js` | experimental only |
| `/app/settings` 等 native-only route | native shell | experimental only |

`bootstrap-entry.js`、static fallback、production window URL、navigation allowlist、capability wid binding、smoke fixture 必须由此表驱动并测试。`/app/` 只要求加载不白屏。

### GD-2 parity + existing-shell adapter prototype

- parity matrix：能力、caller 函数、legacy transport、host terminal transport、unit/integration/real Pi/manual/E2E、迁移 phase；
- 覆盖聊天/stream/session/sidebar/workspace transition/files/Git/Terminal/system-open/Side Quick/settings OAuth skills packages config AGENTS APPEND_SYSTEM/chat Telegram/cost/search/Super Agent/i18n/theme/a11y/IME/reconnect；
- prototype 必须决定 `public/app/websocket-client.js` 是 replace、wrap 还是 adapt；
- 映射 broker v1 controls/events → canonical v2；定义 `brokerWs` query parameter 的移除策略；
- 每个 retained `/api/*` fetch 指定 authenticated owner-aware compatibility middleware；禁止 silent fallback 到 Pi-origin、unauthenticated `/ws` 或 host 404；
- adapter contract tests：hello/capability、reconnect、event ordering、sequence gap → snapshot、owner control、URL/base、每条 retained route。
- GD-2 原型结果是 spec §16 D2 重开条件（v1 adapter 成本不可接受）的直接评审证据：原型失败或成本超限即在 Gate D 评审中触发 D2 重开。

### GD-3 release / rollback

- `preferences.runtime.native_origin` 是唯一 release source，Rust launch-time snapshot；read/schema/value failure → legacy；debug env 仅 debug/developer；
- dogfood/cohort/default-on 指标、匿名 telemetry、N-1 support window；
- 每阶段 runbook 回答 flag、running runtime、DB/settings compatibility、static cache；
- schema recovery 使用 Gate R 演练的 backup/restore/recovery UX（spec §13.2），P8 前重新演练；
- `/v2/rpc` 若保留，需 deprecation、匿名 client-class usage、support window。

### GD-4 static base 验证

验证 `/v/{fingerprint}/` base 下 dynamic import、module assets、CSS、worker、root-relative API、download link；flag on/off 都覆盖。

**Gate D exit：**GD-1 namespace 及所有绑定被测试锁定；GD-2 adapter prototype 证明 existing shell 可在 host origin 工作（结果同时作为 spec §16 D2 重开条件的评审证据）；所有 parity 条目有归属；release artifact/rollback smoke 已定义；D10 cohort 门槛在本 Gate telemetry 方案定稿后补拍；据此重新估算 P3。

---

## 8. 决策会（0.5 人日）

状态（R4.3）：**D1–D7、D9 已于 2026-08-28 由 Dr. Lin 按默认拍板**并回填 spec §16；D2 附 Gate B 重开条件。已拍板项不再重议，除非触发重开条件。

**状态（R4.13，2026-08-29）：本会议按 R4.4 per-Blocks 规则解散，不再作为独立排期项。** D1–D7、D9 已拍板（08-28）；D8 已于 08-29 依 Gate A external caller 盘点拍板（不保留永久 `/v2/rpc`，删除前置见 spec §16）；残项仅 D10 cohort 门槛——触发条件 = Gate D telemetry 方案就绪，期限 = P3/P8 开工前，不阻塞 P0/P1/P2。

输入：Gate R、A–D 产物及 R4.5 spec §16。会议纪要确认 Gate evidence；各 work package 开工许可按其 explicit Gate dependencies + §16 Blocks 列判定：D8 仅阻塞 P7/P8、D10 仅阻塞 P3/P8（spec §16 Blocks）；其余 work package 不因这两项待决而 blocked。D8 不在本会议拍板，等待 Gate A external caller 盘点；D10 不在本会议拍板，等待 Gate D telemetry 方案；两项均在其 Blocks 所指 phase 启动前补拍。

若 Gate R 的 API/schema/recovery 仍未通过，决策会不得将“后补”写成例外；P1/P2/P3 保持 blocked。

---

## 9. P0 — 零行为共享抽取（3 人日）

**Depends on：Gate R closure（WP-R 交付）+ Gate A + Gate C design approved；不额外等待决策会，决策按 spec §16 Blocks 列判定。**

| 任务 | 内容 | 测试 |
| --- | --- | --- |
| P0.1 | 新建 `src-tauri/src/pi_launch.rs`，仅抽取 Gate C 定义可共享的 args、safe extension path、binary resolver、stderr logger/formatter、env builder；legacy `pi_manager.rs` 改为调用 | 原 spawn 参数 snapshot 不变；纯函数单测 |
| P0.2 | `host_router::is_mutation` 切至 `shared/mutation-types.json`；删除 `native_pi_manager.rs` duplicate list | JSON/Rust/JS 14-item parity 常驻 |
| P0.3 | inventory/check 命令纳入 CI；文档计数/路径引用校正 | check:inventory + docs review |

Exit：`bun run test`、`bun run check`、`bun run check:rust` 绿；launch description snapshot 未变；无生产行为变化。回滚：单 revert。

---

## 10. P1 — Native lifecycle、Operation Registry、turn safety（12–15 人日，dark）

**Depends on：Gate R + B + C + P0。**不得以 mock 或 bare root map 替代 Gate R authority。

| 任务 | 内容 | 测试 |
| --- | --- | --- |
| P1.1 | `OperationRegistry`：logical `OperationScope(owner,wid,sid,generation)`、record state、execution instance、idempotency key、TTL/capacity/eviction、owner revoke/generation change | scope/TTL/eviction/revoke unit |
| P1.2 | pending/completed/indeterminate lifecycle：terminal atomically complete；runtime crash/instance replacement/host restart 语义；`operation_status_request` authorization | pending/completed replay、cross-owner status、restart、crash Indeterminate |
| P1.3 | turn-bound abort：active `turnId → operationId` binding；abort 必带 turnId；仅 active matching scope target 转发；stale/Idle/Crashed success no-op；abort 不占 cache | A disconnect→A end→B start→old abort retry、duplicate abort、cross-owner turn ID |
| P1.4 | `NativeLaunchSpec` 扩展为 Gate C full contract | 每 runtime launch description fixture |
| P1.5 | child exit observer：EOF/child exit/writer fail/frame fatal atomically `Crashed`，reject bridge pending、registry in-flight → Indeterminate、sequenced crash/snapshot-required event | in-memory 三类 fault injection |
| P1.6 | Gate C stop ordering、ephemeral/standby/secret/OAuth-generation cleanup | owner transition/window destroy/app exit tests |
| P1.7 | Windows Job Object + Unix process group/kill escalation | platform test + Windows manual smoke |
| P1.8 | registry-backed target resolver：owner → atomic `{wid,root,generation}` | resolver and generation race test |
| P1.9 | `HostDataPlane`：`workspace_roots: HashMap` → registry adapter；Map 不得遗留为第二 authority | existing host_data tests refactor + authority test |
| P1.10 | host `/health` 与 legacy `PiManager` 去编译期依赖 | cargo check/import assertion |
| P1.11 | 每 runtime type 真 Pi smoke：primary/dedicated/Side/Quick/standby | `scripts/smoke-native-lifecycle.mjs` |

Exit：所有 runtime type 可经 test/developer path 启停；Operation Registry/turn-abort/crash tests 绿；无 release desktop flow 迁移。回滚：debug/test 路径关闭，release 无影响。

---

## 11. P2 — Canonical protocol、capability、authorization、limits（9–12 人日，dark）

**Depends on：Gate R + B + P1。**P1 已拥有 Operation Registry substrate；本阶段接 canonical v2 wire/admission，不重复实现 durable semantics。

| 任务 | 内容 | 测试 |
| --- | --- | --- |
| P2.1 | `host_capability.rs` mint/validate/revoke；per-window memory lifecycle | B6 capability matrix |
| P2.2 | v2 hello → `HostClientContext`：desktop capability / remote device token / unpaired 分支 | valid/invalid hello × client class |
| P2.3 | runtime request/response/event 接入 P1 registry：三种 mutation acceptance（`accepted_pending`/`duplicate_pending`/`duplicate_completed`，与 spec §4.1 一致）、operationId、turnId、per-target sequence | in-memory replay/event sequence |
| P2.4 | `operation_status_request`、snapshot、subscription 全部执行 owner/wid/generation authorization | cross-owner/cross-wid/subscription leak |
| P2.5 | v1 control adapter（Gate B map）在 server 内转换；每 control 有 mapping/retirement proof | adapter contract map |
| P2.6 | extension UI response 与 remote/class policy | dialog owner and class tests |
| P2.7 | 实现 Gate B 全 in/out limit matrix：physical WS、command、data/host/UI/OAuth、HTTP/paste/raw/export、response/event/snapshot/progress/backpressure | 每 surface `limit-1/limit/limit+1` + slow consumer/cancel/lag tests |
| P2.8 | LAN 仅在 D4 显式 enable 后实现；默认 loopback | bind/pairing command-class tests |

Exit：Gate B 安全与限额矩阵全绿；feature 不对 release 用户可见。回滚：debug-only path。

---

## 12. P3 — Release host enablement、existing shell adapter（Gate D 后重估）

**Depends on：Gate R + D + P1 + P2。**仅在 Gate D adapter prototype 完成后确认工期。

| 任务 | 内容 | 测试 |
| --- | --- | --- |
| P3.1 | flag：`preferences.runtime.native_origin` launch snapshot、fail-closed、匿名 telemetry | flag/schema failure unit |
| P3.2 | D1 namespace 实现：production URL 固定 `/workspaces/:wid/sessions/:sid`；`/app/` 保持 experimental | bootstrap/static/window/navigation/capability smoke |
| P3.3 | window lifecycle：owner 先建、capability 注入、navigation authorizer、route wid binding | window integration test |
| P3.4 | existing-shell adapter：落实 replace/wrap/adapt 决策；broker v1→v2 controls/events；brokerWs removal；retained `/api/*` owner-aware middleware；禁止 Pi-origin/unauthenticated `/ws`/404 fallback | hello/reconnect/order/gap/owner/base/retained-route contract tests |
| P3.5 | flag on/off parity、dogfood 2 周、性能对照 | full parity matrix + baseline thresholds |

Exit：flag on/off 完整 desktop parity；`/workspaces/` → existing shell、`/app/` → experimental shell；核心 runtime event 不依赖 Pi-origin；性能未越阈值。回滚：关 flag → legacy origin；running runtime/DB/static cache 按 Gate D runbook。

---

## 13. P4 — Data/session 与 Cost Dashboard compatibility（7–9 人日）

**Depends on：Gate R + P3**（Gate A 矩阵经 P0→P3 链传递可用；与 spec §6 P4 一致）。

- 矩阵行序迁移 instances、sessions、search、workspace-info、Pi version/home（若有权威来源）、session rename/delete/switch/export；
- delete 保持 trash-first、running protection、per-file result、二次确认；
- export 采用 control → one-shot owner/root/generation/TTL/quota bound token → streaming `GET /v2/session-export/{token}`；
- `/api/workspace/open` 迁为 owner-only system-open；runtime start 使用 distinct command（候选 `workspace_runtime_start`，Gate B 定名），依赖 registry lookup；

### P4 Cost Dashboard complete compatibility operation

不得将 `HostDataPlane::cost_dashboard(workspaceId)` 作为 direct replacement。该 primitive 仅 workspace-scoped，不能表达 legacy global semantics。

- 实现/adapter 必须接受并保持 `range`、`granularity`、`scope=all|current`、`models`；
- 保留 global/current aggregation、response fields、date/bucket behavior、sorting、cache invalidation、error behavior；
- 同一 JSONL fixtures 上 legacy/v2 逐字段比较；覆盖 all/current、range、granularity、models、empty/corrupt data；
- fixture parity 通过前，不得删除旧 Cost endpoint 或宣称 host data primitive 等价。

Exit：route response/error parity、Cost fixture parity、host-origin manual session/sidebar/export/cost flows。回滚：旧 compatibility entry 未删除前，前端回退零成本。

---

## 14. P5 — Files、config、OAuth sole ownership（8–10 人日）

**Depends on：Gate R + A + B + C + P3。**

### Files/config

- file list/read/write/raw：relative path、canonical containment、symlink escape、MIME/type/size/conflict/mtime、atomic write；write 走 mutation/Operation Registry，raw streaming；
- agent/models/chat/AGENTS/APPEND_SYSTEM：分别确认 app-global/workspace scope；
- 保留 model refresh、backup、proper lock、JSON validation、atomic write、0600、restart message；
- 测试 traversal、symlink、absolute/URL encoded path、TOCTOU 说明、editor/preview/manual flow。

### OAuth — P5 唯一 phase owner

迁移以下五项为 v2 controls/events，禁止在 P3 adapter 或 P7 泛化 RPC 中“顺带”实现：

```text
get_oauth_login_capabilities
start_oauth_login
cancel_oauth_login
get_oauth_login_status
logout_oauth_login
```

必须保持：

- operation 绑定 owning desktop 与 Pi process generation；device-code/progress 只发 owner；
- remote/ephemeral deny；cross-owner reject；credential/capability 不进入 browser/log/telemetry/error；
- expiry、cancel、disconnect、window destroy、runtime reload、bridge EOF、child crash、explicit stop/restart 取消/终结旧 operation；
- login/logout 后 catalog refresh；Pi 仍拥有 credential store；
- native generation lifecycle 明确：Rust OAuth manager 持有等价于 legacy `oauthProcessGeneration` 的单调 process generation；spawn/probe success 创建/推进 generation；reload/restart 推进 generation；bridge EOF、child exit/crash、owner/window destruction、explicit stop 均先 revoke/abort prior-generation OAuth operations，再更新 runtime state；stale generation event 丢弃且可审计但不泄密。

Exit：files/path security suite、config side-effect regression、OAuth lifecycle matrix（start/cancel/expiry/disconnect/window-destroy/reload/EOF/crash/stop/restart/logout/catalog refresh/cross-owner/remote/ephemeral）全绿。回滚：保留 compatibility entry 前可回退；credential 不迁移或复制。

---

## 15. P6 — Heavy integrations 与 HTTP binary paths（6–8 人日）

**Depends on：Gate R + A + P3。**

- `/v2/paste-offload`：route ≥4 MiB、opaque handle、workspace-derived temp location、TTL/quota/cleanup、prompt reference；
- file mentions、git branch、skills endpoint removal（仅当 native controls 达到 Gate A contract）；
- Telegram：secret redaction、独立 timeout/rate/cancel；
- Super Agent projects/tasks：D9 canonical `RuntimeTarget`，无 direct port fetch；
- package、ephemeral 及 remaining non-chat `/api/*` callers 按 matrix 迁移。

Exit：cancel、handle expiry、temp cleanup、secret redaction、external timeout、cross-runtime authority 测试绿。回滚：compatibility entries 按 matrix 保留。

---

## 16. P7 — Chat RPC / event transport completion（8–10 人日）

**Depends on：Gate R + B + P3。**

- 所有 legacy `/api/rpc`、`/ws`、cross-port、Super Agent runtime command → canonical v2；
- 完成 control progress ordering、per-frame limit、backpressure、abort、request cancellation、event sequence gap → snapshot fallback；
- `/v2/rpc` 若 D8 允许：deprecation header、匿名 client-class usage、support window、removal notice；禁止隐藏永久第二 RPC；
- 每条 compatibility entry 仅在 Gate A inventory 证明 zero production callers 且 parity/real-Pi smoke 绿时删除。

Exit：真 Pi smoke：prompt → stream → steer/follow-up → abort → compact → fork/tree → reconnect/sequence gap → crash response；`public/` production caller 不直接到 embedded-server。回滚：compatibility path 仍在时前端可回退；P8 后只能 N-1 release recovery。

---

## 17. P8 — 发布、删除、文档（5 人日 + release 周期）

前置：cohort stability、两个稳定 release 周期、每个 Gate A 行有 deletion proof、deprecated usage 达 zero 或支持窗口结束；N-1 schema recovery runbook 与真实 `N-1 → N → N-1` 演练按 **spec §13.2 全项**执行（DB backup/restore、版本匹配受控降级、session preservation、running runtime 处置、static cache 失效、user-facing remediation），generic upgrade smoke 不满足要求。

- 删除顺序：compatibility adapter/反代 → `embedded-server.ts`（测试按已迁移行为移位）→ `pi_manager.rs`（Gate C C7 symbol table）→ obsolete flag/endpoint → legacy config gateway → artifacts；
- artifacts 显式决定：删 `embedded-server.mjs`，留 `picot-bridge.mjs`，`pi-chat.mjs` 按 P6 final architecture 决定；
- 文档：`ARCHITECTURE.md`、README、build/capability/smoke、engineering lessons、`.memory` update-memory；
- macOS/Windows release artifact；embedded Pi（非 `$PATH`）；N-1 → N → N-1 upgrade/recovery 演练，含 DB backup/restore、session preservation、running runtime、static cache、user-facing remediation。

Exit：`bun run test`、`bun run check`、`bun run check:rust`、`bun run build:extensions`；smoke matrix、deletion proof、release artifact、schema recovery/release rollback 评审全过。回滚：P8 后使用 N-1 release + Gate R controlled recovery，不以 git tag 充当用户方案。

---

## 18. 检查点（Dr. Lin 出席）

| # | 时点 | 内容 |
| --- | --- | --- |
| CP0 | Gate R（WP-R 完成后） | **已关闭（2026-08-29，Dr. Lin 签署）**：六项 exit criteria 逐条验证（criterion 1 admission 边界修正见 spec R4.12）；WP-R.1–R.6 全部交付；P0/P1 解锁 |
| CP1 | Gate A–D | 分场：**Gate B-design + Gate C-design + Gate A 已于 2026-08-29 关闭**（Dr. Lin 签署；B/C 见 `2026-08-29-cp1-review.md`；Gate A 人审裁决：A-HTTP-37 直接 retire、A-HTTP-25/D8 边界、高危行终态认可，含两条安全修复）；Gate D（adapter 原型在途）另行关闭 |
| CP2 | 决策会 | **已重构关闭（2026-08-29，Dr. Lin）**：单一会议按 R4.4 per-Blocks 规则解散；D1–D9 全部拍板（D8 见 spec §16 R4.13）；残项 D10 cohort 门槛由「Gate D telemetry 就绪后、P3/P8 开工前补拍」接管，不阻塞 P0/P1/P2 |
| CP3 | P1 完 | lifecycle、Operation Registry、turn abort、runtime smoke |
| CP4 | P2 完 | capability/authorization/limit matrix |
| CP5 | P3 完 | dogfood go/no-go、P3 performance/parity |
| CP6 | P4 完 | Cost fixture parity、delete/export contract 签收 |
| CP7 | P5 完 | OAuth lifecycle/security 签收 |
| CP8 | P6 完 | 取消/句柄过期/secret 脱敏/外部超时签收 |
| CP9 | P7 完 | chat parity 签收 |
| CP10 | P8 前 | deletion + N-1 recovery 批准 |

---

## 19. 停止条件

任一触发即停，不以局部 test green 代替：

| 条件 | 行动 |
| --- | --- |
| Gate R API/schema/recovery 未交付 | 阻塞 migration P0/P1/P2/P3；Foundation F0/WP-R 仅可按各自范围继续；保持 legacy authority |
| 普通 owner 可读写 `runtime.*` 或自启 release flag（rollout namespace bypass） | 阻塞 P2/P3；补 protected internal writer 与 fail-closed 公开 controls |
| desktop capability 或 subscription 越权 | 阻塞 P3；回到 Gate B |
| Operation Registry 不能按 logical scope 在 instance replacement/restart 后查询 | 阻塞 P2/P7 |
| stale abort 可影响后继 turn | 阻塞 P7，关闭 host-origin mutation path |
| host-origin 需未文档化第二 WS、Pi-origin 或 bare `/ws` fallback | 阻塞 P3/P7 |
| UI critical parity 失败 | 关 flag，不扩路由 |
| LAN bind/auth matrix 不完整 | 保持 loopback only（spec §11 LAN exposure） |
| delete 偏离 trash-first/running guard | revert 行为；另立 product RFC（spec §11 data loss） |
| 任一 runtime type 无真 Pi smoke | 阻塞 PiManager 删除 |
| inbound/outbound limit 或 backpressure test 失败 | 阻塞 P2/P3/P7 |
| Cost fixture parity 失败 | 不删 legacy Cost endpoint |
| OAuth cross-owner/generation cleanup 失败 | 阻塞 P5/P8 |
| 性能超过 spec §10.3 阈值 | 暂停迁移，先诊断 |
| N-1 schema/recovery 失败 | 不 default-on，不删 legacy |
| endpoint deletion proof/usage 不为零 | 延长支持窗口或迁 caller |

> 平台边界（R4.10，2026-08-29，Dr. Lin）：Gate R closure 以 macOS 证据判定；Windows 硬证据为 P8 release validation 强制项，不得提前宣称。R-03 首迁移窗口语义：`0.3.5`（registry-less）↔ `0.3.6` 为合法 rehearsal 对，拒启语义由 component 测试覆盖（spec §13.2）。

---

## 20. 计划维护

- 上游对照决策（2026-08-29，Dr. Lin）：本仓库为 `shixin-guo/picot` 的特性 fork，上游 v0.4 已完成同类 embedded-server 退役；**维持本分支按 spec 执行，不 port**，上游实现仅作设计对照与风险预警（详见 spec §15 Lineage 条目）。

- 本文件已 rebase 至 R4；任何 Gate 产物与 spec（R4）冲突时，spec 为准，计划同 PR 修订；
- P3 起每阶段完成后发布本计划 R+n：已完成项、actual effort、下阶段细化、未决风险；
- inventory line ID、limit、route、symbol 引用随 HEAD 漂移由 `check:inventory` 与 review 维护；行号不能作 acceptance criterion；
- 不得把尚未通过 Gate 的 draft、mock 或 temporary map 表述为已实施能力。

---

## 21. 总 DoD

- [ ] Gate R registry/preferences authority、schema compatibility 和 recovery 演练通过
- [ ] Gate A inventory 已生成、review、drift check
- [ ] Gate B protocol/capability/LAN/limits matrix 通过
- [ ] Gate C launch/lifecycle contract 通过
- [ ] Gate D namespace、existing-shell adapter prototype、rollout strategy 通过
- [ ] D1–D10 决策已回填
- [ ] P0 zero-behavior extraction 通过
- [ ] P1 runtime lifecycle、Operation Registry、turn safety、all runtime smoke 通过
- [ ] P2 capability/authorization/in-out limits matrix 通过
- [ ] P3 flag off/on full existing-shell parity、dogfood、性能门槛通过
- [ ] P4 data/session/Cost complete compatibility 通过
- [ ] P5 file/config side effects、OAuth lifecycle/security 通过
- [ ] P6 integrations、HTTP streaming/cancellation/temp lifecycle 通过
- [ ] P7 real Pi chat/reconnect/crash protocol smoke 通过
- [ ] P8 cohort、deletion proof、macOS/Windows artifact、N-1 recovery、文档通过
