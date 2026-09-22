# `@` File Mention Design

## Status

Approved product scope from the conversation with Dr. Lin on 2026-07-25:

- Type `@` in every Picot chat composer to search and insert a file-path mention.
- Support the current workspace, `@../…`, `@~/…`, and absolute paths, matching
  Pi TUI's path syntax and completion behavior as closely as the web UI permits.
- The main chat, Side Chat, and Quick Chat use one shared interaction module.
- Version 1 inserts a textual path token only. It does **not** read a file,
  inline text content, or attach an image at message-send time.

Implementation has not started. This document is the authoritative behavior and
security contract for the feature.

## Goal

Let a user reference a local file quickly and unambiguously while composing a
prompt, without manually typing a long path or using only the File Browser
custom drag gesture.

For example, after typing `Please inspect @auto`, the user can select
`@packages/tui/src/autocomplete.ts ` from a menu. The literal completed token is
sent with the rest of the prompt. An agent with filesystem tools can then read
that named path when appropriate.

The feature is an editor autocomplete facility, not a new file-transfer or
context-injection mechanism.

## Non-goals

Version 1 does not:

- read file content, attach file bytes, create an image attachment, or add a
  hidden prompt section when a mention is submitted;
- validate that a mentioned path still exists at send time;
- promise that the model or agent has read a mentioned file;
- add arbitrary-path access to existing preview, editing, raw-file, or native
  open APIs;
- make a Quick Chat's `--no-tools` runtime able to read a mentioned file;
- reproduce native HTML5 drag-and-drop (the existing custom file-tree drag
  interaction remains unchanged);
- provide git-aware status, line-range syntax, multi-file selection, or a
  persisted mention/attachment data model;
- index the filesystem in the background or retain search results after a
  composer is destroyed.

## Terminology

| Term | Meaning |
| --- | --- |
| **mention token** | Literal text beginning with `@` inserted into a textarea, such as `@src/app.ts` or `@"my folder/a.ts"`. |
| **query** | The unquoted path expression after the active `@`, used to request suggestions. |
| **display path** | The user-visible path portion of a suggestion, always `/`-separated even on Windows. |
| **search base** | The real local directory from which a recursive search runs. |
| **owner workspace** | The workspace selected by the Picot window's main session. It is the autocomplete root for all three composers. |
| **directory candidate** | A suggested directory, whose completed token ends in `/` and remains editable for a deeper query. |

## Product behavior

### Supported composer surfaces

The exact same mention interaction is present in:

1. the persisted main-chat `#message-input` textarea;
2. every Side Chat textarea created by `EphemeralChatView`; and
3. the Quick Chat textarea created by `EphemeralChatView`.

The DOM identity and runtime owner differ, but input parsing, rendering,
keyboard behavior, insertion, cancellation, and accessibility semantics must be
owned by the same frontend module. The feature must not be copied into
`app.js` or implemented separately in `ephemeral-chat-view.js`.

All three surfaces search against the **owner workspace**, not an arbitrary
path supplied by the browser and not a Quick Chat's Picot-owned temporary cwd.
This makes the visible candidate set consistent within one Picot window.

A Quick Chat still sends a literal mention token to its `--no-tools` Pi runtime.
That runtime cannot use the normal filesystem tools to inspect it. This is an
intentional v1 limitation arising from the confirmed pure-text scope; the UI
must not claim that the file was attached or included as context.

### Token recognition

A mention is active only when the cursor is inside a token that starts at a
supported boundary:

- start of a line;
- immediately after space, tab, `=`, a single quote, or a double quote;
- `@` followed by zero or more non-whitespace characters; or
- `@"` followed by an unfinished quoted path.

`name@host`, `email@example.com`, and text where `@` is embedded in another
non-whitespace token do not open file completion. Completion is calculated
from the text before the selection start; text after the cursor is preserved.

A multiline textarea treats each line independently. The active token never
crosses a newline. A selection may be replaced only when the user explicitly
chooses a candidate.

### Path grammar and roots

The following input forms are accepted. Their output preserves the visible form
rather than replacing it with an absolute filesystem path.

| Typed form | Search base | Inserted display form example |
| --- | --- | --- |
| `@foo` | owner workspace root | `@src/foo.ts` |
| `@src/foo` | `owner workspace/src/` | `@src/foo.ts` |
| `@./foo` | owner workspace root | `@./foo.ts` |
| `@../foo` | parent of owner workspace | `@../shared/foo.ts` |
| `@../../foo` | correspondingly higher parent | `@../../foo.ts` |
| `@~/foo` | user home directory | `@~/Documents/foo.ts` |
| `@/foo` (POSIX only) | filesystem root, then the explicit directory prefix | `@/usr/local/foo.ts` |
| `@C:/foo` (Windows) | named drive root, then the explicit directory prefix | `@C:/Users/name/foo.ts` |
| `@//server/share/foo` (Windows) | named UNC share root | `@//server/share/foo.ts` |
| `@"my folder/f"` | owner workspace or the appropriate explicit root | `@"my folder/file.ts"` |

The `~` shorthand is accepted only as `~` or `~/…`; it expands on the server
using the Pi process user's home directory. It is never expanded in browser
JavaScript. Path output uses forward slashes on every platform. For Windows,
drive paths are displayed as `C:/…`; UNC paths retain their `//server/share/…`
form. Windows has no single filesystem root: a bare `@/` is invalid and returns
`400 invalidMentionQuery`; callers must name a drive or UNC share explicitly.

A bare `@` searches recursively from the owner workspace. It must not mean
"search all of the user's filesystem". A bare `@~` lists/searches the home
root. On POSIX only, bare `@/` lists/searches the filesystem root. These broader
roots are allowed because Dr. Lin explicitly requested Pi TUI-compatible
absolute path support, but are subject to the access controls below.

### Candidate selection and insertion

The server returns at most 20 ranked candidates. A candidate contains:

```ts
type FileMentionCandidate = {
  value: string;       // complete token, e.g. '@src/index.ts' or '@"my dir/"'
  label: string;       // basename plus '/' for directories
  description: string; // unquoted display path, e.g. 'src/index.ts'
  isDirectory: boolean;
};
```

When a user selects a candidate:

- replace the active token prefix up to the current cursor with `value`;
- preserve all text after the cursor;
- append exactly one ASCII space after a **file** candidate;
- append no space after a **directory** candidate;
- put the cursor after that space for files;
- for a quoted directory, leave the cursor before its closing quote so typing
  can continue inside the quoted path;
- dispatch a bubbling `input` event after mutation so autoresize and any other
  composer observers run.

Use `HTMLTextAreaElement.setRangeText()` with selection mode `"end"`. Preserve
the existing fallback for environments that do not implement it. For a quoted
directory, `setRangeText(..., "end")` initially places the caret after the
closing quote, so the helper must immediately call `setSelectionRange()` to
move it back one code unit before that quote. This follows
`FileBrowser.insertFileMention()` and avoids WKWebView repaint failures caused
by direct `.value` assignment.

If a pathname contains a space, quote it as `@"…"`. A query that is already
quoted remains quoted. Quotes are not doubled if the text after the cursor
already contains the closing quote.

### Search, filtering, and ranking

The server performs a bounded recursive walk under the resolved search base.
It returns both regular files and directories, follows the Pi TUI candidate
model, and applies these rules:

- include dotfiles and dot-directories except the explicit ignored directories;
- exclude `.git`, `.git/`, and everything below it;
- exclude these noisy/generated directory names and everything below them:
  `node_modules`, `dist`, `build`, `target`, `.next`, `.nuxt`, `.cache`,
  `coverage`, `.venv`, `venv`, and `__pycache__`;
- keep an ignored directory excluded even when the user explicitly narrows the
  base with it (for example, `@node_modules/react` returns an empty candidate
  list); the ignore list is a noise-control policy, not a scope hint;
- do not follow directory symlinks during v1 traversal;
- skip unreadable entries and broken symlinks rather than failing the whole
  request;
- scan at most **10,000 directory entries** for a request and stop after
  **500 ms** of wall-clock time;
- return at most **20 ranked candidates**; when either traversal limit is
  reached, respond `200` with the best candidates collected so far and
  `truncated: true` (otherwise `truncated: false`);
- never expose server-internal error paths in the response.

Candidates are matched case-insensitively. The sort score follows the upstream
Pi contract:

1. basename exactly equals query;
2. basename starts with query;
3. basename contains query;
4. display path contains query.

A directory receives a small tie-break bonus. Ties are ordered by stable,
locale-independent display-path comparison. Directory candidates are labelled
with `/`; regular-file labels are their basename.

When the query has a `/`, the portion through the final slash determines a
narrower base directory and the final segment is the fuzzy query. For example,
`@packages/tui/src/auto` searches below `workspace/packages/tui/src/` for
`auto`, while the returned display paths retain `packages/tui/src/`.

Unlike upstream Pi's `fd`, v1's Node-side walker cannot claim full
`.gitignore` compatibility. It does not interpret `.gitignore` files; the
explicit ignored-directory list above is the deliberate v1 noise-control
policy. If exact gitignore fidelity is required later, that is a separate
backend dependency/performance decision, not a silent behavior change.

## Interaction design

### Lifecycle

On each textarea `input`, `click`, or cursor-moving key event, the controller:

1. reads `selectionStart` and text before it;
2. extracts an active mention prefix or closes its menu;
3. debounces an active query for 20 ms;
4. cancels the prior in-flight fetch with `AbortController`;
5. fetches candidates for the current owner workspace and query;
6. rejects a stale response unless its generation, textarea value, and cursor
   position still match the request snapshot;
7. renders an anchored listbox only when non-empty candidates remain.

No request is made for an inactive `@`, an empty textarea without `@`, or while
the textarea is disabled. A network, authorization, or enumeration error closes
the menu silently and logs a diagnostic warning; typing and normal send behavior
continue to work.

### Keyboard and pointer behavior

| Input | Behavior while menu is open |
| --- | --- |
| `ArrowDown` / `ArrowUp` | Move selected option cyclically; do not move textarea caret. |
| `Enter` / `Tab` | Insert the selected candidate and prevent normal send/focus traversal. |
| `Escape` | Close the menu without changing textarea text. |
| Other typing, deletion, cursor move | Re-evaluate active token and refresh or close. |
| Mouse hover | Makes that option selected. |
| Mouse down on option | Prevents textarea blur before click. |
| Click option | Selects and restores textarea focus. |
| Textarea blur | Closes in a microtask, allowing option click to complete. |

During IME composition (`event.isComposing` or legacy `keyCode === 229`), the
controller must not consume Enter, Tab, arrows, or Escape as mention commands.

The keydown listener for the mention helper **must be registered before** the
composer's Enter-to-send handler. When an open mention menu handles Enter, Tab,
or Escape, it must call both `preventDefault()` and
`stopImmediatePropagation()`. This is the required interception mechanism: the
main chat currently relies on listener registration order, and the same
ordering/interception rule applies to `EphemeralChatView`. Thus selecting a
completion can never fall through and submit a partial prompt.

The listbox is positioned relative to its owning composer card and must remain
within the visible WebView viewport. It has a fixed maximum visible item count,
scrolls internally, and uses the same visual vocabulary as the existing skill
slash menu. Long labels truncate visually but retain `title`/accessible names.

### Accessibility

Each textarea has, while the helper is installed:

- `aria-autocomplete="list"`;
- `aria-controls` pointing to its composer-scoped listbox;
- `aria-expanded="true"` only while suggestions are visible;
- `aria-activedescendant` pointing to the selected option only while visible.

The popup has `role="listbox"`; candidates have `role="option"` and accurate
`aria-selected` values. Every ephemeral composer creates unique popup and
option IDs—no document-global IDs may be duplicated. The selected candidate
must remain scrolled into view. The listbox accessible label and any empty/error
status text are localized through `i18n.js`; corresponding keys must be added
to both locale files and covered by locale-parity tests.

## Architecture

### Frontend module

Create `public/ui/at-file-mention.js`, owning only textarea mention completion.
It mirrors the lifecycle and public shape of `setupSkillSlashCommand()` but is
independent from skills and from the top-level command button.

Suggested interface:

```js
setupAtFileMention({
  input,
  container,
  composerCard,
  getWorkspaceRoot,
  searchFiles,
  document,
}) => { close, destroy, update }
```

Responsibilities:

- parse active `@` / quoted prefixes;
- maintain selection, request generation, debounce timer, and abort controller;
- render safe DOM with `textContent`, never candidate HTML interpolation;
- perform selection replacement with `setRangeText`;
- add and remove every element-scoped listener;
- return an idempotent `destroy()` that sets a `destroyed` flag, aborts fetches,
  clears timers, removes listeners, and removes/empties its popup; **every**
  asynchronous continuation must check that flag before reading or mutating DOM.

`getWorkspaceRoot` is a live lookup, not a value captured when a view is
created. The helper calls it once per outgoing request and must never cache its
result across requests. This prevents Side and Quick Chat from repeatedly
sending an obsolete root after a main-session workspace transition.

It does not know WebSocket message formats, Pi runtime ownership, image
attachments, file preview/edit operations, or file-tree dragging.

`public/app.js` creates the main-chat popup element in `index.html` and passes a
search adapter. `EphemeralChatView` creates a scoped popup element beside its
textarea, installs the same helper, and calls `destroy()` during teardown.
`EphemeralChatView` must get the owner workspace root from its manager/runtime
binding, not infer it from the Quick Chat's temporary Pi cwd.

`FileBrowser.toMentionPath()` and drag insertion remain supported. A small
shared pure utility may be extracted later for path display/quoting, but this
feature must not regress its existing cross-platform containment tests.

### HTTP contract

Add a dedicated read-only endpoint rather than changing the meaning of the
one-directory `GET /api/files` browser endpoint:

```text
GET /api/file-mentions?workspaceRoot=<canonical-owner-workspace>&query=<raw-prefix>
```

Successful response:

```json
{
  "items": [
    {
      "value": "@src/index.ts",
      "label": "index.ts",
      "description": "src/index.ts",
      "isDirectory": false
    }
  ],
  "truncated": false
}
```

The frontend sends the current root only to bind a request to the current UI
state. It is not an authorization claim. `/api/file-mentions` is served only by
the window's **main-session Pi embedded server**. It obtains the authoritative
active workspace from that main-session Pi context and rejects a root mismatch
with `409 workspaceChanged`; no Side Chat or Quick Chat Pi process—and in
particular no Quick Chat temporary cwd—may serve or determine this endpoint.
Stale UI responses are discarded without an error banner.

`query` is the raw active mention prefix including `@`; the server performs
normalization, root classification, quote handling, home expansion, and path
resolution. It returns `400 invalidMentionQuery` for malformed NUL-containing
or otherwise unparsable inputs (including Windows bare `@/`), and
`503 workspaceUnavailable` when no owner workspace exists. There is no v1
`403 mentionPathDenied`: inaccessible, missing, or unstatable search bases
return a successful empty candidate list so pathname existence/permissions are
not exposed as a distinct authorization oracle.

### Server-side path policy

The endpoint is **loopback-only**. Add it to the route policy in
`extensions/request-access.ts`, with tests covering Node and Bun request
adapters. It must fail closed when the controlled request has no peer address.

This is mandatory: workspace file browsing can be safely exposed read-only to
LAN clients under its current contract, but recursive `@~/` and absolute-path
completion enumerates a local user's filesystem and must never be exposed over
the LAN merely because it is read-only.

The endpoint must:

1. derive the active workspace root from `globalState.getLatestCtx()` / the
   embedded Pi context, not a browser-supplied path;
2. resolve the requested root under the current OS user identity;
3. canonicalize the base with `realpath` before traversal;
4. reject NUL bytes, unsupported tilde forms, and paths the process cannot
   stat/read;
5. preserve the user's requested display prefix separately from canonical
   filesystem resolution;
6. enforce the fixed 10,000-entry, 500-ms, and 20-candidate budgets and the
   `truncated` response contract;
7. subscribe to the controlling Node request's `close`/`aborted` events and
   Bun `Request.signal`, and stop recursive traversal immediately when either
   indicates cancellation; an aborted fetch must not continue consuming the
   full 500-ms/10,000-entry budget;
8. serialize only display paths and basename metadata, never absolute
   canonical paths unless the user explicitly typed an absolute prefix;
8. avoid shell commands and string-concatenated command execution.

Unlike file preview and edit APIs, mention search intentionally permits paths
outside the workspace. That exception belongs **only** to this loopback endpoint
and cannot be factored into `resolveScopedFilePath()` in a way that loosens the
workspace-only routes. Existing `GET/PUT /api/files/content`, `/api/files/raw`,
`/api/open`, and picker routes retain their established policies.

Directory symlink following is prohibited in v1 to avoid an apparently bounded
workspace query walking an unrelated tree. A directly selected symlink may be
shown as a leaf only if its link itself is readable; it is not recursively
expanded. This is intentionally stricter than Pi TUI's `fd --follow` behavior
because Picot's HTTP filesystem boundary has different exposure and resource
constraints.

### Message transport

No wire schema changes are needed. After selection, the existing send paths
continue to send:

```js
{ type: "prompt", message: textarea.value.trim(), images? }
```

No `mentions` field, raw path list, content payload, or server-side expansion is
added. Existing optimistic user-message rendering and queued prompt handling
therefore display exactly what Pi receives.

## Failure and lifecycle rules

- Closing a menu, changing workspace, destroying an ephemeral view, disabling a
  composer, or starting a newer request aborts the prior request and makes its
  response ineligible to render. Every asynchronous continuation also checks
  the helper's `destroyed` flag before touching DOM, because aborting a fetch
  does not prevent an already-queued microtask from running.
- A response received after workspace navigation, textarea mutation, or cursor
  movement is ignored.
- A request may never mutate another textarea or another ephemeral chat's
  menu, even if both currently contain the same query.
- File-system permission errors, concurrent deletion, symlink changes, and
  traversal limits produce an empty or truncated list, not a failed chat
  composer.
- Selecting a candidate is a local text operation. If the file disappears after
  completion, its token remains in the sent prompt unchanged.
- Existing drag-to-composer behavior continues to insert a workspace-relative
  token. It does not invoke a search request or need to share popup state.

## Tests and acceptance criteria

### Frontend unit tests

Add `public/ui/at-file-mention.test.js` covering:

- token boundaries; email and embedded-`@` non-matches;
- workspace, `../`, `~/`, absolute, quoted, and cursor-mid-token queries;
- file versus directory suffix/caret rules;
- preservation of suffix text and closing quotes;
- 20 ms debounce, request abort, and stale-result suppression;
- Arrow navigation, Enter/Tab selection, Escape close, mouse selection, and
  IME non-interference;
- ARIA state, localized listbox/empty-state labels, unique popup IDs for
  multiple ephemeral views, and cleanup after `destroy()` including a queued
  stale microtask;
- an `input` event after insertion and normal main-chat autosize compatibility;
- the existing `public/i18n-keys-completeness.test.js` locale-parity contract.

Extend the existing main chat and ephemeral view tests to establish that each
surface installs the shared helper and passes its own lifecycle cleanup path.

### Extension tests

Add endpoint/path tests under `extensions/` covering:

- root selection and display-prefix preservation for workspace, parent, home,
  POSIX absolute, Windows drive, and UNC inputs;
- no `.git` candidates; hidden non-git paths remain eligible; each documented
  generated-directory name is recursively ignored;
- case-insensitive ranking, 20-item limit, and `truncated: true` at either the
  10,000-entry or 500-ms traversal limit;
- no recursive traversal through directory symlinks;
- rejection of malformed/NUL input and Windows bare `@/`, successful empty
  results for inaccessible bases, and workspace-root mismatch;
- loopback authorization for `GET /api/file-mentions`, including absent peer
  address fail-closed behavior and both Node/Bun adapter paths;
- proof that preview/edit route containment is unchanged by this feature.

### Manual desktop acceptance

In macOS Tauri/WKWebView, verify all three composers:

1. typing `@` shows workspace candidates without stealing ordinary text focus;
2. typing `@../`, `@~/`, and an absolute prefix narrows candidates correctly;
3. spaces produce one correctly quoted token;
4. selecting a directory enables immediate deeper completion;
5. Enter selects an open candidate instead of sending; Enter sends normally
   after the popup closes;
6. IME candidate confirmation does not submit or select unexpectedly;
7. changing workspace while a request is pending cannot show old candidates;
8. Quick Chat visibly inserts the text but does not imply the no-tools agent has
   received file contents;
9. LAN/non-loopback access to the endpoint is refused.

After implementation, run focused Vitest suites—including
`public/workspace/file-browser.test.js` to prove drag-insert path containment
still holds—`public/i18n-keys-completeness.test.js`, `bun run check`, and
`bun run build:extensions`; run `bun run test` because this changes filesystem
path handling and the loopback access boundary.

## Documentation changes required with implementation

Update `ARCHITECTURE.md` when implementation lands:

- add `at-file-mention.js` to the frontend module map;
- document `/api/file-mentions` in the server/API map;
- state that the route is loopback-only and is the sole autocomplete exception
  allowing non-workspace path enumeration;
- cross-reference this design from the file-browsing security section.

## Known limitation retained for v1

A textual mention is useful to main and Side Chat because their agents have
filesystem tools, but it does not guarantee an agent action. Quick Chat runs
with `--no-tools`; therefore its textual `@` mention cannot cause automatic
file reading. Changing that would require an explicit new product decision:
either attach vetted content at send time, selectively enable a constrained
read capability, or remove mention completion from Quick Chat. It is outside
this design's approved pure-text scope.
