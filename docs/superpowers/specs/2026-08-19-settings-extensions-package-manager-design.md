# Settings Extensions Package Management Design

## Status

Approved in discussion with Dr. Lin on 2026-08-19. Implementation has not
started. This document defines the migration of upstream Picot's installed Pi
package manager into the existing **Settings → Extensions** surface on the
`private/features-v3` branch.

It supersedes the current single-purpose community-package browser layout. It
does **not** add upstream's left-sidebar Extensions entry or its
`resource-dialog` presentation.

## Problem

The current Settings → Extensions page is a community registry browser. It can
search the `pi-packages` registry and install or remove a package, but it has
no first-class view of configured packages, their scope, resolved resources,
disabled state, metadata, or update status.

Upstream Picot provides this information in `public/native/settings/package-manager.js`.
It is presently made reachable through a left-sidebar Extensions button and a
special dialog mode. That navigation does not fit features-v3: Settings already
has an Extensions primary section, and a second sidebar entry would duplicate
navigation while consuming scarce sidebar space.

The product needs one Extensions setting section with two peer views:

```text
Settings
└─ Extensions
   ├─ 已安装 (Installed)   — manage configured Pi packages
   └─ 社区 (Community)     — discover registry packages
```

## Goal

Provide a desktop-native package-management surface under Settings → Extensions
that preserves upstream package-manager behavior:

- group configured packages by Global and Current project scope;
- inspect installed path, metadata, state, and resolved resource contributions;
- enable or disable a package;
- update or remove a package;
- refresh package metadata;
- explicitly restart the active Pi runtime after changes;
- preserve the existing community registry browse/install/remove experience.

The two views must be accessible tabs, must lazy-load independently, and must
not introduce another left-sidebar entry, a modal resource dialog, or an
in-page shortcut that simply switches to the other tab.

## Non-goals

- Do not add `sidebar-extensions-btn`, `openResourceDialog("extensions")`, or
  any `resource-dialog` mode for Extensions.
- Do not automatically restart Pi after enable/disable/update/remove.
- Do not add a persistent `+ Add plugin`, `Browse community packages`, or
  equivalent cross-tab CTA inside the Installed tab. The tab strip is the
  navigation mechanism.
- Do not remove the existing registry-side installed indicator or its
  install/uninstall action. Only the **Installed only** filter is redundant.
- Do not make package management available to LAN/mobile/non-native clients.
  They may browse the community catalog but package mutation controls remain
  desktop-native only.
- Do not reimplement Pi's package resolver in JavaScript. The host is the
  authority for configured sources, scopes, package metadata, and resolved
  resources.

## Product decisions

| Concern | Decision |
| --- | --- |
| Primary surface | Only `#/settings/extensions`; no left-sidebar Extensions entry. |
| Inner tabs | **已安装** first, **社区** second. The default is 已安装. |
| Tab state | The selection exists only while the Settings panel is open. It is not encoded in the URL or persisted in localStorage in v1. `#/settings/extensions` always opens 已安装. |
| Accessibility | Native `<button role="tab">` controls with roving `tabindex`, `aria-selected`, `aria-controls`, `role="tabpanel"`, and ArrowLeft/ArrowRight/Home/End navigation, matching Settings → Skills. |
| Installed layout | Port upstream `pkg-manager-shell`: scope-grouped sidebar plus package detail pane and footer. Preserve its manager controls and resource visibility. |
| Installed empty state | Text-only explanation (`extensions.noInstalled`); no cross-tab CTA. |
| Community layout | Preserve the current registry search, resource-type pills, sort, results, pagination, external links, installed state indication, and install/uninstall behavior. |
| Redundant filter | Remove `#pkg-browse-installed-only`, its `browseInstalledOnly*` state/event/filter logic, its CSS, and `extensions.installedOnly` localization strings if unused elsewhere. |
| Runtime application | Changes modify persisted Pi package configuration / installed contents. The active runtime is not automatically restarted; the user explicitly chooses **Reload agent** in the Installed footer. |
| Runtime reload | Use the existing runtime restart control path. On success, invoke the existing re-bootstrap callback so the WebView reconnects to the replacement runtime. |
| Native availability | Installed management renders its established management-unavailable state without host control. Community browsing continues to work; install/uninstall remains disabled outside a native host. |
| Package list authority | The host returns rich package records. The browser does not infer disabled state or paths from registry data or parse `pi list` output. |

## User experience

### Extensions panel

The primary Settings nav item continues to be `data-settings-tab="extensions"`.
Inside its existing header/body, render a tab strip before the two panels:

```text
Extensions
[ 已安装 ] [ 社区 ]
────────────────────────────────────────────────────────
<active panel>
```

The Installed tab is initially active. Selecting a tab keeps both DOM panels
alive, hides the inactive panel with the same `.hidden` contract used by the
Skills tab shell, and invokes that panel's lazy activation once. Re-selecting a
loaded tab renders cached state rather than re-requesting data. The user can
explicitly refresh Installed packages through its footer; the community browser
retains its existing retry/force-load behavior.

The Settings page URL remains `#/settings/extensions`; neither `installed` nor
`community` becomes a deep-link fragment in this release. This avoids adding a
second route grammar only for ephemeral in-panel state and matches the existing
Skills inner-tab behavior.

### Installed tab

The tab retains upstream package-manager interaction semantics and visual
structure:

1. A scrollable left list is grouped **GLOBAL** then **CURRENT PROJECT**.
2. A row identifies a package by resolved name/source, status dot, resource
   summary, and version. Selecting a row changes the detail pane.
3. The detail pane shows the enable switch, scope, canonical source, Update,
   Remove, status, version, package name, description, resource totals,
   resolved install path, workspace path where available, and resource rows.
4. Resource rows list the resolved extensions, skills, prompts, and themes with
   display name and package-relative path. DOM text APIs are mandatory for all
   host/registry-derived strings.
5. A package action has a per-package busy state. While busy, competing actions
   on that package and runtime reload are disabled; success/failure appears in
   the footer message area.
6. The footer shows resource totals, **Reload agent**, and **Refresh**.
7. With no configured package, render only the established no-installed note
   and summary; do not show a community-navigation CTA.

`Reload agent` is deliberately explicit. A package may be changed in several
operations before one restart, and automatically restarting could interrupt a
turn or discard the user's preferred timing. The control must reject/disable
while an action is in progress or no active workspace/session target exists.

### Community tab

The existing community experience remains in place:

- search by name, description, or author;
- resource-type filters: All, Extensions, Skills, Themes, Prompts;
- sort: downloads, name, recently updated;
- result count and pagination;
- npm/repository/homepage external links;
- registry package type/resource badges;
- installed-aware **Install** / **Uninstall** action;
- desktop-only mutation gating and inline install error rendering.

Remove the **Installed only** checkbox. Its previous purpose—finding installed
packages—belongs to the Installed tab, where richer package state is available.
The registry result cards still calculate `installed` so they can offer the
correct Install or Uninstall action.

### Responsive behavior

Reuse upstream manager CSS and preserve current Settings responsive behavior:

- At narrow widths, the manager shell changes from side-by-side to stacked;
  the installed list becomes a bounded/full-width list before the detail pane.
- Long sources, paths, and resource names truncate visually but retain a title
  or accessible name where present in upstream behavior.
- The tab strip stays keyboard operable and wraps/scrolls according to existing
  Settings conventions; no horizontal page overflow is introduced.

## Host-control contract

All package-management controls are native host operations routed through the
existing broker control channel. Browser inputs are untrusted. The host validates
scope/source/cwd and owns all filesystem access and execution of the embedded
Pi binary.

### `list_pi_packages`

Replace the current `string[]` return value with an array of package records:

```ts
interface PiPackageRecord {
  source: string;
  scope: "global" | "project";
  installedPath: string | null;
  packageName: string | null;
  version: string | null;
  description: string | null;
  disabled: boolean;
  counts: {
    extensions: number;
    skills: number;
    prompts: number;
    themes: number;
  };
  resources: Array<{
    kind: "extension" | "skill" | "prompt" | "theme";
    name: string;
    relativePath: string;
  }>;
}
```

The record set must reflect Pi's configured package list and scopes, including
entries whose resolved install path is absent. A missing path is represented as
`installedPath: null`, zero resources, and retained source/scope—not silently
removed from the list. `disabled` must represent the persisted package setting,
not a UI-local optimistic interpretation.

Implementation should reuse/adapt upstream host package inspection rather than
inventing a second source resolver. It may invoke the embedded Pi CLI where
that is the upstream mechanism. Parsing must be bounded and tolerant of
missing/malformed package metadata: malformed or absent manifests yield null
metadata/zero resources for that package rather than failing the full list.

### Mutations

Transport methods and broker controls:

```ts
updatePiPackage(source): Promise<void>
setPiPackageDisabled(source, scope, disabled, cwd): Promise<{ changed: boolean }>
restartRuntime(workspaceId, sessionId): Promise<{ instanceId: string }>
```

Existing methods remain:

```ts
listPiPackages(): Promise<PiPackageRecord[]>
installPiPackage(source): Promise<void>
removePiPackage(source, { local?: boolean }): Promise<void>
```

Rules:

- `update_pi_package` executes Pi's package update for the requested source.
- `set_pi_package_disabled` atomically updates the selected global or project
  package entry and returns whether persisted state changed. Project mutation
  requires a valid current workspace and must not accept a browser-supplied
  arbitrary filesystem target.
- `remove_pi_package` must receive local/project scope information. The
  Installed manager passes `{ local: pkg.scope === "project" }`, retaining
  upstream behavior; the community page should keep its existing global
  behavior unless scope-aware registry installation is explicitly added later.
- `restart_runtime` targets the authenticated native owner's current workspace
  and active session. The host must not restart an arbitrary instance requested
  by another client.
- Install/update/remove failures return clear broker errors. The frontend shows
  them in the existing inline manager/community status affordances and never
  treats a command rejection as success.

## Architecture and ownership

```text
Settings → Extensions (public/index.html)
  ├─ extensions-tab-shell.js             accessible selection + lazy activate
  ├─ package-manager.js                  installed package manager (new module)
  │    └─ WsTransport / broker control
  │         └─ main.rs native control handler
  │              └─ PiManager / focused package inspection helpers
  └─ package-browse.js                   community registry browser (extract from app.js)
       └─ WsTransport / broker control for install-state and mutations
```

### Frontend boundaries

`public/app.js` remains an orchestrator. The present ~500-line inline community
browser must be extracted into `public/settings/package-browse.js`; package
management belongs in a separate `public/settings/package-manager.js`.
Neither module may mutate global shared state at import time.

Create `public/settings/extensions-tab-shell.js` by generalizing the proven
behavior of `skills-tab-shell.js`, or use a narrowly parameterized generic tab
shell if doing so does not make the Skills implementation less clear. It owns
only accessibility, selected tab DOM state, and lazy activation. It does not
own package data or make package requests.

`public/app.js` constructs the community browser and manager with explicit
dependencies (`transport`, `nativeAvailable`/capabilities, workspace/session
accessors, notifier and restart callback), then wires them to the tab shell.
The initial Extensions select should activate Installed; it must no longer
inline package-browse event bindings or use the former `loadBrowsePackages()`
global.

### Host boundaries

The existing frontend controls are routed through the native `main.rs` control
handler. Add only operations required by the approved UI and preserve its
native-owner authorization pattern. If features-v3 needs an upstream equivalent
of `pi_launch.rs` package inspection/mutation helpers, put it in a focused host
module rather than growing `main.rs` parsing logic. The command dispatcher
should be a thin validation/ownership layer.

Any operation that edits global/project `settings.json` must preserve unrelated
configuration and write atomically. Scope resolution and project path choice
are host-derived from the authenticated window owner; a remote caller cannot
supply a writable path.

### Compatibility with the Skills package inventory

Settings → Skills → Packages is a read-only package-skill candidate inventory
with its own specified source-resolution rules. This feature must not merge its
UI into Extensions or weaken that inventory's trust/resource-boundary rules.
Both surfaces may report package-derived resources, but they have different
contracts:

- Extensions → Installed is operational package configuration/management.
- Skills → Packages is a read-only bundled-skill candidate view.

## Localization

Add the upstream installed-manager strings to every maintained locale following
current i18n conventions. Keep existing community strings except for the removed
`extensions.installedOnly` key. Required installed-manager concepts include:

- Installed / Community tab labels and tablist aria label;
- scope labels; no packages / no resources / not on disk;
- enable/disable; update/remove; status/version/package/description/resources;
- resolved resources/install path/current workspace;
- reload agent, reloading, unavailable and tooltip text;
- refresh and tooltip text;
- action success messages and load/action failures;
- resource count / totals.

No user-controlled string is interpolated with HTML. Localized dynamic values
continue through `t(key, params)` and DOM `textContent`.

## Implementation plan

Work in small, independently reviewable commits. Before every code change,
inspect the current working tree and preserve the unrelated active Hunk changes.

### Phase A — establish contracts and tests

1. Add failing Rust tests for rich package records:
   - parser/inspector recognizes global and project records;
   - disabled state is represented;
   - a package with no on-disk install remains represented;
   - manifest resources/counts map to the supported kinds;
   - malformed/missing metadata is package-local, not a whole-list failure.
2. Add failing authorization/mutation tests:
   - `set_pi_package_disabled` validates source/scope and only changes the
     selected owner-derived settings file;
   - `update_pi_package` forwards the intended source;
   - `restart_runtime` rejects missing/stale workspace or session targets;
   - non-native clients cannot execute mutating operations.
3. Add frontend unit tests for an Extensions tab shell:
   - Installed is the initial selection;
   - clicking and keyboard navigation update roving tabindex, aria state and
     panel visibility;
   - first activation is lazy and later selection does not reinitialize a panel.
4. Add/port package-manager unit tests from upstream, adapting selectors and
   explicit dependencies:
   - empty state;
   - global/project grouping and initial selection;
   - selection changes the detail pane;
   - toggle/update/remove requests and busy/error behavior;
   - reload calls current workspace/session and invokes re-bootstrap callback;
   - no Add-plugin/community switching control is rendered.
5. Add community-browser regression tests covering:
   - installed state still chooses Install/Uninstall;
   - the removed checkbox is absent;
   - filters no longer contain an installed-only predicate.

### Phase B — native package-management capability

1. Locate/adapt upstream's package-list implementation into features-v3's host
   architecture. Add a focused helper/module if the current `PiManager` only
   exposes `list_configured_package_sources()`.
2. Change `list_pi_packages` in `src-tauri/src/main.rs` to return the rich
   package-record array, preserving structured errors.
3. Add native control cases for `update_pi_package`,
   `set_pi_package_disabled`, and `restart_runtime`, reusing existing
   owner/workspace/session authorization and runtime coordinator paths.
4. Ensure install/remove/update invalidate any package/model caches that the
   current host depends on.
5. Verify desktop and remote behavior: only native control clients may mutate;
   remote clients receive a capability/authorization failure rather than a
   silent no-op.
6. Run focused Rust tests, then `bun run check:rust`.

### Phase C — transport and modular frontend extraction

1. Extend `public/app/transport.js` with `updatePiPackage`,
   `setPiPackageDisabled`, and `restartRuntime`; make `removePiPackage` accept
   its optional `{ local }` argument while maintaining existing callers.
2. Extract the community browser from `public/app.js` into
   `public/settings/package-browse.js` with an explicit `setupPackageBrowse`
   API. Preserve registry behavior and installed-state updates.
3. Remove `#pkg-browse-installed-only` markup, CSS, state, event listener, and
   predicate during extraction; retain `browseInstalledSet` solely for action
   state.
4. Port upstream `package-manager.js` to
   `public/settings/package-manager.js`, deleting `normalizeSource`, the
   `pkg-manager-add-btn` binding, `pkg-browse-close-btn` binding, and all
   `onBrowseRevealed` dependencies. Do not add a replacement CTA.
5. Implement `public/settings/extensions-tab-shell.js` and its focused tests.

### Phase D — integrate the Settings UI

1. Replace the existing Extensions HTML body in `public/index.html` with:
   - the accessible Installed/Community tablist;
   - `#settings-installed-packages` / manager panel;
   - `#settings-community-packages` / browser panel;
   - manager DOM IDs required by the ported module;
   - existing community DOM IDs retained inside the Community panel.
2. Add manager/tab CSS to `public/style.css`, using existing Settings tokens and
   mobile breakpoints. Remove the retired installed-only CSS.
3. In `public/app.js`, instantiate both modules and the tab shell. On selecting
   the primary Extensions Settings section, select/activate Installed. Do not
   alter the `#/settings/extensions` URL behavior.
4. Wire manager restart success into the existing session/runtime bootstrap
   callback. Confirm a restart cannot leave stale UI state connected to the
   prior instance.
5. Add all approved i18n strings and delete dead keys.
6. Update `ARCHITECTURE.md` because the change introduces a host-controlled
   package-management mutation surface and changes Settings → Extensions'
   architecture/invariants.

### Phase E — verification and manual acceptance

1. Run focused frontend tests for the new manager, tab shell, community browser,
   transport, and Settings startup.
2. Run focused Rust tests for package controls and runtime restart, then
   `bun run check:rust`.
3. Run `bun run check` after every public JS/HTML/CSS change.
4. Run the full `bun run test` suite before completion because the feature
   crosses native controls, filesystem-backed configuration and UI behavior.
5. Manually validate in the native desktop app using a disposable package:
   - Settings opens Extensions on 已安装;
   - keyboard and pointer tab navigation work;
   - Global and project packages group correctly;
   - a package with resources exposes correct details;
   - disable/enable/update/remove produce truthful messages;
   - Reload agent reconnects to the new runtime;
   - Community installs/uninstalls still update card state;
   - no sidebar Extensions entry, resource dialog, installed-only checkbox, or
     Add-plugin/community CTA exists;
   - narrow viewport manager layout stays operable.
6. Review `git diff` and `git status` to ensure none of the current unrelated
   Hunk working-tree changes were modified or committed accidentally.

## Acceptance criteria

- `#/settings/extensions` contains exactly two accessible inner tabs: 已安装
  and 社区, with 已安装 selected initially.
- The installed tab reproduces upstream manager behavior except for the
  intentionally removed Add-plugin/community navigation control and absent
  upstream sidebar/dialog entry.
- The host provides authoritative rich records and all displayed manager
  controls execute their intended native operation or report a visible error.
- Restart remains an explicit user action and reboots the correct current
  runtime.
- Community browse functionality remains intact, but no Installed-only
  checkbox, filter state, CSS, or unused localization key remains.
- All package mutations remain native-owner scoped and preserve existing
  settings-file safety/integrity guarantees.
- Architecture documentation, focused tests, `bun run check`, `bun run
  check:rust`, and the full `bun run test` pass.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Porting upstream files assumes a different host architecture. | Port behavior through features-v3's existing broker/native control boundary; do not copy sidebar/dialog wiring. |
| A rich package list drifts from Pi resource resolution. | Adapt upstream inspection where possible; test representative global/project, disabled, missing-path, and manifest cases. |
| Package operations alter global/project configuration incorrectly. | Keep path/scope derivation host-owned, use atomic settings writes, and test authorization plus unrelated-settings preservation. |
| Runtime restart disrupts a user mid-turn. | Require explicit click, disable while package action is busy, and surface errors rather than auto-restarting. |
| Extraction from `app.js` changes community behavior. | Add regression tests before extraction; preserve DOM IDs and injected dependencies. |
| Two packages views confuse scope. | Label Installed as operational configured packages and retain registry badges/actions in Community; remove only the redundant installed-only filter. |
