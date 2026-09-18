# pi-web-access Settings Design

**Status:** Draft — awaiting Dr. Lin's grilling (open decisions below). Not implemented.
**Date:** 2026-09-16
**Provenance:** roll-out entry #12 of
[`2026-09-16-extension-settings-rollout-inventory.md`](2026-09-16-extension-settings-rollout-inventory.md);
renderer map per the advisor spec. Highest-risk entry — the config file is
a **credential store**. **Transport: stays on the bridge** —
the answer-model picker needs the in-process modelRegistry (advisor's
rationale verbatim); the section is workspace-only and landing-hidden.
Host-izing the non-model subset was considered and rejected: a section
split across two transports is worse than an honest landing-hidden page.

## Goal

A settings section for `npm:pi-web-access`: provider API keys, proxy, search
and fetch routing, and the answer model — with secrets discipline stronger
than the package's own defaults.

## Research findings (source-verified, v0.29.0)

- Config dir resolution (`utils.ts getWebSearchConfigDir`):
  `PI_CODING_AGENT_DIR` > `$XDG_CONFIG_HOME/pi/web-search.json` (only if the
  file exists there) > `~/.pi/agent`. File: `web-search.json`.
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
  - Endpoint credentials: `searxng` (endpoint + username + password),
    `crawl4ai` (baseUrl + token), `brightdata` (key + serpZone +
    unblocker zone).
  - Non-secrets: `proxy` (URL), `openaiResponsesUrl`,
    `allowBrowserCookies` (bool; env `PI_ALLOW_BROWSER_COOKIES`),
    `image.enabled` (bool), `searchRouting` (`providers` ordered list,
    `useCurrentModel`, `fallbackOn[]`), `fetchRouting` (`providers`
    ordered list, `allowRemoteHostedProviders`), `fetch.answerProvider` /
    `fetch.answerModel`.
  - Advanced, NOT in v1: `authFetch` profiles, curator/local-curator
    network blocks.
- Env parallels exist per provider (`SERPAPI_KEY`, `XAI_API_KEY`,
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
- `webaccess.config.set` → `{ key, value | null }` single-key write-through
  (null clears, gated by confirm semantics client-side); preserve-unknowns;
  atomic write, 0600; non-secret keys validated by type (URL, bool, enum
  lists).

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

- Op tests: three-tier dir resolution; masked get (no full key in payload —
  assert by property scan); single-key set; clear path; URL/enum rejects;
  unknown preserved; 0600; invalid-file read-only error.
- Renderer tests: masked rows render status not values; clear confirm flow;
  routing list edits produce ordered payloads; answer-model picker parity
  with advisor tests.
- `bun run check`, focused vitest, then `bun run test`; ARCHITECTURE.md
  extension-settings paragraph gains the secrets note.

## Out of scope

`authFetch` profile management (unless grilling pulls it in as advanced
JSON), curator configuration, cookie extraction UX, per-call tool parameter
overrides, Chrome profile management.
