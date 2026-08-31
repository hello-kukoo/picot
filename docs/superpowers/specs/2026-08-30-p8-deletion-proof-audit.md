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

- [x] `/api/rpc` → 410 Gone + `Deprecation: true` + 匿名 client-class 计数

## 未迁移——P8 物理删除候选（删除前置：deprecated usage = 0）

| 路由 | 唯一 production caller | 说明 |
| --- | --- | --- |
| `/api/agent-config` | `settings/config-gateway-legacy.js` | P5 scope |
| `/api/models-config` | `settings/config-gateway-legacy.js` | P5 scope |
| `/api/chat-config` | `chat-settings-panel.js` + `sa-chat-header.js` | P6 deferred |
| `/api/chat-telegram/{bind,doctor,validate}` | `chat-settings-panel.js` | P6 deferred |
| `/api/file-mentions` | `app.js` + `ephemeral-chat-view.js` | v2 data op 已有（file_mentions） |
| `/api/files/content` | `file-preview-panel.js` | v2 file_read/file_raw 已有 |
| `/api/files/raw` | `file-preview-panel.js` | v2 file_raw 已有 |
| `/api/git-branch` | `app.js` | P6 deferred |
| `/api/lan-qr` | `sa-chat-header.js` | P6 deferred |
| `/api/open` | 12 文件（generic URL opener） | 不是 workspace-open；是浏览器打开 URL |
| `/api/paste-offload` | `ephemeral-chat-view.js` | `/v2/paste-offload` 已有 |
| `/api/skill-install-{links,scan}` | `app.js` | P6 deferred |
| `/api/super-agent/{projects,tasks}` | `super-agent-runtime.js` | P6 deferred |

## 结论

**15/37 已迁移 + 1 退役 = 16/37 有 native 等价物。** 剩余 21 条路由中：

- 6 条已有 v2 等价 op（file-mentions → `file_mentions`、files/content → `file_read`、files/raw → `file_raw`、paste-offload → `/v2/paste-offload`）——前端切换后即可从删除清单移入已迁移
- 15 条属 P6 延迟行（Telegram、git-branch、super-agent、skills、lan-qr、open、agent/models-config）

**P8 物理删除前置**：deprecated usage telemetry（D10 Stage 2+）必须显示上述 21 条路由在两个稳定 release 周期内零命中。
