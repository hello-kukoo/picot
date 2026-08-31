# P3 rollback rehearsal evidence

- Run time: 2026-08-30T23:32:32.116Z
- Harness: `scripts/rollback-rehearsal-p3.mjs`
- Scope: local component rehearsal only; no release artifact, N-1 binary, or user DB is mutated.
- Component result: **PASS** (6/6)

## Executed checks

| ID | Scenario | Result | Duration | Exit |
| --- | --- | --- | ---: | --- |
| flag-off-on | rollout flag off/on and authorization boundary | ✅ pass | 38619ms | 0 |
| running-child-cleanup | real embedded-Pi child cleanup after RPC round trip | ✅ pass | 3711ms | 0 |
| ordered-cleanup | ordered, idempotent cleanup and stale identity rejection | ✅ pass | 327ms | 0 |
| static-cache-invalidation | content-fingerprinted static path and cache-control policy | ✅ pass | 304ms | 0 |
| db-integrity | SQLite corruption quarantine/recreate and valid reopen | ✅ pass | 315ms | 0 |
| db-valid-reopen | SQLite valid database remains unquarantined | ✅ pass | 310ms | 0 |

## Raw command tails

### flag-off-on

Command: `cargo test runtime_preference --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --nocapture`

```text
   Compiling objc2-web-kit v0.3.2
   Compiling tao v0.35.3
   Compiling window-vibrancy v0.6.0
   Compiling muda v0.19.2
   Compiling objc2-osa-kit v0.3.2
   Compiling rfd v0.16.0
   Compiling osakit v0.3.1
   Compiling wry v0.55.1
   Compiling tauri-runtime v2.11.2
   Compiling tauri-runtime-wry v2.11.2
    Finished `test` profile [unoptimized + debuginfo] target(s) in 37.69s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

### running-child-cleanup

Command: `cargo test native_smoke_quick_chat --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --ignored --nocapture`

```text
running 1 test
test native_pi_manager::tests::native_smoke_quick_chat ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 389 filtered out; finished in 3.12s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.54s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

### ordered-cleanup

Command: `cargo test stop_is_ordered_idempotent_and_rejects_stale_identity --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --nocapture`

```text
running 1 test
test native_pi_manager::tests::stop_is_ordered_idempotent_and_rejects_stale_identity ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 389 filtered out; finished in 0.00s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.28s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

### static-cache-invalidation

Command: `cargo test serves_static_assets_under_a_content_fingerprinted_path --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --nocapture`

```text
running 1 test
test host_server::tests::serves_static_assets_under_a_content_fingerprinted_path ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 389 filtered out; finished in 0.01s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.25s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

### db-integrity

Command: `cargo test metadata_store::tests::corrupt_database_is_quarantined_and_recreated --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --nocapture`

```text
running 1 test
test metadata_store::tests::corrupt_database_is_quarantined_and_recreated ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 389 filtered out; finished in 0.00s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.26s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

### db-valid-reopen

Command: `cargo test metadata_store::tests::fresh_and_valid_reopens_create_no_quarantine_files --manifest-path /Users/linyong/tmp/PI/picot-v3/src-tauri/Cargo.toml -- --nocapture`

```text
running 1 test
test metadata_store::tests::fresh_and_valid_reopens_create_no_quarantine_files ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 389 filtered out; finished in 0.00s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.26s
     Running unittests src/main.rs (src-tauri/target/debug/deps/picot-8e9a29133e7c20ac)
```

## Rollback boundary

- Flag off/on: exercised through protected `runtime_preference` tests; invalid or unauthorized preference access must fail closed.
- Running child cleanup: exercised through real embedded Pi quick-chat lifecycle plus ordered in-memory cleanup contract.
- Static cache invalidation: exercised through content fingerprint path and no-store cache headers in HostServer test.
- DB integrity: exercised through SQLite corruption quarantine/recreate and valid reopen tests; original corrupt bytes remain retained by component contract.

## Blockers

- **Real N-1 → N → N-1 release rollback remains unexecuted.** This harness does not download, install, downgrade, or launch a versioned release artifact.
- **Platform coverage remains unexecuted.** Results below are only for current host; Windows/macOS packaged-artifact evidence requires authorized release runs.
- No component failure observed in this run.

Gate R/P3 rollback exit: **BLOCKED** until authorized release-artifact rehearsal records version-matched restore, child disposition, cache behavior, DB/session preservation, hashes, and user remediation.
