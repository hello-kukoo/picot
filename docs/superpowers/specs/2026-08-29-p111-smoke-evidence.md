# P1.11 真 Pi 生命周期 smoke 证据

- 运行时间：2026-09-02T06:03:12.124Z
- 命令：`bun run scripts/smoke-native-lifecycle.mjs`（逐类执行 `cargo test --ignored native_smoke_<type>`）
- 被测路径：`pi_launch::native_launch_spec_for` → `NativePiManager::spawn`（真 embedded Pi + picot-bridge.mjs）→ 事件泵首帧 → `get_state` RPC 往返 → `stop` → Stopped

| runtime type | 结果 | 耗时 |
| --- | --- | --- |
| primary | ✅ pass | 74023ms |

- 结论：五类全部通过。
