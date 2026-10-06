<!-- ABOUTME: ADR 0005——宿主偏好的键空间边界：通用通道限 ui.*，专用 op 可越前缀。 -->
<!-- ABOUTME: 记录 pi.pathEnabled 的落位决策与新增键的准入路径。 -->

# ADR 0005: 宿主偏好键空间边界（通用通道 vs 专用 op）

- 状态：Accepted
- 日期：2026-10-06
- 关联：ADR 0003（偏好存储边界）、`src-tauri/src/host_server.rs`（`preference_key` / `dispatch_preference_operation`、`pi_path_status` / `pi_path_configure`）、`extensions/skill-inventory.ts`、迁移计划 Phase 1

## 背景

ADR 0003 把 WebView 侧的偏好读写收窄为 `host_request` 的 `get_preference` / `set_preference` / `remove_preference`，并在 `preference_key()` 里硬性要求 `ui.` 前缀——理由是"前缀检查让被攻陷的客户端无法探测其它 metadata 行"。ADR 0003 同时预见："未来新增偏好命名空间需显式扩展白名单并评审边界"。

Phase 1 引入内置 Pi 的 PATH 开关，其状态需要一个持久位。沿 features-v3 的命名是 `pi.pathEnabled`，不带 `ui.` 前缀。

## 决策

1. **`ui.*` 前缀闸门只约束通用偏好通道**，不约束专用 host op。`pi.pathEnabled` 由 `pi_path_status` / `pi_path_configure` 两个专用 op 独占读写，键名从不由客户端提供（`pi_path_configure` 的入参只有 `{enabled}`）。
2. **不放宽白名单**：不把 `pi.` 加进 `preference_key()` 的前缀判定。通用通道仍是 `ui.*`-only，客户端可控的键空间一字未增——继续兑现 ADR 0003 的探测防护。
3. **专用 op 自带门禁**：越前缀的键必须随其 op 一起交付边界控制。本例如 `ensure_desktop_client`（仅桌面客户端）+ release-only（dev 构建拒绝）。
4. **新增越前缀键的准入路径**：在 `metadata_store` 的偏好表中新增非 `ui.` 键时，必须同时提供（a）专用 op，（b）该 op 的客户端类型/所有权门禁，（c）本 ADR 或后续 ADR 的一行记录。禁止把新前缀接进通用通道。

## 后果

- 通用偏好通道保持最小攻击面；`ui.*` 之外的状态位不会被任意客户端枚举或改写。
- 偏好的"读"路径出现两种形态：通用通道（`ui.*`）与专用 op（`pi.pathEnabled`）。审查新偏好时要先判断它属于哪一类，不能默认走通用通道。
- 专用 op 的门禁不得弱于通用通道：本 op 要求桌面客户端；若未来出现无门禁的专用偏好 op，即为本 ADR 的违规。
- ADR 0003 中"`ui.*` 是 WebView 侧偏好写入口径"的表述仍然成立——本 ADR 只界定它作用于哪条通道。
