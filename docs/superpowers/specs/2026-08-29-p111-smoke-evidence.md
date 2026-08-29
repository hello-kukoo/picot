# P1.11 真 Pi 生命周期 smoke 证据

- 运行时间：2026-08-29T11:48:02.982Z
- 命令：`bun run scripts/smoke-native-lifecycle.mjs`（逐类执行 `cargo test --ignored native_smoke_<type>`）
- 被测路径：`pi_launch::native_launch_spec_for` → `NativePiManager::spawn`（真 embedded Pi + picot-bridge.mjs）→ 事件泵首帧 → `get_state` RPC 往返 → `stop` → Stopped

| runtime type | 结果 | 耗时 |
| --- | --- | --- |
| primary | ✅ pass | 56663ms |
| dedicated | ✅ pass | 2834ms |
| side_chat | ✅ pass | 2603ms |
| quick_chat | ✅ pass | 2601ms |
| standby | ✅ pass | 2575ms |

- 结论：五类全部通过。
