# Picot MarkItDown Office and Email Preview Design

**Date:** 2026-07-26
**Revised:** 2026-07-28 — extend dependency discovery to recognize a standalone `markitdown` CLI installed via `uv tool` / `pipx` / `pip --user` (the only viable path on PEP 668 externally-managed Python), and revise installation guidance to be PEP-668-safe.
**Status:** Proposed — awaiting review
**Scope:** Convert selected workspace Office and email files to Markdown for read-only preview.

## 1. Goal

Allow Picot to preview selected Office and email files without embedding a browser document engine or increasing the application bundle substantially. The embedded server converts an approved local file with Microsoft MarkItDown and returns Markdown to Picot's existing sanitized Markdown preview path.

This is a preview feature only. It does not edit, save, download, attach to prompts, or upload source files. It does not add a new WebView vendor bundle, replace the existing PDF.js renderer, bundle Python, or call cloud/LLM services.

## 2. Confirmed Product Decisions

- The embedded server invokes MarkItDown as a direct, bounded subprocess.
- Python and MarkItDown are optional runtime dependencies. Picot detects them when a conversion preview is requested; it never installs or bundles them.
- Missing Python, Python older than 3.10, missing MarkItDown, incompatible MarkItDown, unsupported input, conversion failure, timeout, and resource-limit failures all leave the file in the existing non-previewable state. Dependency failures also display reason-specific local guidance.
- A successful conversion is rendered through Picot's existing Markdown sanitizer and Markdown renderer in a stricter converted-document mode, and is always read-only.
- Picot discovers MarkItDown through two strategies: interpreter-based (`python3`/`python`/`py -3` with `import markitdown`) and, as a fallback, a standalone `markitdown` CLI on `PATH` (the install footprint of `uv tool` / `pipx` / `pip --user`, and the only viable path on PEP 668 externally-managed Python). Either strategy yields a working conversion; the interpreter strategy is preferred because it also surfaces a Python version for diagnostics.
- MarkItDown is attempted for `DOC`, `DOCX`, `RTF`, `ODT`, `PPT`, `PPTX`, `ODP`, `XLS`, `XLSX`, `ODS`, `EML`, and `MSG`.
- `CSV` retains its existing editable-text behavior and is never sent to MarkItDown. `MBOX` is excluded and remains non-previewable.
- `DOCX`, `PPTX`, `XLSX`, `XLS`, and `MSG` are the stable conversion set. Every other listed suffix, including `EML` and `RTF`, is best-effort: Picot attempts conversion but does not claim native support. A non-zero exit or empty/whitespace-only result presents “cannot be previewed”; Picot does not attempt to judge the semantic quality of non-empty Markdown.
- PDF remains on the current PDF.js route. Existing CSV, other text, Markdown, image, and PDF behavior remains unchanged; EML and RTF intentionally change from the unknown-text fallback to read-only converted preview.

## 3. Architecture

The existing preview pipeline remains the authority:

```text
File tree click
  → FilePreviewPanel.openFile()
  → GET /api/files/content?path=…
  → workspace containment + canonical regular-file descriptor validation
  → bounded stream from that descriptor into MarkItDown subprocess stdin
  → { previewStatus: "ready", content, renderAs: "markdown", editable: false }
  → existing Markdown sanitizer and renderer
```

The server performs conversion in the same Pi process that already owns the HTTP routes. No Pi slash command, broker command, iframe, raw-file route expansion, or new endpoint is introduced.

A conversion is never cached in this slice. Reopening a tab runs a new conversion, avoiding stale output after an external file change and keeping conversion-memory ownership simple.

## 4. Module Boundaries

### 4.1 `extensions/markitdown-preview.ts` — new

This module owns only MarkItDown process integration:

- recognize the approved conversion suffixes;
- discover a compatible local Python interpreter and MarkItDown installation on macOS, Linux, and Windows;
- invoke the official MarkItDown module through `spawn`, never a shell, with a fixed argument shape equivalent to `python -m markitdown --extension .docx` and no filename argument; `spawn` is required so Picot can stream stdin and apply its own stdout/stderr byte limits rather than inheriting `execFile`'s hidden default `maxBuffer` limit;
- receive an already-open canonical file descriptor, reject its initial size above the input limit, and enforce the same byte cap again while piping it to subprocess stdin rather than passing a path that Python could reopen;
- rely on the official stdin path, which calls `convert_stream(sys.stdin.buffer, stream_info=StreamInfo(extension=…))`; the suffix comes only from the approved enum;
- enforce the input, stdout, stderr, elapsed-time, and per-server concurrency limits in §7;
- terminate timed-out, aborted, or output-overrun processes and normalize all failures into a small typed result.

It does not parse HTTP requests, resolve workspace paths, construct DOM, or persist cache entries. MarkItDown runs with plugins disabled and does not receive a local path, remote URL, cloud credential, or LLM configuration.

Interpreter discovery is platform-aware and uses fixed command candidates only. macOS/Linux probes `python3` then `python`; Windows probes the Python launcher `py.exe` with `-3` before `python.exe`. Discovery resolves the successful candidate to an absolute executable path, runs a constant version script to distinguish a missing interpreter from Python older than 3.10, then distinguishes a missing package from an incompatible installation by checking the importable `MarkItDown` and `StreamInfo` APIs and verifying that `python -m markitdown --help` exposes the stdin `--extension` option. Compatibility is capability-based rather than tied to an arbitrary package version. The resolved executable, launcher prefix arguments, and display command are cached per embedded-server process.

If no interpreter candidate exposes an importable MarkItDown, Picot falls back to discovering a standalone `markitdown` command on `PATH` (the install footprint of `uv tool`, `pipx`, and `pip --user` on externally-managed Python). This is the discovery path that succeeds when a user followed PEP 668 guidance and installed MarkItDown into an isolated environment rather than into the probed interpreter. Standalone-CLI discovery reads the command's first line, accepts only a single `#!` interpreter path that is absolute and `path.isAbsolute`, resolves it through `fs.realpath`, and then re-validates that interpreter with the same capability probes used for the interpreter candidates (version, `MarkItDown`/`StreamInfo` import, `--extension`/`-x` help, `sys.executable`). The standalone command is used only as a discovery bridge; conversion always runs the resolved absolute interpreter directly via `spawn`, so `py -3` launcher semantics are never re-injected. On Windows the standalone command is a `.exe`; Picot does not parse `~`-relative paths, CPython `-m` wrappers, or multi-argument shebangs. A standalone command that fails capability probing is treated as `markitdownMissing`/`markitdownIncompatible` exactly like an interpreter candidate, with the same diagnostic reason set.

The host user's installed Python and MarkItDown package are trusted optional runtime dependencies; browser and workspace input cannot select an executable or alter probe code. After discovery, child processes use the resolved interpreter and a minimal environment containing only required locale, home, temporary-directory, and Windows system variables. They do not inherit `PYTHONPATH`, `PYTHONSTARTUP`, `EXIFTOOL_PATH`, proxy variables, cloud/LLM credentials, `LD_*`, or `DYLD_*` variables.

### 4.2 `extensions/file-routes.ts` — modified

The file classification contract gains a read-only convertible-preview category. The server-owned allowlist is authoritative; `public/file-language.js` carries a frontend mirror, and a parity test must compare both exported lists so they cannot drift. `CSV` remains ordinary editable text. `MBOX` is an explicit deny-list entry that classifies as binary before the unknown-text fallback.

Workspace containment, canonical descriptor opening, regular-file checks, outside-workspace symlink rejection, and canonicalization of allowed in-workspace symlinks remain unchanged. The category authorizes an attempt to convert; it does not assert that MarkItDown supports or will successfully parse the file.

### 4.3 `extensions/embedded-server.ts` — modified

The existing `GET /api/files/content` route remains the only browser fetch path. After it resolves and validates a workspace file, it delegates a convertible-preview file to `markitdown-preview.ts`.

The route does not broaden `/api/files/raw`, does not reuse `scope=picker`, and does not create a path-taking converter endpoint.

### 4.4 `public/file-language.js` — modified

The frontend mirrors the server's convertible suffixes as a preview-only, non-editable content type and classifies `MBOX` as non-previewable. CSV remains editable text. The frontend exports its mirror for the server/frontend parity test.

### 4.5 `public/file-preview-panel.js` — modified

The panel consumes `previewStatus` before its ordinary binary/text fallback. A `ready` response with `renderAs: "markdown"` stores that transient rendering directive on the tab and mounts the existing Markdown renderer in converted-document mode. A `dependencyUnavailable` response uses `dependencyReason` to show localized guidance; `conversionFailed` uses the existing cannot-preview state. Convertible tabs start in preview mode and remain non-editable before, during, and after loading, so the Edit control never flashes into view.

The panel tracks an `AbortController` for each in-flight conversion fetch. It aborts that fetch when the tab closes, another tab supersedes it, the panel closes, or the workspace changes. An intentional abort clears the old tab's loading state without showing an error, leaves its content unset, and starts a fresh conversion if that tab is selected again.

### 4.6 `public/file-preview-renderers.js` — modified

The renderer factory delegates converted Markdown to the existing Markdown renderer with an explicit `convertedDocument: true` option. It does not add a new document renderer or bypass the Markdown sanitizer.

### 4.7 `public/file-preview-markdown.js` — modified

The sanitizer gains a converted-document mode. Existing Markdown files keep their current URL behavior. For converted documents, `data:image/*` remains allowed, but every remote or relative `img[src]` is replaced with localized “Remote image hidden” text before the fragment is mounted. Links remain inert until clicked and retain the existing safe-protocol checks. This prevents Office or email tracking images from generating automatic network requests.

### 4.8 Locales and tests — modified or added

Both locale files gain reason-specific dependency guidance, platform-correct installation commands, the remote-image placeholder, and only the fallback strings required by this feature. Tests cover conversion process behavior, suffix parity and classification, response mapping, Markdown dispatch, non-editability, remote-image blocking, and cancellation.

### 4.9 HTTP adapter cancellation — modified

Bun's Fetch adapter `AbortSignal` feeds the shared conversion cancellation signal directly. The Node path uses `req.aborted` and treats `res` closing before `res.writableEnded` as client cancellation; it must not use `req.on("close")` as a disconnect signal because a completed request can emit that event while its response is still pending. `markitdown-preview.ts` tracks each active child process, kills it when the shared signal aborts, and releases its concurrency slot exactly once. On Windows, termination uses the child PID and the absolute `%SystemRoot%\System32\taskkill.exe` path with a fixed `/pid <pid> /t /f` argument array as the escalation path; macOS/Linux use TERM followed by a bounded wait and KILL without shell commands. This preserves the adapter contract in `docs/engineering-lessons.md` and prevents stale tab loads from continuing to consume CPU.

## 5. File API Contract

`GET /api/files/content?path=…` retains its existing workspace-only path semantics. For a successful converted preview it returns HTTP 200 with `previewStatus: "ready"` and a rendering directive:

```json
{
  "path": "/workspace/report.docx",
  "content": "# Report\n\nConverted content…",
  "size": 18432,
  "mtimeMs": 1750000000000,
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "isBinary": false,
  "truncated": false,
  "editable": false,
  "previewStatus": "ready",
  "renderAs": "markdown"
}
```

For an unavailable conversion dependency, the route still returns HTTP 200 with `previewStatus: "dependencyUnavailable"` and one stable `dependencyReason`: `pythonMissing`, `pythonTooOld`, `markitdownMissing`, or `markitdownIncompatible`. The only diagnostic field permitted to reach the browser is a `pythonVersion` `major.minor.patch` string for `pythonTooOld`; it contains no converter stderr or other environment detail. A failed, timed-out, over-limit, busy, or unsupported conversion likewise returns HTTP 200 with `previewStatus: "conversionFailed"`. In both cases `editable` is false and `renderAs` is absent. The panel maps the four dependency reasons to localized guidance and maps every conversion failure to cannot-preview.

HTTP 4xx/5xx remains reserved for existing transport and file-boundary failures, including invalid paths, outside-workspace requests, missing files, and non-regular files. Process stderr, host paths, interpreter paths, and environment details are never returned to the browser.

No new endpoint is added. `/api/files/raw` remains limited to its current image/PDF use and continues to reject arbitrary binary files.

## 6. Runtime Dependency and Installation Guidance

MarkItDown requires Python 3.10 or later. Picot checks for an interpreter and a MarkItDown installation only when a convertible file is opened. It discovers a usable MarkItDown through either of two strategies (§4.1): an interpreter candidate (`python3`/`python`/`py -3`) with `import markitdown`, or a standalone `markitdown` CLI on `PATH`. When neither succeeds, the file remains non-previewable with reason-specific guidance.

Guidance distinguishes all four dependency reasons:

- `pythonMissing`: instruct the user to install Python 3.10 or newer from the platform's official distribution channel; no pip/uv/pipx command is shown.
- `pythonTooOld`: show only the detected Python `major.minor.patch` version (for example, `3.9.7`) and instruct the user to upgrade to Python 3.10 or newer; no filesystem path or other environment detail is returned.
- `markitdownMissing`: show a PEP 668-safe install command for the stable-format extras. On externally-managed Python (Homebrew, Debian/Ubuntu system Python, PEP 668 distros) a bare `pip install` is rejected, so guidance prefers isolated-environment installers. The install command is independent of which discovery strategy ultimately succeeded, because the user's job is to make MarkItDown importable or provide a standalone CLI — both forms satisfy discovery.
- `markitdownIncompatible`: use the same install command with an `upgrade`/`reinstall` verb and explain that Picot requires MarkItDown's stdin/extension conversion capability.

The install command covers DOCX, PPTX, XLSX/XLS, and MSG only. On macOS/Linux the primary recommendation is `uv tool install`, with `pipx install` as an alternative; on Windows the recommendation is `pipx install` with `uv tool install` as an alternative. Both install a standalone `markitdown` CLI that standalone-CLI discovery recognizes, and neither touches an externally-managed interpreter:

```shell
# macOS / Linux — preferred (uv)
uv tool install 'markitdown[docx,pptx,xlsx,xls,outlook]'
# macOS / Linux — alternative (pipx)
pipx install 'markitdown[docx,pptx,xlsx,xls,outlook]'

# Windows — preferred (pipx, available after `pipx ensurepath`)
pipx install "markitdown[docx,pptx,xlsx,xls,outlook]"
# Windows — alternative (uv)
uv tool install "markitdown[docx,pptx,xlsx,xls,outlook]"
```

For users who prefer to install into a specific interpreter (for example a `python3 -m venv` they already manage), guidance may also show the interpreter-direct form as a secondary option, because interpreter-based discovery recognizes it directly:

```shell
# interpreter-direct (only when the interpreter is NOT externally managed)
python3 -m pip install 'markitdown[docx,pptx,xlsx,xls,outlook]'
py -3 -m pip install "markitdown[docx,pptx,xlsx,xls,outlook]"
```

The UI shows only the commands applicable to the detected platform, keeps them copyable as plain text, and notes that Picot must be restarted after installation (the probe result is cached for the embedded-server process lifetime). It is instructional only: Picot never runs it, never opens a terminal, and never writes into a Python environment.

A locally installed MarkItDown version may convert additional selected suffixes through its built-in converters. Picot still invokes its local-only conversion path with plugins disabled; it neither discovers nor trusts user-installed plugins. A failure is non-fatal and falls back to cannot-preview.

## 7. Error Handling and Resource Limits

The conversion adapter exposes distinct internal outcomes for:

- interpreter unavailable or too old;
- MarkItDown unavailable or incompatible;
- suffix not eligible for conversion;
- source file exceeding the conversion input limit;
- concurrency capacity unavailable;
- subprocess timeout or cancellation;
- stdout or stderr exceeding its limit;
- non-zero exit or empty/whitespace-only conversion output.

The HTTP route maps these to stable browser-safe preview outcomes. It logs
diagnostic detail server-side but never sends untrusted stderr or local
environment detail to the WebView.

`markitdown-preview.ts` defines and tests these fixed limits:

```text
MARKITDOWN_INPUT_BYTE_CAP = 32 MiB
MARKITDOWN_OUTPUT_BYTE_CAP = 2 MiB
MARKITDOWN_STDERR_BYTE_CAP = 256 KiB
MARKITDOWN_TIMEOUT_MS = 20_000
MARKITDOWN_MAX_CONCURRENCY = 2 per embedded server
```

The adapter checks the descriptor's initial size, then uses a counting stream
that stops at the input cap even if the source grows after validation. Its
`spawn` stdout and stderr listeners drain and count each stream independently;
the declared caps are Picot application limits, not child-process buffer
settings. Reaching either cap immediately starts platform termination and
reports `conversionFailed` after the child exits. It also reports
`conversionFailed` on timeout or abort. Diagnostic
logging records only the normalized outcome plus at most 200 sanitized stderr
characters; it does not log full source paths, interpreter paths, or environment
values.

MarkItDown buffers non-seekable stdin into Python memory before conversion. The
32 MiB cap and concurrency limit therefore bound source buffering to at most
64 MiB per embedded server, but they do not provide a hard limit on decompressed
Office data or converter-library memory. That residual local-resource risk is
explicit; a future hard-memory sandbox is out of scope.

Concurrency slots are acquired without an unbounded queue and released exactly
once on success, failure, abort, or spawn error. If two conversions are active,
a third request fails fast with `conversionFailed`. On Windows, termination
kills the child process tree with fixed `taskkill.exe` arguments; on
macOS/Linux it uses TERM, a bounded grace period, then KILL. Closing or
superseding a preview aborts its fetch; the Bun signal or correct Node disconnect
signal kills the subprocess and releases its slot.

## 8. Security Model

MarkItDown performs I/O with the invoking process's permissions. Picot therefore
must preserve its existing file boundary before process invocation:

1. Treat the browser-provided path as untrusted.
2. Resolve it through the active workspace root.
3. Reject paths outside the root, symlink escapes, directories, and
   non-canonical files; canonicalize allowed symlinks whose targets remain
   inside the workspace.
4. Keep the validated descriptor open and stream its bounded bytes into the
   fixed MarkItDown invocation's stdin.

The subprocess is launched with `execFile` and a fixed argument array; no shell
interpolation, browser-selected executable, local source path, URL,
environment-supplied plugin, cloud integration, or LLM option is allowed. The
official no-filename CLI path calls MarkItDown's `convert_stream()` API with the
approved suffix as stream metadata, rather than its permissive path/URL-capable
conversion API. Streaming from the already validated descriptor avoids a path
replacement race between validation and conversion. This design is OS-neutral:
Windows source paths are never passed to Python, so drive letters, UNC paths,
quoting, and command-line escaping do not affect source-file access.

Converted Markdown is untrusted data. It remains subject to
`public/file-preview-markdown.js`'s element, attribute, URL-protocol, and
inline-event-handler allowlist before it enters the preview DOM, plus the
converted-document remote-image policy in §4.7.

## 9. Validation

### 9.1 Automated tests

- `extensions/markitdown-preview.test.ts` verifies two-stage
  interpreter/capability detection for macOS/Linux and Windows candidates,
  standalone-CLI discovery (shebang parsing, realpath resolution, capability re-validation, rejection of relative/non-existent/multi-arg shebangs), exact no-filename stdin arguments, no-shell execution, the running input
  counter, application-level stdout/stderr limits that terminate the spawned
  child, timeout cleanup, concurrency-slot accounting,
  POSIX escalation, Windows process-tree termination arguments, cancellation,
  and error mapping. Standalone-CLI tests must not execute a real installed
  `markitdown`; they inject a fake `readFile`/`realpath`/`spawn` fixture that
  returns a controlled shebang line and scripted capability output.
- `extensions/file-routes.test.ts` verifies the server allowlist, CSV text
  preservation, EML/RTF conversion classification, MBOX binary classification,
  outside-workspace rejection, allowed in-workspace symlink canonicalization,
  symlink escapes, and non-regular-file rejection. A parity test compares the
  server allowlist with the frontend mirror.
- Preview panel and renderer tests verify successful converted content selects
  converted-document Markdown mode, remains non-editable from first paint, maps
  all four dependency reasons (and only exposes `pythonVersion` for
  `pythonTooOld`), maps `conversionFailed` to cannot-preview, blocks
  remote and relative images with the localized placeholder, preserves data
  images, and retries a silently aborted tab when selected again.
- Adapter tests exercise normal Node GET completion, Node client disconnect
  through `req.aborted` or an unfinished response close, and Bun `AbortSignal`
  cancellation, including child-process termination and exactly-once
  concurrency-slot release.

### 9.2 Opt-in real conversion smoke tests

Real DOCX, PPTX, XLSX, XLS, and MSG samples are the only stable-format smoke
fixtures; they exercise the installed MarkItDown runtime without mocks. These
tests are opt-in behind `MARKITDOWN_E2E=1`, so ordinary `bun run test` remains
independent of a host Python installation. The opt-in run reports a clear skip
reason when Python or MarkItDown is missing. Other allowed suffixes may receive
targeted regression fixtures only after a real conversion is verified on the
pinned test environment.

### 9.3 Completion checks

After implementation, run focused conversion and preview tests,
`bun run test`, and `bun run check`. Update `ARCHITECTURE.md` to document the
subprocess boundary, stdin-only source flow, resource/concurrency limits,
converted-document image policy, and Node/Bun cancellation contract.

In real macOS and Windows Tauri development sessions, verify one successful
local conversion, all four dependency-guidance states that can be reproduced on
the host, a conversion-failure fallback, remote-image blocking, and cancellation
without an error flash. The Windows check must cover discovery through `py -3`,
paths inside a drive-letter workspace, and cancellation of an active conversion.
In addition, verify standalone-CLI discovery on each platform by installing
MarkItDown via `uv tool`/`pipx` (so no interpreter candidate exposes `import
markitdown`) and confirming Picot recognizes the standalone `markitdown` command.
Until automated Windows coverage exists, record this manual Windows run as a
release gate.

## 10. Out of Scope and Future Work

This slice intentionally excludes:

- bundling Python, MarkItDown, or a document engine;
- conversion-result caching;
- MBOX support;
- PDF-to-Markdown conversion;
- cloud conversion, OCR, plugins, LLM image descriptions, remote URL conversion,
  or automatic loading of remote images from converted output;
- editing converted files or writing Markdown back to the source;
- changing `/api/files/raw` or the workspace path-security model;
- a cross-platform hard-memory sandbox beyond the byte, time, and concurrency
  limits in §7.

Future work may assess bounded caching, additional format support, a dedicated
converter process, a hard-memory sandbox, or a bundled engine only if product
requirements and application-size budget change.
