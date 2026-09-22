# 持久 daemon 与 relay 接入设计

**状态：** Draft — 待 Dr. Lin 拍板（含两项待定：daemon 进程形态 §3.6、公司服务器部署核实清单 §6）
**日期：** 2026-09-20
**演化关系：** 建立在 `2026-09-20-session-resident-views-design.md` 已核实的 runtime 常驻现状之上（同 workspace 切 session / 跨 workspace 均不停、切回复用）。移动端 app/PWA/推送**不在本 spec**，另行立项；本 spec 只交付通道与配对。
**参照：** Paseo relay 全链路（`packages/relay/`、`packages/server/src/server/relay-transport.ts` 553 行、`pairing-offer.ts`、`public-docs/security.md`、`connectivity.md`）；官方 relay 服务端 getpaseo/paseo-relay（Elixir，fly.io）与社区 Go 实现（zenghongtu/paseo-relay）。

## 1. 问题

1. **host 栈困在 Tauri 主进程里。** NativePiManager、HostServer、MetadataStore、owner registry 全部由 `main.rs::setup_native_runtime` 创建并 `app.manage`（main.rs:1672-1776）；窗口销毁触发的清理会杀掉全部 Pi 子进程（child_supervision + owner registry 窗口清理）。结果：关窗即断执行，无持久 agent——与 Paseo「daemon 与 GUI 生死解耦」的核心差异。
2. **无外网通道。** loopback-only 绑定 + 「不放 LAN」是既定安全边界（ARCHITECTURE）；远程/移动端无法到达本机。
3. 目标形态（与 Paseo 一致）：持久 daemon 独立进程 + daemon **出站**连接公司服务器上的 relay + E2EE 端到端加密 + 配对信任锚，为移动端铺路。

## 2. 已验证事实

### Paseo 侧（本轮源码核实）

| 事实 | 证据 |
| --- | --- |
| relay 协议 v2：`GET /ws?serverId=&role=server\|client&v=2[&connectionId=]`；daemon control socket（每 serverId 一个）收 `sync/connected/disconnected`，per-connection data socket，client socket 由 relay 分配 connectionId；`GET /health` | `paseo/packages/relay/src/cloudflare-adapter.ts` 头注释、`protocol/src/daemon-endpoints.ts::buildRelayWebSocketUrl` |
| relay 是零认证哑管道，只转密文；安全完全由 E2EE 承担 | `cloudflare-adapter.ts` 全文（无 auth/token 逻辑）+ `public-docs/security.md` |
| E2EE：daemon 持久 Curve25519 keypair（`~/.paseo/daemon-keypair.json`）；握手 `e2ee_hello`（client 公钥）→ `e2ee_ready`；NaCl box（XSalsa20-Poly1305）；**每连接独立共享密钥**；握手完成前 daemon 不处理任何命令帧 | `packages/relay/src/e2ee.ts`、`encrypted-channel.ts`、`daemon-keypair.ts` |
| 配对 offer = 信任锚：`{v:2, serverId, daemonPublicKeyB64, relay:{endpoint,useTls}}` → `https://app…/#offer=<base64url>` → QR | `protocol/src/connection-offer.ts`、`server/src/server/pairing-offer.ts` |
| daemon 侧 relay transport：control socket 重连退避 1s→30s 封顶、WS 协议层 ping 10s 周期 / 30s stale 强断、`sync` 对账已连接 client、每 client 独立 data socket + 独立 E2EE 通道、15s open timeout | `server/src/server/relay-transport.ts:117-400` |
| 通道内跑 daemon 普通 WS 会话协议（`attachSocket(transport:"relay")`），relay 对上层透明 | `relay-transport.ts` `attachSocket` 注入 + `websocket-server.ts` ExternalSocketMetadata |
| relay 默认关闭，启用需显式确认（「relay off until enabled」） | `public-docs/security.md`、connectivity.md |
| relay 服务端三份开源实现：官方 Elixir（getpaseo/paseo-relay，生产 fly.io）、TS/Cloudflare DO（packages/relay，wrangler 部署 relay.paseo.sh）、社区 Go 单二进制（zenghongtu/paseo-relay，协议兼容，Docker 镜像） | wrangler.toml、GitHub |

### Picot 侧（本轮源码核实）

| 事实 | 证据 |
| --- | --- |
| **远程客户端骨架已存在**：WS hello 已支持 `clientType:"remote"` + `deviceToken` 认证，通过后进入 `HostClientContext::remote(client_id)` | `host_server.rs:1428-1482` |
| **配对与令牌已存在**：`RemoteAuth`（pairing token 5 分钟一次性 → device token 持久存 DB）；HTTP 端点 `POST /v2/auth/exchange` | `remote_auth.rs` 全文（197 行）、`host_server.rs:390,3143-3155` |
| host_server.rs:3160 注释明示 remote surface 是规划的「Gate B」工作（reads/visibility/commands 权限面待定） | 同上 |
| Cargo 已有 tokio-tungstenite（WS 客户端，relay 出站可用）、sha2、uuid、rand；缺 X25519/NaCl box（RustCrypto `crypto_box` crate 一个补齐） | `src-tauri/Cargo.toml:39-51` |
| host 栈规模：main.rs 4327 行 / host_server.rs 6253 / native_pi_manager.rs 2701 / window_owner.rs 1258；状态对象已 Arc 共享，由 setup_native_runtime 集中创建 | wc + main.rs:1672-1776 |
| runtime 常驻已实现（本仓库 09-18 成果 + session-resident-views spec 核实）：切换不停、切回复用 | `main.rs workspace_transition_commit` 注释、`find_existing_runtime_for_prepare` |
| 窗口销毁清理按 owner 记录杀子进程（关窗即全停） | child_supervision.rs、owner registry 窗口清理 |

## 3. Phase 1：picot-daemon 独立进程

### 3.1 目标形态（Paseo 同构）

新 binary `picot-daemon`，承载 host 栈全部：NativePiManager、HostServer、MetadataStore、RemoteAuth、EphemeralRegistry、SkillSourceRegistry、GitService、TerminalManager。Picot.app 退化为本地客户端：经 loopback 连 daemon（WebView 与 GUI 壳走同一条 WS/HTTP 路径）。窗口关闭只影响窗口；runtime 生死与 app 无关。

### 3.2 生命周期

- macOS：launchd LaunchAgent（登录自启 + 崩溃自动重启）；Windows 服务与 Linux systemd 后续增量。
- App 启动序：探测 daemon（pidfile + `/health` 探针）→ 未运行则 spawn 并等 ready → 连接。App 退出不向 daemon 发停机。
- Daemon 单实例：文件锁；重复启动即退出复用现有实例。

### 3.3 迁移步骤（工程序）

1. host 栈状态对象迁出 `app.manage`，进独立 `DaemonState`（纯 tokio，无 Tauri 依赖）。对象已是 Arc 共享，主要工作是 main.rs 的 setup 与命令分发拆出（main.rs 的 IPC handler 表迁到 daemon 进程的 WS/host_request 路径——WebView 本就大量走 HostServer，残余 Tauri command 需逐个收编）。
2. owner registry 与 capability 签发**留在 daemon**（单一权威）；app 进程自身以 desktop capability 客户端接入（即现有 `clientType:"desktop"` 路径）。
3. 窗口销毁语义反转：现杀 runtime；改为仅撤销该窗口 owner 的 UI 绑定，runtime 按 session-resident 语义存活。既有 e2e 清单「关转场窗口杀子进程」条目语义同步改写。
4. 数据目录：daemon 直接使用 app_data_dir（同一 SQLite），app 与 daemon 只经 WS 交互，不再共享文件句柄。

### 3.4 兼容与回滚

开发期保留环境开关（如 `PICOT_DAEMON=embedded|external`）：embedded 即现行单进程模式。验证一个迭代后删 embedded 路径（不留双轨，对齐仓库无向后兼容惯例）。

### 3.5 测试

全量 `bun run test` + `check:rust`；新增：app 重启后 runtime 仍活且接回现场；app 退出/崩溃不杀 runtime；daemon 崩溃自动重启且 runtime 状态可恢复（pi 进程孤儿接管或明确降级语义，待实现时定案）。

### 3.6 待拍板：一步到位 vs 托盘常驻起步

推荐**一步到位独立进程**。托盘常驻（app 关窗不退、不杀 runtime）改动小，但拿不到真 daemon：移动端连的还是桌面进程，app 退出仍全停，与 relay 目标矛盾，且事后仍要二次拆分。此判断基于 Paseo 同构目标；若 Dr. Lin 想先快速验证「关窗不断」，托盘模式可作为一次性跳板，但会被丢弃。

## 4. Phase 2：relay 接入（daemon 出站 + E2EE + 配对）

### 4.1 模块（src-tauri/src/relay/）

- `transport.rs`：control socket（wss → `relay/ws?serverId&role=server&v=2`）+ per-connection data socket + 重连退避（1s 起、30s 封顶）+ WS 协议层 ping/pong（10s 周期 / 30s stale 强断）+ `sync` 对账 + 15s open timeout。逐条对齐 `paseo relay-transport.ts`，协议参数不再发明。
- `e2ee.rs`：持久 Curve25519 keypair（存 metadata DB，等价 PaseO daemon-keypair.json）；`e2ee_hello`/`e2ee_ready` JSON 明文握手帧；NaCl box XSalsa20-Poly1305 帧加密。RustCrypto `crypto_box`（x25519-dalek + xsalsa20poly1305）补一个依赖。密文帧第一版 base64（Paseo 已验证路径），binary 能力位后续。
- `pairing.rs`：offer 生成（serverId + 公钥 + relay 公网 endpoint → 链接 + QR 码 payload）。serverId = uuid，存 DB。

### 4.2 通道复用（Picot 的独有优势）

data socket 解密后的帧，经 adapter 接进 HostServer 既有 WS 会话管线：远程客户端走 **已存在的** `clientType:"remote"` + `deviceToken` hello 路径（§2）。HostServer 近零改动；Paseo 需要的「通道内应用层认证」Picot 已有实现。

### 4.3 配对全流程

1. 桌面端 Settings「远程访问」页 → 生成 relay 配对 offer（QR/链接；显式确认才启用 relay，对齐 Paseo 默认关闭）。
2. 移动端扫码 → 得 serverId/公钥/endpoint。
3. 移动端连 relay（role=client）→ E2EE 握手。
4. 通道内调既有 `/v2/auth/exchange`：输入/内嵌 pairing token → 换 device token（持久化于设备）。
5. 后续连接：hello 携 device token 即认证完成。

### 4.4 安全模型（ARCHITECTURE.md 须同步新增章节）

- **relay 不受信**：只转密文；见 IP/时序/包大小/serverId。信任锚 = 配对 offer（QR 按密码对待，不公开分享）。
- **远程身份与权限面**：`clientType:"remote"` 的既有权限需审计并收窄定案（host_server.rs:3160 注释所指 Gate B）：remote 默认 = 时间线读 + prompt 发送 + 订阅；**不给** git / terminal / 文件写 / 工作区注册管理 / bridge 配置面。逐项 gate 落在 RoutedAction 分派层，与现有 owner/capability 模型并列新增「transport 维度」，不改动 loopback desktop 路径的任何语义。
- **撤销**：device token DB 删除即踢设备；keypair 轮换 = 全部重新配对。
- **不动的事**：「不放 LAN」决策保持——远程一律走 relay 出站，daemon 永远不监听公网/局域网。

### 4.5 测试

- Rust 单测：E2EE 握手/加解密往返；用 Paseo `packages/relay` 测试向量做帧格式兼容断言。
- 本地 e2e：docker 起社区 Go relay（或官方 Elixir 镜像），daemon 出站连它，模拟客户端走完配对→会话→断连重连。
- relay 不可达：本地功能零影响、退避重连（日志断言）。

## 5. Phase 3：公司服务器部署 relay

### 5.1 选型判断（待核实后定案）

默认推荐**社区 Go 单二进制**（zenghongtu/paseo-relay）：资源占用最小、单文件部署、协议 v2 兼容已由其文档与 main.go 与官方对齐记录佐证；官方 Elixir 镜像为备选（功能同、运行时更重）。若公司已有 Cloudflare 使用习惯，TS/DO 版亦可。**此项在 sysadmin 核实后定案，不在本 spec 锁死。**

### 5.2 部署要件

- 反代：nginx/Caddy 终结 TLS，`/ws` WebSocket upgrade + `/health` 透传（Paseo README 给有最小 nginx 配置）。
- 防火墙：公网仅入站 443；daemon 侧仅出站 wss。
- 容量：无状态字节转发，内存 ≈ 并发连接 × 每连接缓冲（Go 版默认 200 帧上限）。
- 落盘：零用户数据；仅访问日志（IP/时序）。

### 5.3 待系统管理员核实清单

1. 服务器选型与资源（可用哪台、Docker 权限有无）。
2. 域名与 TLS 证书签发（公司 CA vs Let's Encrypt；`relay.<company>` 子域）。
3. 员工机出站防火墙是否放行 wss:443（relay 模式只出站，通常无障碍，需确认）。
4. 运维归属：健康检查接哪个监控、升级流程。

## 6. 验收条件

- 退出/崩溃 Picot.app：agent 继续执行；重开接回现场（含运行中 turn）。
- daemon 仅出站连接公司 relay；经公网（手机热点）配对后，`?mobile=1` 浏览器客户端可读时间线、发 prompt、收到流式输出。
- relay 服务器不可达：本地零影响，重连退避恢复。
- `bun run test`、`bun run check:rust` 全绿；ARCHITECTURE.md 新增进程模型与远程信任维度章节（含与「不放 LAN」决策的关系说明）。

## 7. 规模与顺序判断

Phase 1 大（进程边界重构 + 窗口清理语义反转，main.rs/host_server 是主战场）；Phase 2 中（三模块，协议参数有 553 行参照逐条抄）；Phase 3 小（部署 + 核实）。1→2 强依赖（relay 连的必须是持久 daemon）；3 与 2 可并行推进（核实清单先行）。

## 8. 不做的事

- 移动端 app/PWA/推送通知（APNs/FCM）——单独立项；本 spec 交付的通道与配对即其地基。
- Hub 类触发器产品（GitHub/Slack 事件启动 agent）。
- LAN 直连、SSH 隧道等其它通道（Tailscale 用户可自行直连，不在产品内建）。
