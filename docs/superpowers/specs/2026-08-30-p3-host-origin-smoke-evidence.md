# P3 host-origin runtime smoke evidence

- Run time: 2026-09-14T11:26:30.665Z
- Command: `bun run smoke:host-origin-p3` → `cargo test native_smoke_host_origin_p3 -- --ignored --nocapture`
- Result: ✅ pass (4114ms; exit=0)
- Runtime: real Rust `HostServer` + real embedded Pi resolved by `native_launch_spec_for`.

## Command output

```text

running 1 test
test host_server::tests::native_smoke_host_origin_p3 ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 363 filtered out; finished in 3.79s

    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.27s
     Running unittests src/main.rs (target/debug/deps/picot-e15ccb762a3196e9)
```

## Covered path

1. Create registered workspace owner/capability through `WindowOwnerRegistry`.
2. Spawn native primary runtime with embedded Pi and bind `RuntimeTarget` to workspace/session.
3. Fetch `/workspaces/:workspaceId/sessions/:sessionId`; assert shell success and `<base href=`.
4. Fetch `/v2/bootstrap` with desktop capability; assert returned target matches registered runtime.
5. Assert `/ws` is absent, wrong-workspace bootstrap is `403`, missing capability is `401`.
6. Connect `/v2/ws`; send protocol v2 `hello` with desktop capability; assert `hello_ack`.
7. Subscribe target; assert `runtime_subscribed`.
8. Send read-only `runtime_snapshot_request` (`get_state`/messages/stats through real bridge); assert `runtime_snapshot`.
9. Send real `runtime_request` prompt; assert accepted response plus runtime event/turn identity.
10. Send turn-bound abort through same host path; assert exact turn is not treated as stale.
11. Close/reconnect WebSocket, re-hello, re-subscribe, request authoritative snapshot; assert sequence watermark is retained.
12. Stop real runtime and host; remove temporary workspace.

## Conclusion

Real host-origin P3 smoke passed.
