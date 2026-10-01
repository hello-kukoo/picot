# subagent-async widget fixtures (real RPC capture)

Evidence-only fixtures for the `subagent-async` widget contract (`pi-subagents`
snapshot → Pi RPC `setWidget` → Picot widget registry). Derived from a **real
Pi→RPC capture**, not from re-encoding the sender's source code
(`docs/superpowers/specs/not-started/2026-09-30-subagent-async-widget-renderer-design.md`
§验收口径; `docs/engineering-lessons.md:13-25`).

## Files

| File | Content |
| --- | --- |
| `set-widget-update.json` | One `extension_ui_request` / `setWidget` frame with `widgetLines` (a single run in `running` state, one child). Verbatim bytes as written to Pi's stdout. |
| `set-widget-delete.json` | One `extension_ui_request` / `setWidget` delete frame (`widgetLines` key absent). Verbatim bytes as written to Pi's stdout. |

The frames are pretty-printed so `bun run check` (Biome JSON formatter) stays
green — the JSON whitespace outside the payload was normalized for that; the
`widgetLines` string itself, the key set, and the `id` values (capture-time
random UUIDs) are byte-verbatim from the capture.

## Origin

- **Date:** 2026-09-30 (local, +08)
- **Pi:** `pi 0.87.1` (`/opt/homebrew/bin/pi` → `@earendil-works/pi-coding-agent/dist/bundle/cli.js`)
- **Sender:** `pi-subagents 0.73.1` (`~/.pi/agent/npm/node_modules/pi-subagents/package.json`)
- **Scratch dir:** `/tmp/pi-async-capture` (removed after capture)
- **Command:** `pi --mode rpc --no-session` (cwd `/tmp/pi-async-capture`, stdin/stdout JSONL)
- **Trigger:** one stdin command
  ```json
  {"id":"p1","type":"prompt","message":"/run worker Reply with exactly one word: OK. Use no tools. --bg"}
  ```
  i.e. the extension's `/run … --bg` async path (pi-subagents `src/slash/slash-commands.js:598`), not the `subagent` tool.
- **Captured:** 20 `setWidget` frames with `widgetKey === "subagent-async"` — 17 update frames (single-line `widgetLines`) and 3 delete frames. 17 updates: `queued` → `running` → `complete`, then deletes after the async job set emptied.

### Capture caveat (important for reproducing)

A Pi process started from inside a pi-subagents child run inherits
`PI_SUBAGENT_CHILD=1`, and pi-subagents' entry point returns early on it
(`src/extension/index.js:371-374`), so **no** `subagent` tool, **no** `/run`
command, and **no** widget is registered. The capture environment must clear
`PI_SUBAGENT_CHILD` (and `PI_SUBAGENT_PARENT_SESSION`). Without this,
`get_commands` shows no `run` and the widget never appears — a false negative,
not a protocol fact. Picot's own runtimes do not set this variable.

## Wire shape (observed)

`(a)` **Update frame** — `set-widget-update.json`

```json
{"type":"extension_ui_request","id":"<uuid>","method":"setWidget","widgetKey":"subagent-async","widgetLines":["PI_SUBAGENT_ASYNC_JSON:{…}"]}
```

- keys on the wire: `type`, `id`, `method`, `widgetKey`, `widgetLines` — and nothing else.
- `widgetLines` is **exactly one** element (array length 1, every update frame), starting with the literal prefix `PI_SUBAGENT_ASYNC_JSON:` followed by one JSON object.
- `widgetPlacement`: **absent in all 20 frames.** Pi's RPC `setWidget` builds the record as
  `{…, widgetLines: content, widgetPlacement: options?.placement}` and serializes with plain
  `JSON.stringify` (`packages/coding-agent/src/modes/rpc/rpc-mode.ts:195-213`;
  `packages/coding-agent/src/modes/rpc/jsonl.ts:10-12`); pi-subagents calls
  `ctx.ui.setWidget(WIDGET_KEY, lines)` with no options (`src/tui/render.js:2941`), so the
  `undefined` placement is dropped on the wire. Non-key, no impact.
- Snapshot top level: `kind:"pi-subagents.async-status-snapshot"`, `version:1`, `generatedAt`,
  `caps{maxRuns:20,maxChildrenPerNode:8,maxDepth:3,maxStringLength:160,maxSerializedBytes:32768}`,
  `omitted{runs,children,byteLimitExceeded}`, `runs[]`.
- Run node keys actually seen: `id`, `kind`, `label`, `state`, `startedAt`, `updatedAt`
  (+ `endedAt` once terminal, + `children` while/after running).
  **`activity` was never present in this capture** — the `activity.*` fields the spec
  describes are optional in practice, not guaranteed.

`(b)` **Delete frame** — `set-widget-delete.json`

```json
{"type":"extension_ui_request","id":"<uuid>","method":"setWidget","widgetKey":"subagent-async"}
```

- keys on the wire: `type`, `id`, `method`, `widgetKey` — **`widgetLines` is field-absent**, not
  `null`, not empty array, and not a literal `undefined` (impossible in JSON).
- All 3 delete frames are byte-identical apart from `id`. One of them arrives *before* any
  update frame (initial clear at session start); deletes also arrive repeatedly after the task
  set empties.

`(c)` **Fields the spec assumed but the wire omits:** `widgetPlacement` (absent, see above);
`widgetLines` on delete (absent, see above). Also omitted in this capture: run-level `activity`,
and `omitted.runs > 0` never occurred (`runs: []` was not observed; the deleted frame arrives
instead). `caps.maxSerializedBytes = 32768` matches the spec's own 32 KiB pre-parse limit.

### Additional captured frames (same run, not fixture files)

Queued (first update):

```json
{"type":"extension_ui_request","id":"c9233932-8d1f-4c40-b2f2-edf375112398","method":"setWidget","widgetKey":"subagent-async","widgetLines":["PI_SUBAGENT_ASYNC_JSON:{\"kind\":\"pi-subagents.async-status-snapshot\",\"version\":1,\"generatedAt\":1790778414946,\"caps\":{\"maxRuns\":20,\"maxChildrenPerNode\":8,\"maxDepth\":3,\"maxStringLength\":160,\"maxSerializedBytes\":32768},\"omitted\":{\"runs\":0,\"children\":0,\"byteLimitExceeded\":false},\"runs\":[{\"id\":\"78091d57-dc75-4429-a68d-5345f417bc04\",\"kind\":\"workflow\",\"label\":\"workflow\",\"state\":\"queued\",\"startedAt\":1790778414945,\"updatedAt\":1790778414945}]}"]}
```

Terminal (last update; note `endedAt` + child node, and that `label` became the agent name
`worker` once the run resolved — during `queued` it was the literal `"workflow"`):

```json
{"type":"extension_ui_request","id":"172f54b5-d54a-4804-b955-2b9a2ce4b57e","method":"setWidget","widgetKey":"subagent-async","widgetLines":["PI_SUBAGENT_ASYNC_JSON:{\"kind\":\"pi-subagents.async-status-snapshot\",\"version\":1,\"generatedAt\":1790778433613,\"caps\":{\"maxRuns\":20,\"maxChildrenPerNode\":8,\"maxDepth\":3,\"maxStringLength\":160,\"maxSerializedBytes\":32768},\"omitted\":{\"runs\":0,\"children\":0,\"byteLimitExceeded\":false},\"runs\":[{\"id\":\"78091d57-dc75-4429-a68d-5345f417bc04\",\"kind\":\"workflow\",\"label\":\"worker\",\"state\":\"complete\",\"startedAt\":1790778414943,\"updatedAt\":1790778423625,\"endedAt\":1790778423625,\"children\":[{\"id\":\"run\",\"kind\":\"step\",\"label\":\"run\",\"state\":\"complete\",\"startedAt\":1790778414978,\"updatedAt\":1790778423618,\"endedAt\":1790778423618}]}]}"]}
```

## Picot host → webview cross-check (Plan Task 0 Step 3)

**Evidence level: static code path + byte-level JS check. NOT captured from a live Picot
runtime** — see "Why not live" below.

Chain, with the one question that matters (does an absent `widgetLines` become `null` in
transit?):

1. **Rust host, pi stdout → event bus.** `PiRpcBridge` parses each pi stdout line into
   `serde_json::Value` (`src-tauri/src/pi_rpc_bridge.rs:19,380`). The pump takes the frame as
   `Value` and forwards it unchanged: `coordinator.emit_event(&target, event)`
   (`src-tauri/src/native_pi_manager.rs:544-556`), and `emit_event` stores it verbatim
   (`src-tauri/src/runtime_coordinator.rs:255-268`). No field is reconstructed or defaulted.
   `NativeRuntimeEvent.event` is that `Value` (`src-tauri/src/native_pi_manager.rs:199-206`).
2. **Rust host → WS.** `runtime_event_frame` wraps it as
   `json!({"type":"runtime_event","target":…,"sequence":…,"event": event.event})`
   (`src-tauri/src/host_server.rs:2011-2018`) and the subscriber loop writes that
   (`src-tauri/src/host_server.rs:1983`). `serde_json::Value::Object` serialization emits only
   the keys the object actually has, so **an absent `widgetLines` stays absent — no `null` is
   introduced.** `grep -rn "widgetLines" src-tauri/src/` → **0 hits**: the host never touches
   that key. (The blocking-dialog owner filter
   (`src-tauri/src/host_server.rs:2034-2044`) covers `select|confirm|input|editor` only;
   `setWidget` is an ordinary broadcast event, and the existing host test at
   `src-tauri/src/host_server.rs:7221-7234` asserts a `setWidget` frame reaches a
   cross-workspace subscriber unmodified.)
3. **Webview.** `JSON.parse(event.data)` (`public/app/websocket-client.js:140`), dispatched
   verbatim as `runtimeEvent` detail (`public/app/websocket-client.js:696-698`), then
   `handleRPCEvent({...frame.event, __target, __sequence})` (`public/app.js:2828-2839`) →
   `handleBackgroundRPCEvent` → `widgetMirrorRegistry.handleWidgetRequest(event, runtimeId)`
   (`public/app.js:3088-3095`). Spread of an object with an absent key cannot invent one.

Check actually run against the two fixture files (mirrors steps 2-3, including the
`{...frame.event}` spread):

```text
set-widget-delete.json | 'widgetLines' in event: false | event.widgetLines === undefined: true | event.widgetLines === null: false
set-widget-update.json | 'widgetLines' in event: true  | event.widgetLines === undefined: false | event.widgetLines === null: false
```

→ The registry receives **field-absent** on delete and **`string[]` of length 1** on update,
i.e. identical to the direct RPC capture. `=== undefined` in the registry's
`#removePanel` branch holds; the "defined but not `string[]`" clear branch is *not* what a
delete frame hits. Had the host produced `null` instead, a delete would take the bad-frame clear
branch instead of `#removePanel` — same visible outcome (panel hidden), different code path.
Recorded here so Task 1 does not have to guess.

**Why not live:** there is a live Picot instance on this machine
(`/Applications/Picot.app/Contents/MacOS/picot`, PID 27911, WS on 127.0.0.1:49747), but it runs
the **shipped app bundle**, whose frontend is not this working tree's `public/app.js` — a
temporary log in `public/app.js:3088-3093` would never be exercised. The 76 GB `src-tauri/target`
is warm, but `bun run dev` also re-runs the `fetch:*` chain, and even then the async run must be
typed by hand into the dev window; driving a prompt into the live app's runtime would inject a
turn into Dr. Lin's active workspace session. Rotating a real Pi→host→WS capture with the
existing Rust `native_smoke_host_origin_p3` harness is the follow-up if live evidence is
required (`scripts/smoke-host-origin-p3.mjs`; it writes an evidence doc, so run the underlying
`cargo test` directly to avoid a repo diff).

## Reconciliation with the spec (§数据契约与降级)

**No conflict.** Point by point:

| Spec assertion | Captured reality |
| --- | --- |
| `widgetLines` is exactly one line, prefix `PI_SUBAGENT_ASYNC_JSON:` | ✅ all 17 update frames: array length 1, prefix exact |
| Only `widgetKey === "subagent-async"` is parsed | ✅ key as expected |
| JSON non-array object, `kind`, `version === 1`, `runs` array | ✅ |
| Picot's own 32 KiB UTF-8 pre-parse limit | ✅ sender cap `maxSerializedBytes: 32768` agrees |
| `widgetLines === undefined` is a delete signal, sent when no tasks | ✅ 3 delete frames, field-absent, after the job set emptied (and one initial clear) |
| Optional fields type-checked per field | ✅ consistent — `endedAt`/`children` appear only when applicable |
| Line count / prefix / oversize / bad JSON → clear+hide, no raw JSON fallback | consistent (bad-frame cases not produced by a healthy sender; covered by constructed variants in Task 2) |

Divergences that are **not** conflicts, worth carrying into Tasks 1-2:

- `widgetPlacement` never appears — the panel must not depend on it (spec only relies on the
  default `aboveEditor`).
- `activity` was absent in every frame of this capture. Code that reads `run.activity?.state`
  never runs here; `needs_attention` badges therefore cannot be observed from this capture
  (Task 2 covers them with constructed variants).
- `runs[].label` was the literal `"workflow"` while the run was `queued`, and the agent name
  (`"worker"`) once it resolved. The sender's label is not stable across a run's lifetime;
  the spec's "use the provided label, never derive from `id`" still holds.
- `runs: []` with `omitted.runs > 0` was never produced (the sender deletes the widget instead),
  so the "N 个后台任务 · 详情不可用" path stays constructed-variant-only for this version.
