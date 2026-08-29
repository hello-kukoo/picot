# Gate D — Existing-Shell Adapter Prototype 证据（D-GAP-01）

> 状态：**EXECUTED_PASS（2026-08-29）**。`bun run vitest run scripts/prototype/adapter-prototype.test.js` → 37/37 通过。
> 约束合规：零生产文件修改（`public/app/websocket-client.js` 以真实形态被 import，未改动）；原型仅存于 `scripts/prototype/`；发现的两处缺陷均已在原型内修复并留证。
> 运行器注意：测试文件 `import { ... vi } from "vitest"`，必须以 `bun run vitest run` 运行；`bun test`（Bun 自带 runner）下 `vi`/`sessionStorage` 不可用，会产生 3 个伪失败。

---

## 1. 组件与覆盖

| 文件 | 作用 | 测试锚点 |
| --- | --- | --- |
| `v2-core.js` | v2 host 内存实现（hello/ack、capability 校验、unauthorized_device、事件序、compat token 签发） | hello/capability 组 ×6 |
| `v1-to-v2-socket.js` | **wrap 形态**：冒充 WebSocket 类包裹真实 `WebSocketClient`，v1 帧→v2 帧；capability 模块级缓存；gap 缓冲→mirror_sync 优先 | wrap 路径全部 + reconnect |
| `v2-to-v1-facade.js` | **façade 形态**：server 侧 v1 面板（client_hello/capabilities/broker_control/broker_command/事件回注） | façade 路径全部 |
| `control-map.js` | v1 control→v2 映射表（session 路由/picker/open/skill/workspace-transition 五类 + 未映射→可见 `unimplemented_route`，绝不假 ok） | control mapping ×8 |
| `broker-ws-policy.js` | hostOriginWsUrl / brokerWs 候选校验（拒 Pi-origin、拒非 `/v2/ws`）/ stripBrokerWs（query+sessionStorage 双源移除 + `location.replace`） | URL/base ×4 |
| `compat-api.js` | retained `/api/*` 兼容中间件：WS 签发一次性 token → HTTP 200/401/403，未保留路由可见 404 `unimplemented_route`、零 legacy-origin 回落 | compat ×3 |
| `adapter-prototype.test.js` | 37 项契约测试（hello/映射/流/序/abort/幂等/admission/URL/token） | — |

关键行为测试：turn-bound abort（v1 无形状 abort 合成 turnId；stale turn 成功 no-op 不杀后继）；idempotency（pending→`duplicate_pending`、completed→`duplicate_completed` 缓存响应；v1 重试=两个独立 operation）；sequence gap→snapshot 次序（mirror_sync 先于任何 gap 后事件；跨 gap 不自动重发 mutation）；Temporary 合成 wid `not_registered` 拒绝；跨 owner 拒绝。

## 2. 收尾期间发现并修复的缺陷（原型的直接产出）

1. **adapter 真实缺陷（P3 必修项已在原型修复）**：v1 `client_hello` 内联携带 capability 时 `??` 短路导致模块缓存从未填充；生产 client 首读后删除全局 → reconnect hello 回落缓存为空 → **静默降级 remote hello → `unauthorized_device` → 1008 关闭 → 无限重连循环**。修复：hello 内联 capability 同步 priming（`realmCapability ??= frame.capability`）。教训入 P3：capability 缓存生命周期 = realm（内存），来源含内联首发，绝不经 storage/URL。
2. **harness 保真度缺陷**：原 mock 将单条已认证 host 连接共享给重连后的新 socket——第二个 hello 在已认证连接上属协议违规（v2-core 正确拒绝）。真实 reconnect=**新传输连接**，已改为 per-socket core。此为测试基建修正，非 adapter 缺陷。
3. **运行器适配**：见头部注意（vitest vs bun:test）。

## 3. GD-2 八维量化（P3 重估输入）

| 维度 | 原型证据 | 估算（人日） |
| --- | --- | --- |
| 1 Surface count | Gate A inventory：39 HTTP（含 2 补录）/43 WS/controls/host frames，稳定 caller id | 0（已固化） |
| 2 Caller churn | 139 caller 稳定 id；动态面已定性（§4/§5） | 0（已固化） |
| 3 Adapter depth | 双形态均可行（wrap+façade）；CONTROL_MAP 五类代表 + `unimplemented_route` 可见失败模式确立；每类事件 lossless 映射在覆盖类内成立 | 核心传输 6–8；映射表补全（43 WS 命令 + ~40 controls，机械扩展）5–8 |
| 4 Auth substrate | **未就绪**——capability 校验/HostClientContext/Registered-only 接线为 B-GAP-01/02/04（P1/P2），原型以 in-test v2-core 替身 | 0（归 P1/P2，非 P3） |
| 5 Static/origin | brokerWs 移除策略 4 测试绿；`/workspaces/` 路由与 fingerprint base 待真实浏览器（D-GAP-06/07） | 2–3 |
| 6 Parity execution | 37 项契约测试；real Pi/browser E2E 未做（D-GAP-02/06/07/08 维持） | E2E/parity harness 5–8 |
| 7 Retained legacy | compat middleware 机制成立（token+401/403/404 可见拒绝）；保留范围已决（D8 2026-08-29：不保留永久 `/v2/rpc`） | per-route 矩阵 3–5 |
| 8 Release/rollback | 不变（Gate R rehearsal 已按 R4.11 deferred） | 0（另计发布周期） |

**P3 coding 重估：19–29 人日**（不含 P1/P2 substrate 与 dogfood 观察窗口）。取代旧"5 人日"占位。

## 4. D-GAP 影响

- **D-GAP-01（runnable adapter）：prototype 范围关闭**——两种形态可运行且 37/37；浏览器/真 Pi 部分（原行内 evidence 要求）归 D-GAP-02/06/07/08 维持开放。
- D-GAP-03（v1↔v2 不兼容）：机制层证伪——覆盖类内字段/hello/事件可映射；剩余为映射表完整性工作。
- D-GAP-04（compat middleware）：机制成立（3 测试）；per-route 展开待 D8 范围。
- D-GAP-05（brokerWs 双来源）：移除策略已测（stripBrokerWs）。
- D2 重开评估输入：**未触发**——v1 façade 成本有界且机械（映射表扩展），覆盖类无 lossless-mapping 阻断；D2 维持已批（host v2 + server-side adapter）。

## 5. 约束合规复述

`git diff` 证明 `public/`、`extensions/`、`src-tauri/` 生产文件零改动（本轮 prototype 相关提交内）；原型经 `scripts/prototype/` 隔离；全部状态标记真实（未跑过的 E2E 维持开放，未宣称）。
