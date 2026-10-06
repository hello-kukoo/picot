<!-- ABOUTME: ADR 0004——内嵌 pi 升级到 1.0.4 的版本锁定与扩展运行时契约。 -->
<!-- ABOUTME: 记录锁定机制（sha256 + devDep 同步 + 逐版本契约 fixture）与已知边界。 -->

# ADR 0004: 内嵌 pi 1.0.4 锁定与扩展运行时契约

- 状态：Accepted
- 日期：2026-10-06
- 关联：`scripts/pi-version.json`、`scripts/fetch-pi-binary.js`、`tests/fixtures/pi-rpc/1.0.4/contract.json`、`extensions/oauth-login-smoke.test.ts`、`tsconfig.json`；影响记录 `docs/pi-1.0.4-upgrade-impact.md`；上游依据 `2026-10-06-pi-1.0.4-impact.md`（features-v3）

## 背景

Picot 内嵌 pi 从 0.85.1 跳到 1.0.4，跨 0.86 → 1.0.4 十余个版本，其中包含 agent 1.0.0 删除 `./node` 等子路径导出、coding-agent 0.87 一批扩展作者面破坏性变更、ai 0.99 图像模型统一、1.0.3 Azure provider 改名。同时 1.0.4 修复了 MCP OAuth native client 注册（`#10493`），是后续 MCP 设置页（迁移计划 Phase 6）所依赖的上游能力。

原有的版本锁定只有单一 `version` 字段：无校验和、无运行时契约基线、devDependency 可静默漂移。

## 决策

1. **目标版本 1.0.4**，理由：1.0.2→1.0.4 评估无 breaking changes；`#10493` 直接服务 MCP 登录面；与 features-v3 同基线以便 verbatim 移植。
2. **sha256 强制钉值**：`scripts/pi-version.json` 对 6 个平台产物逐一钉 sha256，取值来自各 release 的官方 `SHA256SUMS`。`fetch-pi-binary` 命中钉值时校验失败即中止；无钉值仅告警——因此新增平台产物必须同时补钉值。
3. **devDependency 与内嵌版本同步**：`@earendil-works/pi-coding-agent` 跟随 `scripts/pi-version.json`。理由有二：`extensions/oauth-login-smoke.test.ts` 断言「npm pin == 内嵌 pin」，漂移时真实运行时断言会**静默跳过**（假绿）；`tsconfig.json` 把该包类型映射到 `src-tauri/resources/pi/dist/index.d.ts`，故 fetch 后 `bun run check` 与测试实际以新版本类型/运行时为准。
4. **逐版本 RPC 契约 fixture**：每个内嵌版本在 `tests/fixtures/pi-rpc/<version>/contract.json` 留一份 `get_state` 字段面 / 命令来源 / 事件类型基线，由 `bun run smoke:pi-rpc --update` 生成、`bun run smoke:pi-rpc` 校验。旧版本 fixture 保留作历史对照（不删除）。
5. **升级验收含扩展运行时端到端**：仅跑 fixture 与单测不足以证明扩展可用——需以 `-ne` 隔离本机全局用户扩展后，加载编译版 `extensions/dist/picot-bridge.mjs` 并实测至少一个 `/picot-config` op 返回成功。

## 后果

- 升级动作变成「改一处 pin + 重新 fetch + 重新生成 fixture」，可评审、可回滚（revert pin 后重跑 `fetch:pi`，归档缓存在 `.cache/pi-binaries/`）。
- 扩展作者面破坏性变更的暴露点前移到 `bun run check`（类型）与 bridge 端到端冒烟（运行时），不再依赖人工发现。
- 用户侧扩展兼容不在本仓可控范围：依赖 `@earendil-works/pi-agent-core` `/node` 子路径的扩展（典型 pi-subagents < 0.75.0）在 pi ≥ 1.0 下后台 runner 失效，需界面侧如实标注可用性。
- 文件级 rg 审计不足以覆盖上游语义变更时（如事件字段扩张），以 fixture 实测与端到端冒烟为准；文档重构（`rpc.md` 拆分）不代表契约变化——需按 token 集合比对而非文件路径比对。
