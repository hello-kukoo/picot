# CP6/CP7/CP8 验收摘要 — P4/P5/P6 关闭

日期：2026-08-30 ｜ 状态：**已关闭（Dr. Lin 确认）**

## CP6 — P4 完：Cost fixture parity + delete/export contract

| Exit 条款 | 判定 | 证据 |
| --- | --- | --- |
| route response/error parity | ✅ | 15 compat 路由 owner capability 鉴权（boundary 测试矩阵：无 capability→401 / 跨 owner→403 / 未知→404）；8KiB body bound（rename/delete）；错误码稳定 |
| Cost fixture parity | ✅ | `cost_compat.rs` 逐字段移植 `parseRangeParams`/`buildCostDashboardPayload`（UTC day/ISO-week/month 桶 + JS number 语义 + series/breakdown/topSessions/infobar fractions）；同 JSONL fixture Rust↔TS 逐字段 parity 测试通过（scope=all + current） |
| delete/export contract | ✅ | delete：trash-first staging + running 保护（canonical compare）+ per-file `{deleted,errors,running}` + separator-safe containment；export：one-shot TTL'd owner+generation-bound token + 流式 GET /v2/session-export/{token} + transition revoke |

评审修复：B1（workspace-sessions legacy shape + 多桶合并）+ B2（session-file 路由）+ M1-M4（containment/running/rename/export 加固）全部闭环（commit 0e59eda）。

## CP7 — P5 完：Files/config/OAuth sole ownership

| Exit 条款 | 判定 | 证据 |
| --- | --- | --- |
| files/path security suite | ✅ | `host_files.rs`：symlink escape / TOCTOU re-check / atomic write / 0600 / mtime conflict / bounded read 全测 |
| config side-effect regression | ✅ | `host_config.rs` proper-lockfile（create_dir + stale takeover）；`settings_put` models/agent config 备份 + restartRequired 响应 |
| OAuth lifecycle matrix | ✅ (fail-closed) | 五控件 fail-closed 设计（Pi device-code bridge 为后续项）：`get_oauth_login_capabilities` → `providers:[]`；`start/logout` → 显式拒绝（不伪造操作）；`cancel/status` → 真实 host 状态（owner+generation 绑定 + cross-owner 不泄漏）；runtime_started/stopped generation 单调递增 + 旧操作撤销 |

**诚实边界**：OAuth start/logout 在 Pi bridge 落地前 fail-closed——这是有记录的设计决策，不是缺失。**OAuth 整体（含 Pi bridge）将放入人工 E2E 清单（P3.5）一并测试与验收（Dr. Lin 2026-08-30）。**

## CP8 — P6 完：Heavy integrations（范围缩减）

| Exit 条款 | 判定 | 证据 |
| --- | --- | --- |
| cancel | ✅ | v2 dispatch 支持 abort（P1.3 turn-bound abort 语义） |
| handle expiry | ✅ | paste-offload 1h TTL cleanup + zero-TTL 测试 |
| temp cleanup | ✅ | paste 过期清扫 + `.pi/tmp/.gitignore` 自忽略 |
| cross-runtime authority | ✅ | workspace containment（HostDataPlane strip_prefix + symlink 检查） |
| secret redaction | ✅ (不适用) | Telegram 已去除（见下），无 secret 处理面 |
| external timeout | ✅ (不适用) | Telegram 已去除（见下），无外部 API 调用 |

**范围缩减（Dr. Lin 2026-08-30）**：

- **Telegram**（secret redaction / timeout / rate / cancel）→ 从 P6 去除；`/api/chat-telegram/{bind,doctor,validate}` 随 legacy server 在 P8 终结
- **Super Agent**（projects/tasks / D9 RuntimeTarget）→ 从 P6 去除；`/api/super-agent/{projects,tasks}` 随 legacy server 在 P8 终结

已交付 P6 项：`/v2/paste-offload`（4MiB/TTL/quota/symlink/.gitignore）、file-mentions（v2 data op）、剩余按 matrix。

## 验证

```text
cargo test        384 passed / 0 failed / 6 ignored
clippy -D warnings Finished clean
bun run check     Design check passed
check:inventory   Migration inventory is up to date
```
