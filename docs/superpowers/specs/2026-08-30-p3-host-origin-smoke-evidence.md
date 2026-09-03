# P3 host-origin runtime smoke evidence

- Run time: 2026-09-02T09:01:37.144Z
- Command: `bun run smoke:host-origin-p3` → `cargo test native_smoke_host_origin_p3 -- --ignored --nocapture`
- Result: ✅ pass (58309ms; exit=0)
- Runtime: real Rust `HostServer` + real embedded Pi resolved by `native_launch_spec_for`.

## Command output

```text

running 1 test
test host_server::tests::native_smoke_host_origin_p3 ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 331 filtered out; finished in 3.40s

   Compiling proc-macro2 v1.0.106
   Compiling unicode-ident v1.0.24
   Compiling quote v1.0.45
   Compiling libc v0.2.186
   Compiling serde_core v1.0.228
   Compiling find-msvc-tools v0.1.9
   Compiling shlex v1.3.0
   Compiling parking_lot_core v0.9.12
   Compiling zmij v1.0.21
   Compiling icu_normalizer_data v2.2.0
   Compiling cc v1.2.62
   Compiling icu_properties_data v2.2.0
   Compiling fastrand v2.4.1
   Compiling phf_generator v0.13.1
   Compiling stable_deref_trait v1.2.1
   Compiling getrandom v0.4.2
   Compiling smallvec v1.15.1
   Compiling serde v1.0.228
   Compiling thiserror v1.0.69
   Compiling syn v2.0.117
   Compiling thiserror v2.0.18
   Compiling autocfg v1.5.1
   Compiling phf_codegen v0.13.1
   Compiling ident_case v1.0.1
   Compiling bitflags v2.11.1
   Compiling typeid v1.0.3
   Compiling serde_json v1.0.150
   Compiling strsim v0.11.1
   Compiling erased-serde v0.4.10
   Compiling new_debug_unreachable v1.0.6
   Compiling version_check v0.9.5
   Compiling string_cache_codegen v0.6.1
   Compiling anyhow v1.0.102
   Compiling precomputed-hash v0.1.1
   Compiling web_atoms v0.2.4
   Compiling parking_lot v0.12.5
   Compiling serde_spanned v1.1.1
   Compiling string_cache v0.9.0
   Compiling errno v0.3.14
   Compiling semver v1.0.28
   Compiling dtoa v1.0.11
   Compiling synstructure v0.13.2
   Compiling darling_core v0.23.0
   Compiling percent-encoding v2.3.2
   Compiling ctor-proc-macro v0.0.7
   Compiling log v0.4.30
   Compiling ctor v0.8.0
   Compiling form_urlencoded v1.2.2
   Compiling dtoa-short v0.3.5
   Compiling uuid v1.23.1
   Compiling tendril v0.5.0
   Compiling zerofrom-derive v0.1.7
   Compiling yoke-derive v0.8.2
   Compiling serde_derive v1.0.228
   Compiling zerovec-derive v0.11.3
   Compiling displaydoc v0.2.6
   Compiling thiserror-impl v1.0.69
   Compiling phf_macros v0.13.1
   Compiling thiserror-impl v2.0.18
   Compiling darling_macro v0.23.0
   Compiling zerofrom v0.1.8
   Compiling phf v0.13.1
   Compiling cssparser-macros v0.6.1
   Compiling derive_more-impl v2.1.1
   Compiling darling v0.23.0
   Compiling selectors v0.36.1
   Compiling indexmap v1.9.3
   Compiling toml_datetime v1.1.1+spec-1.1.0
   Compiling camino v1.2.2
   Compiling derive_more v2.1.1
   Compiling toml v1.1.2+spec-1.1.0
   Compiling yoke v0.8.2
   Compiling markup5ever v0.38.0
   Compiling cssparser v0.36.0
   Compiling serde_derive_internals v0.29.1
   Compiling serde_with_macros v3.20.0
   Compiling servo_arc v0.4.3
   Compiling bit-vec v0.8.0
   Compiling hashbrown v0.12.3
   Compiling rustc-hash v2.1.2
   Compiling schemars v0.8.22
   Compiling bit-set v0.8.0
   Compiling schemars_derive v0.8.22
   Compiling html5ever v0.38.0
   Compiling cfb v0.7.3
   Compiling dyn-clone v1.0.20
   Compiling foldhash v0.2.0
   Compiling base64 v0.21.7
   Compiling serde-untagged v0.1.9
   Compiling infer v0.19.0
   Compiling serde_with v3.20.0
   Compiling signal-hook-registry v1.4.8
   Compiling objc2-exception-helper v0.1.1
   Compiling cargo-platform v0.1.9
   Compiling swift-rs v1.0.7
   Compiling jsonptr v0.6.3
   Compiling zerovec v0.11.6
   Compiling zerotrie v0.2.4
   Compiling json-patch v3.0.1
   Compiling cargo_metadata v0.19.2
   Compiling plist v1.9.0
   Compiling objc2 v0.6.4
   Compiling tokio-macros v2.7.0
   Compiling dom_query v0.27.0
   Compiling mio v1.2.0
   Compiling socket2 v0.6.3
   Compiling generic-array v0.14.7
   Compiling tokio v1.52.3
   Compiling rustc_version v0.4.1
   Compiling toml_datetime v0.7.5+spec-1.1.0
   Compiling winnow v0.7.15
   Compiling embed-resource v3.0.9
   Compiling dirs-sys v0.5.0
   Compiling tauri-winres v0.3.6
   Compiling dirs v6.0.0
   Compiling core-foundation v0.10.1
   Compiling crc32fast v1.5.0
   Compiling zerocopy v0.8.50
   Compiling getrandom v0.3.4
   Compiling toml v0.9.12+spec-1.1.0
   Compiling tinystr v0.8.3
   Compiling potential_utf v0.1.5
   Compiling icu_locale_core v2.2.0
   Compiling icu_collections v2.2.0
   Compiling icu_provider v2.2.0
   Compiling cargo_toml v0.22.3
   Compiling crypto-common v0.1.7
   Compiling icu_normalizer v2.2.0
   Compiling icu_properties v2.2.0
   Compiling block-buffer v0.10.4
   Compiling block2 v0.6.2
   Compiling objc2-core-foundation v0.3.2
   Compiling digest v0.10.7
   Compiling num_threads v0.1.7
   Compiling flate2 v1.1.9
   Compiling num-traits v0.2.19
   Compiling httparse v1.10.1
   Compiling idna_adapter v1.2.2
   Compiling idna v1.1.0
   Compiling objc2-foundation v0.3.2
   Compiling time v0.3.47
   Compiling url v2.5.8
   Compiling getrandom v0.2.17
   Compiling crossbeam-utils v0.8.21
   Compiling urlpattern v0.3.0
   Compiling dpi v0.1.2
   Compiling futures-macro v0.3.32
   Compiling cookie v0.18.1
   Compiling futures-util v0.3.32
   Compiling tauri-utils v2.9.2
   Compiling foreign-types-macros v0.2.3
   Compiling bitflags v1.3.2
   Compiling png v0.17.16
   Compiling crossbeam-channel v0.5.15
   Compiling foreign-types v0.5.0
   Compiling tokio-util v0.7.18
   Compiling dispatch2 v0.3.1
   Compiling core-graphics-types v0.2.0
   Compiling cpufeatures v0.2.17
   Compiling ring v0.17.14
   Compiling tauri-runtime v2.11.2
   Compiling wry v0.55.1
   Compiling rustix v1.1.4
   Compiling system-configuration-sys v0.6.0
   Compiling core-graphics v0.25.0
   Compiling sha2 v0.10.9
   Compiling ico v0.5.0
   Compiling ppv-lite86 v0.2.21
   Compiling png v0.18.1
   Compiling tauri-runtime-wry v2.11.2
   Compiling moxcms v0.8.1
   Compiling h2 v0.4.14
   Compiling keyboard-types v0.7.0
   Compiling security-framework-sys v2.17.0
   Compiling core-foundation v0.9.4
   Compiling tauri-plugin v2.6.2
   Compiling tauri-build v2.6.2
   Compiling tauri-codegen v2.6.2
   Compiling serialize-to-javascript-impl v0.1.2
   Compiling image v0.25.10
   Compiling serialize-to-javascript v0.1.2
   Compiling hyper v1.9.0
   Compiling objc2-app-kit v0.3.2
   Compiling system-configuration v0.7.0
   Compiling security-framework v3.7.0
   Compiling serde_repr v0.1.20
   Compiling rustls v0.23.40
   Compiling hyper-util v0.1.20
   Compiling rustls-webpki v0.103.13
   Compiling tempfile v3.27.0
   Compiling tower v0.5.3
   Compiling sha1 v0.10.6
   Compiling rand_core v0.9.5
   Compiling ahash v0.8.12
   Compiling signal-hook v0.3.18
   Compiling native-tls v0.2.18
   Compiling tauri v2.11.2
   Compiling tauri-macros v2.6.2
   Compiling tauri-plugin-fs v2.5.1
   Compiling rand_chacha v0.9.0
   Compiling rand_core v0.6.4
   Compiling cfg_aliases v0.1.1
   Compiling pkg-config v0.3.33
   Compiling vcpkg v0.2.15
   Compiling rust_decimal v1.42.0
   Compiling rand_chacha v0.3.1
   Compiling nix v0.28.0
   Compiling tower-http v0.6.11
   Compiling rand v0.9.5
   Compiling libsqlite3-sys v0.30.1
   Compiling tokio-rustls v0.26.4
   Compiling objc2-web-kit v0.3.2
   Compiling tao v0.35.3
   Compiling muda v0.19.2
   Compiling window-vibrancy v0.6.0
   Compiling tauri-plugin-log v2.8.0
   Compiling tauri-plugin-process v2.3.1
   Compiling tauri-plugin-updater v2.10.1
   Compiling tauri-plugin-dialog v2.7.1
   Compiling tauri-plugin-shell v2.3.5
   Compiling os_pipe v1.2.3
   Compiling rfd v0.16.0
   Compiling serde_urlencoded v0.7.1
   Compiling sigchld v0.2.4
   Compiling hyper-rustls v0.27.9
   Compiling tungstenite v0.29.0
   Compiling objc2-osa-kit v0.3.2
   Compiling rustls-platform-verifier v0.7.0
   Compiling hashbrown v0.14.5
   Compiling tokio-native-tls v0.3.1
   Compiling rand v0.8.6
   Compiling xattr v1.6.1
   Compiling filetime v0.2.29
   Compiling byte-unit v5.2.0
   Compiling open v5.3.5
   Compiling tungstenite v0.24.0
   Compiling tar v0.4.46
   Compiling hashlink v0.9.1
   Compiling hyper-tls v0.6.0
   Compiling reqwest v0.13.4
   Compiling osakit v0.3.1
   Compiling tokio-tungstenite v0.29.0
   Compiling shared_child v1.1.1
   Compiling picot v0.3.6 (/Users/linyong/tmp/PI/picot-v3/src-tauri)
   Compiling dirs-sys v0.4.1
   Compiling filedescriptor v0.8.3
   Compiling serial2 v0.2.37
   Compiling serde_path_to_error v0.1.20
   Compiling fix-path-env v0.0.0 (https://github.com/tauri-apps/fix-path-env-rs#c4c45d50)
   Compiling chrono v0.4.44
   Compiling dirs v5.0.1
   Compiling reqwest v0.12.28
   Compiling tokio-tungstenite v0.24.0
   Compiling axum v0.8.9
   Compiling rusqlite v0.32.1
   Compiling portable-pty v0.9.0
    Finished `test` profile [unoptimized + debuginfo] target(s) in 53.80s
     Running unittests src/main.rs (target/debug/deps/picot-8e9a29133e7c20ac)
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
