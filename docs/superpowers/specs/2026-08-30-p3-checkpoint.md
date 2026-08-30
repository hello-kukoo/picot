# P3 checkpoint — host-origin existing-shell adapter

日期：2026-08-30

## 当前判定

**P3 implementation substrate：通过；P3 / Gate D release exit：未通过。**

### P3 scope status（2026-08-30）

- **Implementation：完成** — P3 adapter、HostServer capability/route contract、frontend host-origin integration、telemetry dry-run、real HostServer + embedded-Pi smoke 已落地。
- **Automated verification：通过** — Rust、Vitest、Biome、inventory、rehearsal、rollback component gates 均已通过。
- **Human-owned acceptance：待完成** — 按 `2026-08-30-p3-manual-e2e-checklist.md` 提交人工 browser/WebView E2E 结果、legacy/native 同 fixture p50/p95 性能样本、dogfood 观察结果与 D10 签署。以上完成前，不能将 P3 “完整实现和测试”或 Gate D 标为关闭。D10 依据见 `2026-08-30-d10-recommendation.md`。
  - **治理更新（2026-08-30，Dr. Lin 指令）**：D10 已框架性批准（`2026-08-30-d10-recommendation.md` §6）；Gate D 已按 R4.7 同构拆分先例 **design-closure**（`2026-08-27-ui-parity-and-rollout.md`），D-GAP-02/06/07/08 浏览器级残项正是本清单的人工 E2E 项，显式移交 P3.5/release exit 追踪。**P3 human acceptance 与 release exit 仍保持开放，不因 Gate D design-closure 而视为满足**；三件人工件同时是 D10 Stage 0 准入条件。

The code-level P3 substrate is implemented and verified: fail-closed rollout preference, registered-workspace-only native startup, `/workspaces/:wid/sessions/:sid` host-origin entry, `/v2/ws` capability handshake, owner/generation authorization, v1 control allowlist/adapter, retained owner-aware read routes, frontend capability injection, existing-shell v2 event/response/snapshot compatibility, sequence-gap snapshot recovery, telemetry schema/dry-run, and real HostServer + embedded-Pi host-origin interaction smoke.

It is not honest to call the phase complete because the plan §12 exit also requires full desktop parity, performance comparison, and dogfood/release decisions. Browser/WebView validation is manual per `2026-08-30-p3-manual-e2e-checklist.md`; it does not prove full desktop parity.

## P3 parity matrix (Gate A / Gate D)

| Surface | v1 input | v2 mapping | P3 status / evidence |
| --- | --- | --- | --- |
| Basic chat send/receive | `broker_command` with `payload.type=prompt` | `runtime_request` + target + `v1-cmd-*`; sequenced `runtime_event` → v1 `broker_event` | **PASS** — facade + wrap adapter, real client, ordered events |
| Cancel | `broker_command` with `payload.type=abort` | `runtime_request` with observed active `turnId`; no idempotency key | **PASS** — active abort, no-active-turn failure, stale-turn no-op |
| Reconnect | v1 reconnect / new socket | v2 hello with in-memory capability cache; resubscribe + snapshot | **PASS** — adapter test + browser reload smoke |
| Snapshot | `mirror_sync_request` | `runtime_snapshot_request` → v1 `mirror_sync` | **PASS** — facade + wrap roundtrip |
| Sequence gap | v2 `event_sequence_gap` | snapshot request, event buffering, snapshot-first delivery | **PASS** — ordering + no mutation resend tests |
| P4 data/session/cost | reads, export, session data | — | **EXPLICIT `unimplemented_route`** — deferred; no generic fallback |
| P5 file/config/OAuth | file/config and auth flows | — | **EXPLICIT `unimplemented_route`** — deferred; no generic fallback |
| P6 integration/terminal/temporary | terminal, integrations, ephemeral | — | **EXPLICIT `unimplemented_route`** — deferred; no generic fallback |

Deferred surfaces are centralized in `scripts/prototype/control-map.js`; both
adapter paths use same stable error. Matrix covers P3 scope only.

## Evidence

- `bun run check:rust`: PASS — 362 passed, 0 failed, 6 ignored; check and clippy pass. `cargo fmt --check` remains advisory pre-existing drift.
- `bun run test`: PASS — 182 files passed, 1 skipped; 1835 passed, 5 skipped.
- `bun run check`: PASS — Biome and design check.
- `bun run check:inventory`: PASS — generated inventory is up to date.
- `bun run check:rehearsal`: PASS with expected `UNEXECUTED_REAL_RELEASE_EVIDENCE` marker.
- `bun run build:extensions`: PASS.
- `bun run smoke:host-origin-p3`: PASS with real Rust HostServer and embedded Pi; evidence: `2026-08-30-p3-host-origin-smoke-evidence.md`.
- Manual browser/WebView E2E, dogfood, performance, and rollback procedure: `2026-08-30-p3-manual-e2e-checklist.md`. Picot intentionally adds no automated browser harness.
- `bun run vitest run scripts/prototype/adapter-prototype.test.js public/app/websocket-client.test.js public/app/host-origin.test.js`: PASS — 63/63 (37 adapter, 24 client, 2 origin).
- Retained-route HostServer contract suite: PASS — 8/8.
- `cargo test telemetry`: PASS — 3/3; default-off, allowlist, sampling, and redaction.
- D10 rollout proposal: `2026-08-30-d10-recommendation.md` — proposed dogfood/cohort stages, thresholds, telemetry contract, stop/hold/rollback runbook, and unsigned approval record; D10 remains pending.

## Explicit remaining exit requirements

1. Full browser/WebView static matrix, flow, capability revocation, sequence-gap UI, and retained-route behavior require manual E2E per `2026-08-30-p3-manual-e2e-checklist.md`; Picot intentionally has no automated browser harness.
2. Browser-level capability navigation/revocation and UI sequence-gap evidence.
3. Full inventory parity for all production callers; P4/P5/P6-specific surfaces remain intentionally deferred and return stable `unimplemented_route` rather than silently falling back.
4. Legacy/native same-fixture performance sample with recorded p50/p95; automatic baseline is intentionally deferred to the authorized dogfood/parity window.
5. Two-week dogfood and D10 cohort-threshold approval are external release gates, not code-test substitutes; proposed execution and thresholds are recorded in `2026-08-30-d10-recommendation.md` and remain unapproved.
6. Real rollback rehearsal remains the later release/recovery gate; Windows evidence remains P8 per R4.10.

## Safety boundary

- Host-origin production pages select only `/v2/ws`; no Pi-origin or bare `/ws` fallback.
- Temporary startup has no synthetic workspace ID; empty registry falls back to legacy.
- Desktop capability is not placed in URL, storage, static HTML, logs, or telemetry.
- Unsupported routes fail visibly with `unimplemented_route`.

This checkpoint records the implemented substrate and the remaining external Gate D/P3 exit gates; it does not claim P3 completion.
