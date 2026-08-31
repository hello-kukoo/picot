# Gate A Deletion Proof Audit (P8-1)

日期：2026-08-30 ｜ 方法：inventory 144 caller 逐行交叉核验 native host_server 路由

## 总览

| 分类 | 数量 | 处置 |
| --- | --- | --- |
| 已迁移 native host | 15 | 前端切换后可删 legacy 端 |
| D8 退役 | 1 (`/api/rpc`) | 410 Gone + 匿名计数已上线 |
| 未迁移（P6 延迟行） | 21 | P8 删除范围——需 deprecated usage = 0 后物理删除 |

## 已迁移（native host_server 已实现）

- [x] `/api/cost-dashboard` → compat_cost_dashboard（cost_compat parity）
- [x] `/api/files` → compat_files（host_data containment）
- [x] `/api/health` → health（v2 host）
- [x] `/api/home` → compat_home（capability 鉴权）
- [x] `/api/instances` → compat_instances（running_targets）
- [x] `/api/pi-version` → pi_version
- [x] `/api/search` → compat_search
- [x] `/api/sessions` → compat_sessions
- [x] `/api/sessions/delete-batch` → compat_sessions_delete_batch（trash-first）
- [x] `/api/sessions/rename` → compat_sessions_rename（member check）
- [x] `/api/sessions/switch` → compat_sessions_switch（no-op parity）
- [x] `/api/sessions/{dir}/{file}` → compat_session_file（B2 修复）
- [x] `/api/workspace-info` → compat_workspace_info
- [x] `/api/workspace-sessions` → compat_workspace_sessions（B1 修复：多桶 + legacy shape）
- [x] `/api/workspace/open` → compat_workspace_open（owner-only）

## 退役（D8）

- [x] `/api/rpc` → 410 Gone + `Deprecation: true` + 匿名 client-class 计数（**前端的 rpcCommand / fetchModelInfo / Settings get_state 已不再 POST 此面**）
- [x] `/api/agent-config`、`/api/models-config`、`/api/agents-md`、`/api/append-system-md` → 410 Gone；ConfigGateway 改走 host 控制 op `agent_text_file_get`/`agent_text_file_put`（按文件名分 target，models.json 亦为文本面）
- [x] `/api/file-mentions` → 410 Gone；两个 composer 改走数据 op `file_mentions`
- [x] `/api/paste-offload` → 410 Gone；两个 composer 改走 `/v2/paste-offload`
- [x] `/api/open` → 410 Gone；工作区/文件管理器打开改走控制 op `open_in_app`，URL 走 `open_external`
- [x] `/api/chat-telegram/{op}`、`/api/skill-install-{links,scan}`、`/api/super-agent/{projects,tasks}`、`/api/lan-qr` → 410 Gone（scope 已移除）

## 能力缺口（native 尚无实现，前端已显式报错或降级）

| 面 | 现状 | 需要决定 |
| --- | --- | --- |
| `/api/files/content`、`/api/files/raw` | 410 Gone；`file_read`/`file_write`/`file_raw` 数据 op 已存在但预览面板未接 | Office 预览（MarkItDown）在 host 侧无 op；图像/PDF 需定 blob URL 还是 token 下载路由 |
| `/api/git-branch` | 410 Gone；指示器降级为空 | 用 `git_status` 快照的 branch 字段驱动，还是补 `git_branch` op |
| `/api/chat-config` + Super Agent/Telegram 组件 | 410 Gone；组件仍在 DOM | 移除死 UI，还是重议 scope |
| `/api/rpc` 的 5 个 provider op（catalog / set_api_key / remove_api_key / check_model_health / set_model_visibility） | ConfigGateway 返回 `no native runtime implementation` | 需 host 侧凭证/目录 op（Pi credential store 投影） |
| `list_skills`、`list_skill_inventory`、`set_skill_enabled`、`list_package_skill_inventory`、`set_default_thinking_level` | `rpcCommand` 返回显式失败 | 需 host 数据/控制 op（skills 清单、thinking 默认值） |

## 未迁移——P8 物理删除候选（删除前置：deprecated usage = 0）

| 路由 | 唯一 production caller | 说明 |
| --- | --- | --- |
| `/api/files/content` | `file-preview-panel.js` | v2 `file_read`/`file_write` 已有，缺 Office 转换 |
| `/api/files/raw` | `file-preview-renderers.js` + `file-pdf-preview.js` | v2 `file_raw`（base64）已有，缺 URL 形态决策 |
| `/api/git-branch` | `app.js` | 可用 `git_status` 快照替代 |
| `/api/chat-config` | `chat-settings-panel.js` + `sa-chat-header.js` | scope 移除待决 |

## 结论

**15/37 已迁移 + 1 退役 = 16/37 有 native 等价物。** 剩余 21 条路由中：

- 6 条已有 v2 等价 op（file-mentions → `file_mentions`、files/content → `file_read`、files/raw → `file_raw`、paste-offload → `/v2/paste-offload`）——**本轮已完成 file-mentions / paste-offload / open / agent·models·agents·append-system 配置面的前端切换**；files/content·raw 因 Office 预览与 URL 形态待决而保留 410

> 本段以下数字为 P8-1 审计当时快照，已被上一段与「能力缺口」表取代。

- 15 条属 P6 延迟行（Telegram、git-branch、super-agent、skills、lan-qr、open、agent/models-config）

**P8 物理删除前置**：deprecated usage telemetry（D10 Stage 2+）必须显示上述 21 条路由在两个稳定 release 周期内零命中。
