# AnyDoc Native Office Preview Design

**Date:** 2026-09-17  
**Status:** Implemented — 2026-09-22（macOS 侧完成；Windows release 体积差与双平台手动门禁待 Dr. Lin 在 Windows 机器补测）  

实施记录：`anydoc = "=0.2.4"`（MIT）+ `anydoc_preview.rs`（封闭错误码/十后缀候选门/2MiB 输出上限）+ `host_files::read_with_cap`（普通 8MiB 不动，候选 32MiB）+ `host_server` 双 permit 信号量与 PreviewScope 三点重校验 + `file_read` 分支（ready 只读 Markdown / conversionFailed / fail-closed PDF）+ 前端 loading-neutral 打开、trusted `renderAs:"markdown"` 优先级、栅格 data-URI 图片策略（DOMParser 化解析管线）+ MarkItDown 运行时/测试/fixture/locale 全清（cleanup 测试守零）+ `extensions/fixtures/anydoc/` 十格式 fixture（全部取自 firecrawl/anydoc MIT 测试语料，checksum 见 README）。依赖树审计 `cargo tree -p anydoc -e all` 已记录。**macOS release 体积差：+5,655,232 bytes（+24.5%，23,091,536 → 28,746,768；LTO+strip 后）——anydoc 0.2.4 无 feature 分区，全部 14 格式解析器静态链入，属预期。** 偏差：permit 并发上界的确定性路由级测试改为「构造保证 + scope 失效中途测试」（真实 anydoc 转换毫秒级完成，无法确定性占满 permit；以 begin→prepare→commit 转场测试覆盖重校验窗口）。extensions/file-routes.ts 兼容 HTTP 分类器保留其独立 office 列表（不在 v2 预览面，spec 改动图未含）。  
**Scope:** Restore native-runtime Office-file preview, replacing the abandoned MarkItDown integration with the embedded `anydoc` Rust crate.

## 1. Goal

Picot's pre-native preview flow converted selected Office files to sanitized,
read-only Markdown. The native-runtime migration removed that runtime path:
`file_read` now decodes every file as UTF-8 and returns `binary_file` for Office
documents, while the WebView still contains an unfulfilled `previewStatus`
consumer.

This change restores the capability through the authoritative native data plane.
It embeds Firecrawl's MIT-licensed `anydoc` Rust crate in the Tauri host. It
does not invoke Python, MarkItDown, Pi Bridge, a CLI, a service, or an OCR
model.

## 2. Decisions

| Decision | Chosen contract |
| --- | --- |
| Regression boundary | This repairs the Office-preview capability lost in the native-runtime migration. It does not recreate the retired embedded-server architecture. |
| Converter | Rust crate `anydoc`, pinned to an exact reviewed 0.2.x release. The evaluated release, 0.2.4, requires Rust 1.88; Picot's local toolchain is Rust 1.98. |
| Network/OCR | Never use AnyDoc hosted OCR, API keys, or any network path. PDF stays on the existing PDF preview route and is never sent to AnyDoc. |
| Office formats | Exactly `doc`, `docx`, `rtf`, `odt`, `ppt`, `pptx`, `odp`, `xls`, `xlsx`, and `ods`. Every format needs a locally committed, license-reviewed real fixture before implementation can claim it is supported. Exclude EML, MSG, macro/slide variants, EPUB, CSV, and PDF. CSV remains editable text. |
| Data path | Extend the existing v2 `file_read` operation; do not add `document_convert` and do not route through Pi. |
| Candidate gate and detection | Only a request whose filename has one of the ten candidate suffixes enters the Office branch. Inside that branch, `anydoc::Format::from_bytes` wins; the candidate suffix is its fallback. The resolved format must still be one of the strict Office formats. |
| Mislabeled PDF | A `.pdf` filename continues to select the existing PDF renderer. A candidate Office filename whose bytes detect as PDF fails closed as `conversionFailed`: it neither reaches AnyDoc conversion nor reroutes to the PDF raw route. |
| Input limits | Ordinary `host_files::read` stays capped at 8 MiB. Only a candidate Office read may use a dedicated 32 MiB cap. |
| Output limit | Converted Markdown is capped at **2 MiB of UTF-8 bytes**. This is deliberately far below the 16 MiB WebSocket response cap even in JSON's worst-case control-character escaping. An output overrun becomes a generic conversion failure. |
| Concurrency | `HostState` owns a process-wide `Arc<tokio::sync::Semaphore>` with **two** permits. A request waits with `acquire_owned().await`; only holders enter `spawn_blocking`. Raising this limit requires a separate macOS and Windows peak-RSS benchmark with two through ten concurrent 32 MiB inputs. |
| Authority | Capture the authorized `(owner, workspace_id, generation)` at admission; revalidate it after permit acquisition and again before emitting a response. A stale generation returns `unauthorized_target`, never document content. |
| Cancellation | In-process AnyDoc conversion has no hard cancellation or timeout. A browser abort only causes the WebView to ignore the response; it never releases a running conversion's permit or claims the parser stopped. The blocking closure owns its permit until parsing exits. Hard cancellation/timeout would require a killable isolated process and is out of scope. |
| Failure UX | The adapter exposes a closed, detail-free error code. Browser output is always generic `conversionFailed`; host logging records only that fixed code. No AnyDoc detail, package part, page list, path, or bytes reaches the WebView or logs. |
| Result rendering | Successful conversion is read-only Markdown through the existing converted-document sanitizer. It permits only base64 `data:image/png`, `jpeg/jpg`, `gif`, and `webp`, and replaces every other image source with localized text. |
| Cleanup | Remove all MarkItDown runtime code, tests, E2E harness, fixtures, Python/CLI installation guidance, and active locale/test references. Move only reusable Office fixtures to `extensions/fixtures/anydoc/`; delete the MSG fixture. |

## 3. Migration Evidence

The verified pre-native reference is local upstream commit
`c4c3844f069fb6a8535b96f6daeff6ecba36bd5f`
(`feat: add Markitdown preview service and model health check`), not
`a363863^`.

At that commit:

```text
src-tauri/src/host_data.rs:532-572
  HostDataPlane::read_convertible_file
    → src-tauri/src/host_server.rs:505-568
      read_file_content
        → state.markitdown.convert
          → { previewStatus, renderAs: "markdown", editable: false }

src-tauri/src/markitdown_preview.rs:9-13
  INPUT_BYTE_CAP = 32 MiB
  OUTPUT_BYTE_CAP = 2 MiB
  MAX_CONCURRENCY = 2
```

The current native host has only `host_server.rs` `file_read`, which reads via
`host_files::read` and rejects non-UTF-8 bytes. The migration therefore lost
an operation branch, not a frontend rendering feature. The new implementation
restores the same one-request preview shape through the current v2 WebSocket
operation rather than reviving the old HTTP route or Python subprocess.

## 4. Architecture

### 4.1 Request, authority, and conversion flow

```text
WebView FilePreviewPanel
  → transport.fileRead(workspace-relative path)
  → v2 data_request { operation: "file_read" }
  → current_registered_context authorizes and captures owner/wid/generation
  → existing workspace root + workspace-relative request path
  → suffix is in the ten-item Office candidate allowlist?
      ├─ no  → existing host_files::read(root, path), 8 MiB, UTF-8 text path
      └─ yes → revalidate owner/wid/generation
                → acquire_owned().await shared semaphore
                → revalidate owner/wid/generation
                → spawn_blocking (permit moved into closure)
                    → host_files::read_with_cap(root, path, 32 MiB)
                    → Format::from_bytes(bytes), candidate suffix fallback
                    → strict Office format?
                        ├─ no / PDF / error → conversionFailed
                        └─ yes → anydoc::to_markdown_bytes(bytes, format)
                                  → reject output > 2 MiB UTF-8
                                  → drop Markdown and input bytes on failure
                → revalidate owner/wid/generation
                → ready Markdown response
  → data_response
  → existing Markdown renderer in converted-document mode
```

The candidate suffix gates the 32 MiB branch. Content detection determines the
parser **only after** that gate. This does not scan arbitrary `.bin` files,
does not change the 8 MiB generic read limit, and does not make a non-Office
AnyDoc format previewable merely because its bytes are recognizable.

### 4.2 Authority across long work

The request dispatch already proves the current desktop context at admission.
That proof cannot authorize an async wait or a completed conversion after a
workspace transition.

The Office branch must capture a private `PreviewScope` from the admitted
`HostClientContext`:

```rust
struct PreviewScope {
    owner: OwnerId,
    workspace_id: String,
    generation: u64,
}
```

A single helper re-reads `WindowOwnerRegistry::owner_current_workspace(owner)`
and accepts only `OwnerWorkspaceSnapshot::Registered` with exactly the captured
workspace and generation. It runs:

1. before waiting for a permit, while no Office bytes have been read;
2. immediately after acquiring a permit and before `spawn_blocking`, still
   before `read_with_cap` starts;
3. after the blocking join and before serializing any result.

If any recheck fails, discard the result and return `unauthorized_target`. The
last check is mandatory even if the client aborted locally. Tests must block a
conversion, commit a workspace transition, release conversion, and prove no
old content is returned or mounted.

### 4.3 Host ownership, concurrency, and cancellation

`HostState` owns `Arc<Semaphore>::new(2)`. Every candidate request awaits
`acquire_owned()` **before** `host_files::read_with_cap` or format detection.
The third request waits without reading or retaining Office bytes and must not
call `spawn_blocking` until a holder finishes. The owned permit moves into the
blocking closure, which owns the full read → detect → convert resource unit;
it drops only after all input, parser, and Markdown buffers have left scope. A
caller must not release it on a WebView abort, an outer wait cancellation, or
an authorization failure observed while the closure is already running.

AnyDoc parses in memory. At most two candidate requests may hold raw input,
perform format detection, or parse at once. Their raw inputs are each capped at
32 MiB, but even their combined 64 MiB raw input is **not a memory ceiling**:
parsers may retain raw bytes, decompressed archive entries, document
structures, assets, and Markdown. Queued requests hold no Office input bytes.

AnyDoc 0.2.4 has documented internal `ResourceLimit` guards, including 128 MiB
per decompressed archive entry, 512 MiB total decompressed archive bytes,
2,000,000 XML nodes per part, 4,000,000 spreadsheet grid slots, and 128 MiB
retained assets. These are converter safety guards, not Picot memory budgeting,
process isolation, cancellation, or hard timeout guarantees. Picot must not
claim otherwise.

`spawn_blocking` cannot forcibly stop a running parser. The v2 `file_read`
protocol has no server cancellation frame, so an `AbortController` cancels only
the WebView's pending promise. The service may discard a stale result after the
final authority check, but it must wait for the closure to exit before its
permit becomes available. If product requirements later need hard timeout or
hard cancellation, this in-process design must be replaced by a killable,
resource-limited worker process.

### 4.4 Containment and read caps

`host_files` remains the sole owner of path validation, canonicalization,
symlink containment, regular-file checks, growth-bounded reads, and modified
time collection.

Add a cap-parameterized helper with the same semantics as current
`host_files::read`:

```rust
pub fn read_with_cap(
    root: &Path,
    relative: &str,
    max_bytes: u64,
) -> Result<FileContent, FileError>;

pub fn read(root: &Path, relative: &str) -> Result<FileContent, FileError> {
    read_with_cap(root, relative, MAX_FILE_BYTES)
}
```

The helper retains the bounded `take(max_bytes + 1)` read after metadata
inspection, so a file that grows after `stat` cannot bypass the selected cap.
No Office-specific resolver, direct `std::fs::read`, filepath handoff to
AnyDoc, or duplicated containment check is permitted.

### 4.5 AnyDoc adapter boundary and de-sensitized errors

Add `src-tauri/src/anydoc_preview.rs`. It owns the strict candidate list,
format resolution, strict resolved-format validation, output size check, and
conversion normalization. It accepts authorized bytes from `host_files`, never
a filesystem path.

The adapter must not expose `anydoc::ConvertError` outside its module. It maps
all failures into its own closed enum, for example:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreviewErrorCode {
    Unsupported,
    Malformed,
    Encrypted,
    ResourceLimit,
    MissingPart,
    OutputTooLarge,
    Internal,
}

enum PreviewOutcome {
    Ready(String),
    Failed(PreviewErrorCode),
}
```

`NeedsOcr` maps to `Unsupported` because PDF is excluded. `Io` maps to
`Internal`. `anydoc::ConvertError` is marked `#[non_exhaustive]`, so an
external crate cannot legally omit a compatibility wildcard in a `match`.
That wildcard must map only to the fixed `Internal` code; it must not inspect,
format, log, or serialize the source error. The exact AnyDoc version is pinned,
and a dependency-upgrade review plus a contract test of every known error code
is required before accepting a new version. The host may log the fixed
`PreviewErrorCode` string only. `Display`, `ConvertError::code()`, part names,
limits, page lists, error detail, source paths, and bytes are not returned to
the browser and are not host-log fields.

Before `Ready(markdown)` leaves the adapter, check
`markdown.as_bytes().len() <= 2 * 1024 * 1024`. Larger results become
`Failed(OutputTooLarge)`. The ordinary outbound `PayloadKind::Response`
validation remains the final protocol defense; an adapter output cap does not
replace it.

### 4.6 Wire contract

The existing `file_read` success response gains an optional converted-preview
shape:

```json
{
  "type": "data_response",
  "requestId": "…",
  "operation": "file_read",
  "path": "reports/quarterly.docx",
  "content": "# Quarterly report\n…",
  "mtimeMs": 1750000000000,
  "isBinary": false,
  "truncated": false,
  "editable": false,
  "previewStatus": "ready",
  "renderAs": "markdown"
}
```

For a candidate file exceeding the Office input cap, detecting as PDF or a
non-Office format, exceeding the Markdown output cap, or producing any adapter
failure, return the established successful transport shape:

```json
{
  "previewStatus": "conversionFailed",
  "editable": false
}
```

Before conversion has started or after it has finished, an authority recheck
failure returns `unauthorized_target`; it must not be converted into
`conversionFailed` or contain document fields. Existing errors for invalid,
outside-workspace, missing, directory, and host-I/O paths remain unchanged.

### 4.7 Loading-neutral WebView state, renderer priority, and image behavior

The browser no longer maintains an Office suffix allowlist or a `convertible`
classification. The host owns the only candidate list and returns normalized
preview fields. Therefore a newly opened file tab is **loading-neutral** until
`fileRead` settles: it has `loading: true`, no edit mode, no mounted CodeMirror
editor, no editor toolbar, and no edit affordance. Filename classification must
not open editing UI while content and host editability are unknown.

`openFile()` creates a loading tab with `mode: "preview"`; it does not call
`_openToolbarForEditorTab`. `_mountRenderer()` continues to mount only the
loading presentation while `tab.loading` is true. When the response settles,
then—and only then—the panel selects the final state:

- `previewStatus: "ready"`: explicit read-only converted Markdown;
- ordinary `editable: true` text/Markdown/HTML: existing classified editor
  behavior, including the toolbar;
- PDF/image: existing classified preview behavior;
- binary or conversion failure: the existing generic error presentation.

The ready branch runs before binary/text fallback and explicitly sets
`content`, `originalContent`, `renderAs: "markdown"`, `editable: false`,
`mode: "preview"`, `isBinary: false`, and `truncated: false`. It retains the
existing load-token and `AbortController` race behavior.

`_isConversionTab()` and its call sites are deleted. Switching away from a tab
uses the generic predicate `tab.loading` to call `_abortTabLoad`; any in-flight
file request may be aborted, not only a guessed Office request. This preserves
stale-load cancellation after the browser-side candidate list is removed.

`createFileRenderer()` chooses in this exact order:

1. known trusted host directive `renderAs === "markdown"` → read-only,
   converted-document Markdown renderer;
2. filename classification → existing Markdown, HTML, image, PDF, or text
   renderer;
3. existing binary/text fallback.

Any unknown `renderAs` value is ignored and falls through to classification.

Converted-document image acceptance is a single shared raster predicate,
matching the message renderer:

```text
^data:image/(png|jpe?g|gif|webp);base64,
```

It is case-insensitive after trimming leading/trailing whitespace. SVG,
unknown image types, non-base64 data URIs, protocol-relative URLs, remote URLs,
root-relative URLs, and relative URLs are replaced with the localized text at:

```text
files.preview.converted.remoteImageHidden
```

All four locale JSON files define this key. Active code, tests, and locale
files must have zero `markitdown` occurrences after cleanup; superseded
historical design/plan documents are excluded from that mechanical check.

## 5. File Change Map

| File | Action | Responsibility |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | Modify | Add exact reviewed AnyDoc dependency. |
| `src-tauri/src/main.rs` | Modify | Register the native preview module. |
| `src-tauri/src/anydoc_preview.rs` | Create | Candidate list, format selection, closed error mapping, 2 MiB output cap, and converter tests. |
| `src-tauri/src/host_files.rs` | Modify | Add `read_with_cap`; preserve `read` as 8 MiB wrapper and preserve all containment behavior. |
| `src-tauri/src/host_server.rs` | Modify | Add two-permit semaphore to `HostState`; capture/recheck preview scope; branch `file_read`; await and move permits into blocking work; return normalized responses. |
| `public/app/transport.js` | Preserve | Continue using `fileRead`; no new transport method or data operation. |
| `public/file-language.js` | Modify | Remove Office convertible suffix mirror/classification and its tests; leave ordinary filename classifications intact. |
| `public/file-preview-panel.js` | Modify | Add loading-neutral tabs; consume ready converted responses; replace `_isConversionTab()` with generic loading-tab cancellation; set all read-only renderer state explicitly. |
| `public/file-preview-renderers.js` | Modify | Delete `case "convertible"`; implement trusted-directive → classification → fallback priority. |
| `public/file-preview-markdown.js` | Modify | Use raster-only converted-image predicate and neutral locale key. |
| `public/locales/{en,zh,es,ja}.json` | Modify | Remove MarkItDown/Python install copy; add neutral converted-image copy. |
| `public/*preview*.test.js`, `public/file-language.test.js` | Modify | Cover response state, renderer priority, unknown directive fallback, raster-only image rules, and removal of browser Office classification. |
| `extensions/fixtures/anydoc/` | Create | Hold ten minimal real Office fixtures, each with provenance and license documentation. Reuse eligible current `docx`, `pptx`, `xls`, and `xlsx` only after licensing review; source the other six. |
| `extensions/fixtures/markitdown/` | Delete | Remove old directory after eligible Office fixtures move; do not retain `sample.msg`. |
| `extensions/markitdown-preview.ts` | Delete | Retire unused Python subprocess integration. |
| `extensions/markitdown-preview.test.ts` | Delete | Retire MarkItDown-only tests. |
| `extensions/markitdown-preview.e2e.test.ts` | Delete | Retire Python E2E harness. |
| `docs/superpowers/specs/superseded/2026-07-26-markitdown-office-email-preview-design.md` | Modify | Mark superseded and link here; do not leave it as active guidance. |
| `docs/superpowers/plans/2026-07-26-markitdown-office-email-preview.md` | Modify | Mark superseded; do not execute it. |
| `ARCHITECTURE.md` | Modify | Document host-side AnyDoc boundary, 8/32 MiB input split, 2 MiB output cap, two-permit limit, generation recheck, no-cancellation limitation, no-network/OCR rule, and raster image policy. |

## 6. Validation Contract

### 6.1 Unit and integration coverage

- `host_files` proves `read_with_cap` preserves invalid-path, containment,
  symlink, directory, static-size, and growth-after-stat rejection; only the
  explicit cap varies.
- Adapter tests prove candidate gating, content-first resolution, extension
  fallback, strict rejection of PDF/CSV/non-Office detected formats, every
  closed error mapping, no leaked AnyDoc detail, and an input whose conversion
  output exceeds 2 MiB.
- `file_read` tests prove:
  - success returns exactly `previewStatus: "ready"`, `renderAs: "markdown"`,
    `editable: false`, `isBinary: false`, and `truncated: false`;
  - input/output/format/converter errors become the generic safe failure;
  - ordinary text remains 8 MiB; candidates may read through 32 MiB only;
  - a `.docx` filename containing PDF bytes fails closed without AnyDoc/PDF
    rerouting;
  - with two controlled requests holding permits, a third candidate has not
    called `read_with_cap`, allocated Office input bytes, detected a format, or
    entered `spawn_blocking`; it begins only after a permit holder exits;
  - read, detection, and conversion failures each release their permit only
    after their closure drops large buffers;
  - a workspace transition while waiting rejects after permit acquisition but
    before disk read, and a transition during parsing rejects after completion
    without returning old content;
  - a local client abort does not release a running conversion permit early.
- Browser tests prove a slow Office response has no CodeMirror, editor toolbar,
  or edit mode; the explicit ready state has no edit flash; renderer priority
  covers ordinary Markdown, Office converted Markdown, and unknown `renderAs`;
  and ordinary image/PDF/text behavior is unchanged.
- Sanitizer tests accept only permitted raster base64 data URIs and reject SVG,
  unknown MIME, whitespace/malformed variants, remote/protocol-relative/root/
  relative sources.
- A cleanup test searches active code, tests, and locale files for zero
  `markitdown` occurrences. Historical superseded docs are intentionally not
  included.

### 6.2 Real conversion smoke tests and fixture policy

Each strict format has one minimal, real, locally committed fixture:

```text
doc, docx, rtf, odt, ppt, pptx, odp, xls, xlsx, ods
```

For every fixture, an in-process AnyDoc test asserts non-empty Markdown;
route-level tests assert the same fixture is returned as read-only converted
Markdown. Fixture provenance, source URL/version, license, checksum, and
purpose are recorded in `extensions/fixtures/anydoc/README.md`.

The existing XLS sample has no clear machine-readable upstream license marker.
It cannot move until a redistribution review accepts its provenance or it is
replaced by a fixture with an explicit compatible license.

### 6.3 Dependency and binary-surface audit

Before accepting the dependency update:

```bash
cd src-tauri && cargo tree -p anydoc -e all
```

Record the complete dependency edge tree, activated feature surface, and whether
any direct, build, development, or transitive crate requires a native/system
dependency. AnyDoc 0.2.4 exposes no Cargo feature partition for individual
format parsers, so all its parser implementations and their dependencies link
into Picot despite Picot's ten-format runtime gate. Produce release builds on
macOS and Windows and record binary-size deltas against the same baseline
commit. The release-profile results do not replace functional tests.

### 6.4 Commands and manual gates

Run, in order:

```bash
bun run check:rust
bun run vitest run public/file-preview-panel.test.js public/file-preview-renderers.test.js public/file-preview-markdown.test.js public/file-language.test.js
bun run test
bun run check
```

On macOS and Windows native runtime builds, manually verify:

1. a small `.docx` opens as read-only Markdown;
2. ordinary text remains on the 8 MiB editable path;
3. a failed Office conversion exposes only generic cannot-preview UI;
4. remote images do not request the network and permitted raster data images
   remain visible;
5. two long conversions occupy permits and the third waits rather than starting
   parser work; closing the third tab does not cancel either running parser;
6. switching workspace during a long conversion never mounts the old
   workspace's Markdown.

## 7. Out of Scope

- OCR, Firecrawl Parse, credentials, hosted conversion, or any network path;
- PDF conversion/rerouting or changes to the existing PDF renderer;
- EML, MSG, MBOX, EPUB, CSV, macro formats, presentation variants, and new
  Office suffixes;
- editing converted Markdown, writing it back, result caching, or embedding
  extracted asset bytes in the browser;
- Python, MarkItDown, CLI probing, installation instructions, or a fallback
  converter;
- arbitrary-binary content scanning, a new HTTP route/data op, or Pi Bridge;
- hard timeout, hard cancellation, process isolation, or a hard process-memory
  limit for in-process conversion.

## 8. Completion Gate

The design may return to Approved only after this review's required changes are
accepted. The implementation is complete only when:

1. all ten locally licensed fixtures convert and render through the native
   `file_read` path as read-only sanitized Markdown;
2. active MarkItDown code, tests, fixtures, and locale guidance are removed;
3. input/output limits, strict error de-sensitization, PDF fail-closed
   behavior, generation rechecks, and browser-abort limitation are tested;
4. at most two candidate Office requests may hold input bytes or execute file
   reading, format detection, or conversion; queued candidates have not read
   their file content;
5. dependency tree and macOS/Windows release binary-size deltas are recorded;
6. `ARCHITECTURE.md` documents the final boundary;
7. all commands and both platform manual gates pass; and
8. the final diff is reviewed for accidental changes to unrelated current
   working-tree work.

