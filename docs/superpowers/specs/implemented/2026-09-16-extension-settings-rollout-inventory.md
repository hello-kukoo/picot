# Extension Settings Rollout Inventory (packages 3–14)

**Status:** Draft — inventory verified against installed sources on 2026-09-16;
per-package specs referenced below await Dr. Lin's grilling.
**Date:** 2026-09-16
**Provenance:** `~/.pi/agent/settings.json` `packages[]` minus Open-TUI
(excluded by Dr. Lin) and advisor/fff (already implemented, see
`2026-09-13-advisor-extension-settings-design.md` /
`2026-09-13-fff-extension-settings-design.md`).

## Scope

Every qualifying package gets an entry in the existing per-package renderer
map (`public/settings/package-extension-settings.js`). This inventory fixes
the **order**, the **transport split**, and records the **exclusions**.

## Transport rule (fff precedent, per Dr. Lin 2026-09-16)

- **Pure file + env detection (9 entries)** → host control ops
  (`require_native_owner`, Desktop+owner, **landing included**) in a
  dedicated Rust module per package, transport methods on the frontend,
  writes via `host_config::write_json`. Precedent: the fff host migration
  (`src-tauri/src/fff_config.rs`, spec'd in the 2026-09-13 fff spec as
  "migrated same day to host ops … landing configurability"). Env is read
  from the host process — accurate for the embedded Pi because the child
  inherits host env and `launch.environment` never sets these vars; flag
  detection is dropped host-side (host constructs the argv and never adds
  these flags; terminal pi's flags are per-instance and unobservable).
- **Model-catalog dependent (3 entries: plan-mode, safety-guard,
  web-access)** → stay on the bridge (`configGateway`, in-process
  modelRegistry — advisor's rationale verbatim). Landing: plan-mode,
  safety-guard, and web-access render via the bridge-service config
  runtime (`2026-09-18-landing-bridge-runtime-design.md`, Dr. Lin
  2026-09-20), global-only. A section split across two transports was
  considered and rejected.

## Excluded (with evidence)

| Package | Reason |
| --- | --- |
| `npm:pi-mcp-adapter` | Layered `mcp.json` already covered by Settings → MCP page (`extensions/mcp-settings.ts`, landed `5548f03`). |
| `npm:pi-playwright` | Skills-only package; no runtime config file, nothing to configure. |
| `npm:pi-simplify` | Single `/simplify` command; no config surface in `src/`. |
| `git:edxeth/pi-subagents` | Env plumbing only (`PI_ARTIFACT_PROJECT_ROOT`, `PI_SUBAGENT_PARENT_SESSION`, `PI_DENY_TOOLS`) — protocol internals, not user settings. |
| `npm:@upstash/context7-pi` | Single env var `CONTEXT7_API_KEY`; no file config. Shell env is the user's domain (fff spec decision). |
| `npm:context-mode` | Multi-host-CLI plugin; config lives in host-side settings/hooks layers, no stable Picot-writable file surface. Revisit if it grows a pi-native config file. |

## Qualifying packages (recommended order)

Ordered by: shared-family reuse first, flat configs before model-picking
configs, secrets last (highest design risk).

| # | Package | Spec | Config file | Transport | Effect timing |
| --- | --- | --- | --- | --- | --- |
| 1 | `@juicesharp/rpiv-todo` | [rpiv-todo](2026-09-16-rpiv-todo-extension-settings-design.md) | `~/.config/rpiv-todo/config.json` (XDG) | host | immediate — per-render fresh read (source-verified) |
| 2 | `@juicesharp/rpiv-ask-user-question` | [rpiv-ask-user-question](2026-09-16-rpiv-ask-user-question-extension-settings-design.md) | `~/.config/rpiv-ask-user-question/config.json` | host | immediate (family pattern; verify at impl) |
| 3 | `pi-caveman` (git) | [caveman](2026-09-16-caveman-extension-settings-design.md) | `~/.pi/agent/caveman.json` | host | new session |
| 4 | `@dietrichgebert/ponytail` | [ponytail](2026-09-16-ponytail-extension-settings-design.md) | `~/.config/ponytail/config.json` | host | new session |
| 5 | `@sting8k/pi-vcc` | [vcc](2026-09-16-vcc-extension-settings-design.md) | `~/.pi/agent/pi-vcc-config.json` | host | next compaction |
| 6 | `@narumitw/pi-goal` | [goal](2026-09-16-goal-extension-settings-design.md) | `~/.pi/agent/pi-goal.json` | host | next `/goal` run |
| 7 | `@narumitw/pi-plan-mode` | [plan-mode](2026-09-16-plan-mode-extension-settings-design.md) | `~/.pi/agent/pi-plan-mode.json` | bridge | new session |
| 8 | `@firstpick/pi-extension-safety-guard` | [safety-guard](2026-09-16-safety-guard-extension-settings-design.md) | `~/.pi/agent/safety-guard.json` | bridge | immediate — per-event read (verify at impl) |
| 9 | `@demigodmode/pi-web-agent` | [web-agent](2026-09-16-web-agent-extension-settings-design.md) | `~/.pi/agent/extensions/pi-web-agent/config.json` (global layer) | host (optional `cwd`) | new session (verify) |
| 10 | `pi-cache-optimizer` | [cache-optimizer](2026-09-16-cache-optimizer-extension-settings-design.md) | `~/.pi/agent/pi-cache-optimizer-config.json` | host | Pi restart or `/reload` |
| 11 | `pi-lens` | [lens](2026-09-16-lens-extension-settings-design.md) | `~/.pi-lens/config.json` (global layer) | host (optional `cwd`) | new session |
| 12 | `pi-web-access` | [web-access](2026-09-16-web-access-extension-settings-design.md) | `~/.pi/agent/web-search.json` | bridge | Pi restart (per-module config cache) |

## Dependencies

- All entries ride on the shared infrastructure already in tree: the
  renderer map with per-entry transport routing
  (`{ configGateway, transport }` — advisor gateway-gated, fff
  transport-only) and, for host entries, the `fff_config.rs` control-op
  pattern (`require_native_owner` + `host_config::write_json`).
- The 2026-09-15 review findings are closed in tree: advisor's XDG fix
  landed bridge-side; fff's argv-scan issues were dissolved by the host
  migration (flag tier dropped by design); the advisor failed-save rollback
  (`lastSaved`) landed.
- #7 (plan-mode) and #8 (safety-guard) reuse the advisor model-picker
  machinery (live `modelRegistry` + `getSupportedThinkingLevels`).

## Out of scope (rollout-level)

Adding entries for packages without a verified file-backed config surface,
and any generic settings-schema framework (advisor grilling decision stands:
per-package renderer map is the extension point).
