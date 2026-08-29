# Native Runtime Migration — Gate A Reviewed Inventory

> Evidence snapshot: 2026-08-28. Reviewed against `scripts/gen/inventory.json` (HTTP 37, WS commands 43, caller hits 139, Git controls 6, v2 frame types 6). This task changes documentation only; dirty production work is preserved.

## Method and status

Sources: `extensions/embedded-server.ts` (`handleApiRoute`, `handleCommand`, Node/Bun static adapters), `extensions/request-access.ts`, `public/`/HTML/tests, `src-tauri/src/main.rs`, `broker_ws.rs::dispatch_control`, `host_router.rs`, `workspace_controls.rs`, `host_server.rs`, `native_pi_manager.rs`. Generated IDs below match `scripts/gen/inventory.json`; the generator is syntax-oriented and not deletion proof. `L` loopback, `N` verified native owner, `R` paired remote, `LAN-ro` LAN read-only, `E-forbid` temporary runtime forbidden.

## 1. HTTP/static matrix

| ID / legacy surface | Authority, callers, class | Terminal / retirement | Parity, security, lifecycle tests; deletion proof |
| --- | --- | --- | --- |
| A-HTTP-01 static `/`, `index.html`, `cost.html`, locales/assets | `STATIC_DIR` containment; HTML navigation, `A-CALLER-072`; L | Host `/workspaces/:wid/sessions/:sid`, `/v/{fingerprint}/`; retire P8 | fallback/traversal/MIME/cache/dynamic import/CSS/worker/root-relative smoke; HTML+asset scan |
| A-HTTP-02 GET/PUT `/api/agent-config` | agent-root settings; `A-CALLER-085–086`; L/N | `agent_config_get/put`; retire | lock/atomic/0600/malformed/owner denial; zero legacy gateway calls |
| A-HTTP-03 GET/PUT `/api/chat-config` | app config; `A-CALLER-058–060,063`; L/N | chat controls; retire | config shape/secret redaction/error tests; caller scan |
| A-HTTP-04/05/06 Telegram bind/doctor/validate | config + external Telegram API; `A-CALLER-061–062`; L/N | owner controls; retire | 90s flow/timeout, token redaction, 0600, failure |
| A-HTTP-07 `/api/cost-dashboard` | Pi JSONL cost parser; `A-CALLER-067`; L | v2 compatibility `cost_dashboard`; retire after fixture parity | `range`, `granularity`, `scope=all | current`,`models`, fields, bucket/sort/cache identical on same JSONL fixture |
| A-HTTP-08/09 `/api/file-mentions[?]` | current Pi context/Root; dynamic UI caller; L, main only/E-forbid | v2 `file_mentions`; retire | containment, budget, abort, workspace race, loopback/temporary denial; AST+behavior |
| A-HTTP-10/15 `/api/files[?]` | Root/picker; file browser `A-CALLER-138`; L/N | v2 `list_files`; retire | root/symlink/picker/bounds; data parity |
| A-HTTP-11/12 `/api/files/content[?]` GET/PUT | Root, relative path, mtime/type; `A-CALLER-070–071`; L write | v2 `file_read/file_write`; retire | type/size/conflict/mtime/atomic/error codes; editor integration |
| A-HTTP-13/14 `/api/files/raw[?]` | Root + MIME allowlist; image/PDF renderers, vendor `A-CALLER-101–107`; L | v2 raw token/relative path; retire | byte/MIME/`nosniff`/no-store/sandbox/abort; image/PDF E2E |
| A-HTTP-16 `/api/git-branch` | current Pi cwd/Root; `A-CALLER-026`; L | owner-derived v2 `git_branch`; retire | bounded runner, transition, non-Git parity |
| A-HTTP-17 `/api/health` | embedded readiness; app `A-CALLER-043`, Rust probes; L | host `/health` + runtime readiness; retire | startup/crash/timeout/no-proxy/status parity |
| A-HTTP-18 `/api/home` | process home; `A-CALLER-024`; L | host app-global home or explicit retirement | disclosure/LAN denial; zero caller proof |
| A-HTTP-19 `/api/instances` | embedded registry; `A-CALLER-020,041,096`; L | v2 bootstrap/runtime snapshot | identity/owner/crash/reconnect parity |
| A-HTTP-20 `/api/lan-qr` | embedded LAN config; `A-CALLER-042` | host only if LAN approved, else retire | QR redaction/bind/port/firewall policy |
| A-HTTP-21 `/api/models-config` | Pi `models.json`; `A-CALLER-077–078`; L/N | model config controls | atomic write/visibility/no credentials/catalog refresh |
| A-HTTP-22 `/api/open` | OS opener + Root/URL; `A-CALLER-023,027,029,091,119,139`; N/L | `open_in_app/open_external` | no shell, path/URL/owner/platform tests |
| A-HTTP-23 `/api/paste-offload` | current context Root; `A-CALLER-034,069`; L/E-forbid | `/v2/paste-offload` | >=4 MiB, 0700, token/expiry/cleanup/symlink/root-delete |
| A-HTTP-24 `/api/pi-version` | embedded version; indirect app UI | host version data; retire | binary pin/resource smoke; AST/UI scan |
| A-HTTP-25 `/api/rpc` | Pi `handleCommand`; `A-CALLER-030–031,035–037,044,075–084,100` + dynamic; L | v2 `runtime_request`; `/v2/rpc` is D8 | command response/error/event/payload/auth/cancel/idempotency parity; zero caller proof |
| A-HTTP-26 `/api/search` | JSONL + caller canonical paths; `A-CALLER-097`; L | v2 `search_sessions` | bounds/name/first-message/scope/snippets fixture |
| A-HTTP-27/28/29 session delete/rename/switch | Pi files/SessionManager/process route; `A-CALLER-040,093,098,099`; L | v2 controls | trash-first/running/name append/generation/reconnect; real session fixture |
| A-HTTP-30/31 skill install scan/links | source registry + app secret; Rust `main.rs:1514,1556`; L/N/E-forbid | existing native controls; retire HTTP after parity | owner/window/root/generation/TTL/TOCTOU/constant-time secret; no browser URL |
| A-HTTP-32/33 Super Agent projects/tasks | stores; `A-CALLER-032–033,064–066`; N/L | host data/control | persistence, target authority, cross-runtime policy |
| A-HTTP-34 `/api/workspace-info` | Pi cwd + caller identity, not registry authority; `A-CALLER-021,028`; L | v2 registry/root data | canonical identity/transition/arbitrary-path denial |
| A-HTTP-35/36 workspace sessions | Pi `SessionManager.listAll` + canonical path; `A-CALLER-095`; L | v2 `list_sessions` by workspace ID | name/cache/path distinction; fixture |
| A-HTTP-37 `/api/workspace/open` | embedded launcher; no generated literal caller; L | v2 open/transition or retire | canonical path/owner/spawn/health/cleanup; launcher/HTML audit |

## 2. Embedded WebSocket command/event matrix

| ID / surface | Caller and authority/context | Terminal, tests, deletion proof |
| --- | --- | --- |
| A-WS-01 `abort` | `app.js:4031,5634`, ephemeral; active Pi turn/E-forbid | v2 turn-bound abort; disconnect A→end→B stale-turn test |
| A-WS-02/16/17/27/41 OAuth start/cancel/status/capabilities/logout | `public/settings/models-oauth-login.js`, config tests; Pi `ModelRuntime` owns token; N/E-forbid | owner OAuth controls, never R/LAN; device-code/expiry/cancel/logout/redaction |
| A-WS-03/04/05/06 health/compact/cycle model/thinking | app/settings dynamic RPC callers; Pi state | v2 runtime ops; provider timeout and lifecycle parity |
| A-WS-07 `ephemeral_snapshot_request` | `ephemeral-chat-runtime.js:250,433`; owner+instance+generation | explicit v2 ephemeral adapter; journal/watermark/replay/owner tests |
| A-WS-08 `export_html` | `app.js:3753`, `sidebar/index.js:1246`; Pi export path | v2 export + `/v2/session-export/{token}` one-shot; owner/root/generation/TTL/quota/bytes |
| A-WS-09 `extension_ui_response` | ephemeral runtime/dialog tests/native bridge; pending connection | v2 host response; cross-owner/size/expiry |
| A-WS-10/42 `follow_up/steer` | composer/dynamic RPC; active Pi turn | v2 keyed mutation; ordering/crash recovery |
| A-WS-11/22 auth status; A-WS-12/23 model catalog | settings/app/model pages | v2 auth/data; no credential leakage, cache invalidation |
| A-WS-13/35 thinking levels/default; A-WS-34 compaction | settings/toggles/tests | v2 controls; default/profile separation and lifecycle |
| A-WS-14/15 fork messages/messages; A-WS-19 stats | app/session refresh/fork | v2 data; exact fields/branch/reload sequence |
| A-WS-18 version; A-WS-20 tree; A-WS-21 state | app `5973/2069/3866/6227` | v2 data/snapshot; leaf and sequence-gap tests |
| A-WS-24/25/26 skills/package/list skills | settings tabs/tests | v2 owner controls; precedence/shadowing/empty manifest/lock |
| A-WS-28 `mirror_sync_request` | app `2711,4833,4876,4909,5034` | v2 snapshot after tree/transition |
| A-WS-29/43 new/switch; A-WS-30 prompt; A-WS-33 auth | app and dynamic RPC | v2 runtime controls; route/stream/error/idempotency/redaction |
| A-WS-31/32 API keys; A-WS-36/40 model/thinking; A-WS-37 visibility; A-WS-38 name; A-WS-39 skill toggle | settings/model/sidebar | v2 owner controls; Pi credential/config locks and reload-required tests |
| WS `/ws` events | `websocket-client`, app, ephemeral runtime; Pi broadcaster | v2 sequenced message/tool/thinking/agent/tree/mirror/OAuth/UI/model events; reconnect snapshot, unknown-event tolerance; AST+E2E deletion proof |

## 3. Broker controls, registry v1, host frames

`broker_ws.rs::dispatch_control` is generic; command authority is `main.rs`. Generated Git controls are not complete inventory.

| ID | Exact controls/surface | Authority/class and v2 destination | Tests/deletion proof |
| --- | --- | --- | --- |
| A-CTRL-01 session routing | `open_workspace,new_session,switch_session,fork,navigate_tree,stop_instance,spawn_session_process,open_devtools` | PiManager + broker route + owner N → v2 lifecycle | route generation/crash/window cleanup; all `sendControl` scan |
| A-CTRL-02 registry v1 | `workspace.list/add/remove/pin`; internal `workspace.touch` excluded | MetadataStore canonical root; N; `registry_changed` broadcasts all Native → v2 app-global registry | removed/prune shape, no FS delete, DB recovery/remote denial; no public touch caller |
| A-CTRL-03 preference v1 | `preference.get/set/delete/list` | MetadataStore N; v2 preference op; public API rejects `runtime.*`, internal rollout writer only for `runtime.native_origin` | key filtering/fail-closed/writer audit; all preference callers |
| A-CTRL-04 picker/open | `pick_folder,pick_image_files,pick_skill_source,open_in_app,open_external,list_installed_apps` | native dialog/OS N → v2 host controls | path/owner/platform; no direct HTTP replacement |
| A-CTRL-05 skills/packages | source/install + package list/check/install/remove/update/disable | source registry/Pi package manager N/E-forbid → v2 controls | TTL/TOCTOU/package parity/settings scan |
| A-CTRL-06 profile/config/runtime | `session_ui_profile_load/save,get_cached_models,restart_runtime,get_pi_version,get_app_version,is_dev` | host store/binary N → v2 data/control | binding/restart cleanup/version smoke |
| A-CTRL-07 updater | `check_for_update,download_and_install_update` | Tauri updater N → host control | progress/reconnect/error; caller scan |
| A-CTRL-08 extension UI | `rpc_extension_ui_response,ephemeral_extension_ui_response` | pending Pi dialog/owner route → v2 UI response | cross-owner/size/expiry |
| A-CTRL-09 ephemeral | `ephemeral_create,ephemeral_replace_quick,ephemeral_close,ephemeral_bootstrap,ephemeral_update_ui` | EphemeralRegistry owner/generation/temp token N only → explicit v2 policy/adapter | quota, Quick 0700 cleanup, standby, transition/exit |
| A-CTRL-10 transition | `workspace_target_prepare,workspace_transition_commit/cancel` | WindowOwnerRegistry canonical target/generation → v2 transaction | stale generation/cross-workspace/Temporary |
| A-CTRL-11 window | `window_close_cancel/approve/risk_response,relaunch_app` | owner/window lifecycle N → host lifecycle | close approval/restart |
| A-CTRL-12 Git | `status,diff,commit,log,log_detail,commit_diff` | owner/root/generation snapshots; host data already implemented | OID/path/snapshot/write; adapter removal only after JS scan |
| A-CTRL-13 terminal/Super Agent | `terminal_*`, Super Agent dispatch | terminal store/owner; target policy | generation/ack/backpressure/cross-runtime |
| A-V2 host frames | `hello,host_request,runtime_capabilities_request,runtime_request,runtime_snapshot_request,runtime_subscribe` | `host_router.rs`; shape/idempotency current, capability/target policy incomplete | handshake/capability/remote/LAN/target tests |

## 4. Caller/external evidence

Exact generated caller records are `A-CALLER-001..139` in `scripts/gen/inventory.json`. Reverse lookup covers: `public/app.js` (instances/workspace/open/home/Git/RPC/paste/Super Agent/session/health/LAN), `public/sidebar/index.js` (list/delete/search/rename/export/RPC), file browser/preview/PDF/image, `public/settings/config-gateway-legacy.js`, OAuth/models/skills/package tabs, chat/Super Agent components, ephemeral view/runtime, `public/super-agent/dispatch.js`, HTML entries, tests, generated dist, vendor PDF.

Telegram calls in `extensions/pi-chat-*` and package catalog URL are external destinations, not local Picot callers. Vendor PDF fetches and app dynamic `fetch(url)` at `app.js:4957,5000` need URL classification. User/global/project Pi extensions are dynamically discovered and cannot be proven from checkout.

## 5. D8 evidence and closure decision

Repository search found no separate external client package, LAN/mobile source, shell automation, deployment manifest, or extension consumer calling local `/api/rpc`; native code calls `/v2/bootstrap` and `/v2/ws`. This cannot prove released old bundles, downstream forks, user extensions, automation, or clients outside repo. No usage telemetry exists.

**D8 remains undecided.** Evidence does not establish whether `/v2/rpc` is required. Do not silently approve deletion or permanent compatibility. If retained, require versioned deprecation header, anonymous client-class usage counter, N-1 support window, removal notice, and no hidden second RPC API. D8 blocks P7/P8.

Uncovered: dynamic fetch URL semantics, dynamic file-mention construction, `/api/workspace/open` caller, complete HTML/static URL graph, PDF worker resource URLs, `terminal_command`, user extension discovery, session-file download terminal mapping, and external released/deployed callers. Authority gaps: v2 capability binding, complete Remote/LAN matrix, registry `OwnerWorkspaceSnapshot`/Temporary policy, and host session-export/download implementation.

**Gate A cannot close.** Known surfaces now have function-level authority, route/command/event, caller, terminal candidate, auth/context, parity/security/lifecycle tests, and deletion proof. Close requires classifying uncovered items, obtaining external D8 evidence, human row review, and passing `bun run migration:inventory` plus `bun run check:inventory`.
