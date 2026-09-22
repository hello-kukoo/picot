# Gate R recovery rehearsal report

Evidence status: **EXECUTED_PARTIAL_BLOCKED**

Run date: 2026-08-29
Platform: macOS arm64

## Scope

This run used an isolated temporary HOME and a real locally available DMG artifact. It did not touch the user's application data, production resources, Git history, tags, or release publishing paths.

The full WP-R.5 `N-1 → N → N-1` rehearsal was **not claimed** because required version-matched artifacts and the controlled restore tool are unavailable.

## Real artifact evidence

| Item | Observation | Status |
| --- | --- | --- |
| Available artifact | `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Picot_0.3.5_aarch64.dmg` | observed |
| DMG SHA-256 | `ff312aa9fe18e54604d8738bedd329d1149926f0720dbeb8b00334369d75af35` | recorded |
| Bundle version | `0.3.5` from `Contents/Info.plist` | recorded |
| Embedded Pi | `.version` = `0.84.0` | recorded |
| Embedded Pi SHA-256 | `bd76da043c2fc9009ed864c2791679556b355d0eedbbc70c8377da355283b034` | recorded |
| Required resources | `embedded-server.mjs`, `picot-bridge.mjs`, `public/index.html`, `pi/pi` present | PASS |
| App code signature | `codesign --verify --deep --strict` | PASS |

Artifact is not a valid current N-1 candidate for this rehearsal: current source/package pin is Picot `0.3.6` / embedded Pi `0.84.2`, while artifact contains Picot `0.3.5` / Pi `0.84.0`.

## Isolated release-artifact launch

The `0.3.5` DMG app was mounted read-only and launched with:

- private `HOME` and `USERPROFILE` under `/tmp/picot-r5-*`;
- no user HOME access intended;
- 8-second observation window in the first run, then explicit SIGTERM in the controlled run;
- mounted app resources used directly.

Observed:

- app launched successfully;
- app spawned bundled Pi from `Contents/Resources/pi/pi`;
- app spawned primary, Quick Chat standby and Side Chat standby Pi children;
- app log was written only under isolated HOME;
- explicit SIGTERM terminated the app; observed shell exit code `143`;
- no `picot.sqlite3` appeared under isolated HOME during this launch.

Relevant isolated log evidence included:

```text
embedded-server resolved: source=bundled path=/Volumes/Picot/Picot.app/Contents/Resources/extensions/embedded-server.mjs
spawning pi: bin=/Volumes/Picot/Picot.app/Contents/Resources/pi/pi
pi process spawned: port=47822 pid=91303 identity=1
quick-chat standby warmed
side-chat standby warmed
```

Interpretation: real artifact launch/resource resolution is observed; registry DB creation and clean application shutdown are not proven by this run. This is partial evidence only, not R-01/R-08 closure.

## Component migration evidence

Current source metadata migration tests were run:

```text
cargo test --manifest-path src-tauri/Cargo.toml metadata_store::tests -- --nocapture
15 passed; 0 failed
```

These tests cover fresh schema, v2 upgrade, newer-schema refusal, unknown-table preservation, missing-directory pruning, session-file preservation, runtime preference fail-closed behavior and redacted audit behavior. They are component evidence, not release-artifact N-1 recovery evidence.

## Matrix status

| ID | Scenario | Status | Evidence / blocker |
| --- | --- | --- | --- |
| R-01 | fresh DB | BLOCKED | Real app launched, but no isolated `picot.sqlite3` observed; component fresh-DB test passed |
| R-02 | old DB upgrade | PARTIAL | component v2→v3 test passed; release artifact proof unavailable |
| R-03 | schema mismatch / N-1 refusal | PARTIAL | component newer-schema refusal test passed; matching N-1 artifact unavailable |
| R-04 | verified pre-upgrade backup | BLOCKED | no shipped rehearsal/restore tool |
| R-05 | version-matched controlled restore/downgrade | BLOCKED | no version-matched restore tool; no matching N-1/N artifacts |
| R-06 | missing workspace | BLOCKED | requires release recovery execution path |
| R-07 | missing directory | PARTIAL | component prune test passed; release artifact proof unavailable |
| R-08 | unregistered default `~/.pi/tmp` | PARTIAL | real artifact spawned fresh/temporary paths; no registry DB observed |
| R-09 | Quick Chat tokenized child lifecycle | PARTIAL | real artifact warmed Quick Chat standby; cleanup contract not verified end-to-end |
| R-10 | root-delete / symlink guard | BLOCKED | no release recovery runner |
| R-11 | cleanup failure / recovery | BLOCKED | no shipped recovery tool/path |
| R-12 | session-file preservation | PARTIAL | component preservation test passed; N-1 restore unavailable |
| R-13 | running runtime disposition | PARTIAL | real app/Pi children observed and explicitly terminated; versioned recovery disposition unavailable |
| R-14 | static cache | BLOCKED | no N-1/N artifact pair |
| R-15 | user remediation | BLOCKED | no controlled recovery UX/tool execution |

## Gate R decision

**Gate R closure: CANNOT CLOSE.**

Hard blockers:

1. No current `0.3.6` release artifact or matching `N-1` artifact pair is available. The only DMG is `0.3.5` containing embedded Pi `0.84.0`, while current pin is `0.84.2`.
2. No shipped version-matched controlled restore/downgrade tool exists. Git checkout/tag/source rollback is forbidden by the contract.
3. Windows release artifact and Windows-side runtime evidence are unavailable on this host.
4. The real artifact launch did not produce an isolated registry database, so fresh-install registry behavior remains unproven at release level.

Required unblock inputs:

- version-matched release artifacts for `N-1` and `N` (including embedded Pi versions and hashes);
- shipped/approved version-matched controlled restore/downgrade tool;
- isolated app-data override or documented test mechanism that makes release DB location inspectable without user-data mutation;
- Windows artifact/run evidence, or an explicitly accepted platform-boundary decision.

**Decisions recorded（2026-08-29，Dr. Lin）：**

- **R-03 first-window semantics（选项 A）**：`0.3.5`（registry-less）↔ 首个 registry release（`0.3.6`，Pi `0.84.2`）为本迁移窗口合法 rehearsal 对；`user_version` 拒启语义由 component 测试覆盖（R-03 component 部分已 PASS）；真实 schema-aware N-1 自 v3→v4 起存在。据此 Blocker 1 的 artifact 需求收敛为：构建 `0.3.6`（N）与现存 `0.3.5`（N-1）成对（含 embedded Pi 版本与 hash 记录）。
- **Windows platform boundary（选项 a）**：Gate R closure 以 macOS 证据判定；Windows artifact/run 硬证据顺延至 P8 release validation（spec §13.2 platform boundary 条目）。上列第 4 项 unblock input 以本决定满足。

据此，剩余 unblock 输入收敛为两项：`0.3.6` artifact 构建（同时解决 isolated DB 可观测性，Blocker 4）与 version-matched controlled restore/downgrade tool（Blocker 2）。

**R4.11 rescope（2026-08-29，Dr. Lin）：上两项 unblock 输入取消。**首迁移窗口（无装机、registry 首版本、DB 仅含可重建的 workspaces/paired_devices/preferences）恢复策略改为：component 测试（已 PASS）+ DB graceful degradation（open 失败/损坏→隔离重建+脱敏日志，WP-R.6）+ runbook 手动恢复（删 `picot.sqlite3` 重建）；artifact N-1 演练与 restore tool **deferred 且强制于首个有真实用户的 schema 升级窗口（v3→v4）**（spec §13.2 recovery posture）。本报告的 BLOCKED 案例据此标记为 deferred-window，不再阻塞 Gate R closure；Gate R 剩余阻塞收敛为 WP-R.6 实现与验证。

### WP-R.6 交付记录（2026-08-29）

**自动恢复（已实现）**：`MetadataStore::open` 检测 corruption-class 失败（SQLite `SQLITE_CORRUPT`/`SQLITE_NOTADB`，经 `PRAGMA quick_check(1)` 探测）时，将损坏文件改名为 `<name>.corrupt-<nanos>` 留存、重建新库并继续启动；日志仅含隔离文件名（不含路径/内容）。busy/locked、权限、IO、newer-schema 拒启均不触发隔离，保持原语义。测试：`corrupt_database_is_quarantined_and_recreated`、`fresh_and_valid_reopens_create_no_quarantine_files`（与 `newer_schema_than_supported_rejects_open` 守护共存）。

**手动恢复 runbook**：若应用仍报 metadata 错误（自动恢复未覆盖的极端情形）：1) 退出 Picot；2) 删除（或改名留存）`<app-data>/picot.sqlite3`；3) 重新启动——工作区列表与偏好会按使用重建，已配对设备需重新配对，**session 历史不受影响**（JSONL 在磁盘，不在 DB）。隔离文件 `picot.sqlite3.corrupt-*` 可安全删除或留作排查。

No Gate R closure, P0 unlock, P1 unlock, default-on decision, or legacy deletion claim is made by this report.
