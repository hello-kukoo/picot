# pi-web-access Settings Design

**Status:** Implemented 2026-09-21 per the recommendation column (Dr. Lin goal
directive); spec tracks code. Implementation notes: ① 非 secret 文本键仅做类型校验（bool），URL 格式校验留待包级反馈；② 路由块（searchRouting/fetchRouting 有序列表）v1 未渲染为可编辑 UI，仅经高级途径读写；③ env 徽章按键名推导 env 变量名。
**Date:** 2026-09-16
**Corrections (2026-09-21 review):** ① 端点凭证键名原先写成 `searxng.password` / `crawl4ai.token` / `brightdata.key` 等嵌套名，包根本不读；已按包的扁平键名改正。SearxNG 头映射 `searxngHeaders` 是 `Record<string, string>`，没有单字符串行，v1 不渲染。② 配置目录解析漏了两条包级规则（legacy `~/.pi/web-search.json`、XDG 未设置时不看 `~/.config/pi`），会让 GUI 写到的文件与运行时读的不是同一个；已逐条对齐 `getWebSearchConfigDir`。③ `fetch.answerProvider` / `fetch.answerModel` 原先不在可写键列表里，行内保存必然报错；现已可写，并按包的「必须成对」规则校验。④ set 新增 `entries` 批量，成对字段一次写入。
**Date:** 2026-09-16
**Provenance:** roll-out entry #12 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec. Highest-risk entry — the config file is
a **credential store**. **Transport: stays on the bridge** —
the answer-model picker needs the in-process modelRegistry (advisor's
rationale verbatim). **Landing: available** (Dr. Lin, 2026-09-20): on the
landing page the section rides the bridge-service config runtime
([`2026-09-18-landing-bridge-runtime-design.md`](2026-09-18-landing-bridge-runtime-design.md) —
its host loads picot-config, which dispatches these ops), same config file
and masked ops as the workspace path, global-only; the earlier "host-ize
the non-model subset" alternative is moot (no transport split arises).
Secret discipline unchanged — masked get applies at landing too; the
「重启 Picot 后生效」 hint holds (the first workspace runtime spawned on
entering a project reads the fresh file).

## Goal

A settings section for `npm:pi-web-access`: provider API keys, proxy, search
and fetch routing, and the answer model — with secrets discipline stronger
than the package's own defaults.

## Research findings (source-verified, v0.29.0)

- Config dir resolution (`utils.ts getWebSearchConfigDir`, re-read at
  pi-web-access 0.30.0): `PI_CODING_AGENT_DIR` 优先；设置 `XDG_CONFIG_HOME`
  时按 `$XDG_CONFIG_HOME/pi/web-search.json`（存在）→ legacy
  `~/.pi/web-search.json`（存在）→ 以 XDG 目录作为新配置写入目标；未设置
  `XDG_CONFIG_HOME` 时按 `~/.pi/agent/web-search.json`（存在）→ legacy
  `~/.pi/web-search.json`（存在）→ 以 agent 目录作为新配置写入目标。文件名
  一律 `web-search.json`。**GUI 必须走同一条链**：写到别的路径时保存会静默
  不生效，并在 legacy 文件存在时把运行时仍在用的那份遮蔽掉。
- **The file is a credential store** — the package's own comment: "its own
  text is the secret" (their JSON parse errors deliberately avoid quoting
  file text back). Consequence for Picot: the get op must never return full
  key material to the WebView.
- Writable keys verified in source:
  - Provider keys (~18): `openaiApiKey, braveApiKey, exaApiKey,
    tinyfishApiKey, search1apiApiKey, searchinfinityApiKey, queritApiKey,
    jinaApiKey, bochaApiKey, perplexityApiKey, geminiApiKey, mistralApiKey,
    serpapiApiKey, xaiApiKey, valyuApiKey, anysearchApiKey, datalabApiKey,
    firecrawlApiKey` (+ per-provider baseUrls where present, e.g.
    `exaBaseUrl`).
  - Endpoint credentials（扁平键名，与上面同层）: `searxngBaseUrl`、
    `searxngHeaders`（`Record<string, string>`，v1 不渲染）、
    `crawl4aiBaseUrl`、`crawl4aiApiToken`、`brightdataApiKey`、
    `brightdataSerpZone`、`brightdataUnlockerZone`。
  - Non-secrets: `proxy` (URL), `openaiResponsesUrl`,
    `allowBrowserCookies` (bool; env `PI_ALLOW_BROWSER_COOKIES`),
    `image.enabled` (bool), `searchRouting` (`providers` ordered list,
    `useCurrentModel`, `fallbackOn[]`), `fetchRouting` (`providers`
    ordered list, `allowRemoteHostedProviders`), `fetch.answerProvider` /
    `fetch.answerModel`.
  - Advanced, NOT in v1: `authFetch` profiles, curator/local-curator
    network blocks.
- Env parallels exist per provider (`SERPAPI_KEY`, `SEARCH1API_KEY`,
  `XAI_API_KEY`,
  `MISTRAL_API_KEY`, `VALYU_API_KEY`, `ANYSEARCH_API_KEY`,
  `DATALAB_API_KEY`, …) — `hasCredentialSource` checks config > env; an env
  key present shows a badge, does not disable the row (config is still
  readable/writable, env merely also counts as configured — verify display
  semantics at implementation).
- Loader tolerates unknown keys (preserve-unknowns, advisor semantics).
- **Effect timing**: config is cached per module at first use
  (`let cachedConfig` per provider file) → Pi process restart is the
  guaranteed apply; hint 「重启 Picot 后生效」.

## Open decisions (awaiting grilling)

| Branch | Recommendation |
| --- | --- |
| Secret transport (D1) | get returns per-key `{ configured, preview }` where preview = last 4 chars only; **full keys never transit the bridge → WebView**. set takes `{ key, value }` write-through (the input field is the only place the full key exists, cleared after save). |
| Key row UX (D2) | Password-type input + 「已配置 ····abcd」 status; save-on-change writes only when non-empty; explicit 「清除」 button per key (never accidental — clearing is a two-click confirm on populated rows). |
| v1 field scope (D3) | Keys + endpoint credentials + proxy + openaiResponsesUrl + answer model + routing blocks + image/browser-cookie toggles. `authFetch` profiles and curator blocks → 高级 JSON editor or out of scope (grilling). |
| Invalid file (D4) | Read-only error state with the package's reason; **NO reset button** — unlike fff, "reset" here destroys every stored credential; the user fixes by hand. |
| Secret file hygiene (D5) | tmp+rename atomic write with 0600 (stricter than the package, which does not chmod); the write path must never log key material (bridge logs are owner-readable but hygiene is cheap). |

## Contract

### Bridge ops — added to `extensions/extension-settings.ts`

- `webaccess.config.get` → `{ fields: Record<key, { configured, preview? }>,
  nonSecrets, routing, envKeyed: string[], invalid?: { reason } }`.
- `webaccess.config.set` → `{ key, value | null }` single-key write-through,
  or `{ entries: [{ key, value }, …] }` for a batch (null clears, gated by
  confirm semantics client-side); preserve-unknowns; atomic write, 0600;
  non-secret keys validated by type (URL, bool, enum lists). `entries` exists
  for paired fields: `fetch.answerProvider` + `fetch.answerModel` land in one
  write, and a write that would leave only one half is rejected (the package
  throws on such a file).

### Renderer

- Groups: ① 搜索 providers keys ② 抽取 providers keys + endpoints ③ 代理与
  端点 ④ 答复模型 (model picker, advisor machinery) ⑤ 路由 (ordered
  provider lists with up/down + fallbackOn checkboxes) ⑥ 开关
  (image/browser cookies). Hint 「重启 Picot 后生效」.

### i18n

`settings.extensionWebAccess.*` in en/zh/ja/es (~45 keys: group titles,
~20 provider labels, endpoint labels, routing labels, confirm strings, hint,
saved/saveFailed).

## Verification

- Op tests (`extensions/extension-settings.test.ts`): 目录解析四级
  （explicit / XDG / legacy / agent）；masked get（payload 属性扫描里不出现
  完整 key）；整体键名与包一致（`crawl4ai.token` 之类必须被拒）；单键 set；
  clear；`entries` 成对写入与「只写一半」拒绝；URL/enum/bool 类型拒绝；
  未知键保留；0600；invalid 文件只读报错；env 徽章走显式映射。
- Renderer tests: masked rows render status not values; clear confirm flow;
  routing list edits produce ordered payloads; answer-model picker parity
  with advisor tests.
- Landing variant: section renders through the landing config gateway (the
  config-runtime spec's lazy spawn); masked get and clear-confirm identical.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  extension-settings paragraph gains the secrets note.

## Out of scope

`authFetch` profile management (unless grilling pulls it in as advanced
JSON), curator configuration, cookie extraction UX, per-call tool parameter
overrides, Chrome profile management.
