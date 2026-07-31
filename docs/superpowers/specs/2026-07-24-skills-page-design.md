# Skills Page Design

## Status

Approved in conversation with Dr. Lin on 2026-07-24. The visual direction is
recorded in [`docs/skill-page-prototype.html`](../../skill-page-prototype.html).
The prototype is a static review artifact; production must use Picot's existing
Settings layout, theme tokens, localization, and interaction conventions.

## Goal

Add **Settings → Skills**. Its final information architecture has three inner
tabs: **Discovered** for the grouped top-level/linked inventory and its
controls, **Install** for explicit linked-skill installation, and **Packages
skills** for read-only configured-package inventory. Discovered lets users
enable or disable a directory group or one top-level skill by editing Pi's own
settings files:

- Global: `~/.pi/agent/settings.json`
- Current project: `<cwd>/.pi/settings.json`

Each successful change is persisted atomically and immediately reflected by the
page's recomputed inventory. The embedded Pi extension API does not expose a
supported resource-reload operation to the long-lived embedded server, so a
running Pi process continues using its already loaded skills. The page tells
the user to start a new session or restart the affected Pi process for the
configuration to take effect.

## Product Decisions

| Concern | Decision |
| --- | --- |
| Surface | A new `Skills` primary Settings navigation item, available at `#/settings/skills`; not an independent app route. |
| Scopes | `Global` and `Current project` sub-tabs. Each controls only its corresponding settings file. |
| Layout | The **Discovered** tab uses provider-settings-style expandable cards: one discovered group folder per card and one row per skill. **Install** and **Packages skills** are specified in their extension designs. |
| Group controls | A group card can enable or disable every discovered skill in its group. A mixed card explicitly displays its partial state. |
| Skill controls | Every discovered `SKILL.md` has its own enable switch, even when disabled and absent from Pi's active command list. |
| Persisted mechanism | Preserve unrelated settings; change only the `skills` array using Pi's `!`, `+`, and `-` semantics. Generated rules use portable POSIX paths relative to Pi's resource base directory. |
| State authority | The server recomputes the inventory after every mutation. The browser never derives final effective state itself. |
| Runtime application | Persist settings and explicitly report that a new session or Pi-process restart is required; do not call unavailable `ctx.reload()` from the embedded server. |
| Identity | Canonical absolute `SKILL.md` path, not frontmatter name, identifies an inventory row. |

## Pi Compatibility Contract

The implementation follows the embedded Pi source's current resource resolver,
rather than treating `list_skills` as an inventory API. That existing Picot RPC
normalizes `api.getCommands()` and therefore has no visibility into skills
excluded by settings.

### Discovered roots

The inventory always reflects Pi's full discovery for the running
workspace (global + project roots together, exactly as
`DefaultResourceLoader` loads them), so frontmatter-name collisions
resolve in Pi's real precedence order. The `scope` option selects which
`settings.json` mutations target and which custom rules are surfaced;
it never filters which skills the page can see. The roots each scope
*owns* for mutation are:

The global scope inventories:

- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- existing global `settings.json` `skills` plain-path entries

The project scope inventories, only when Pi trusts the current project:

- `<cwd>/.pi/skills/`
- `.agents/skills/` in `<cwd>` and ancestors, stopping at the Git root or
  filesystem root, as Pi does
- existing project `settings.json` `skills` plain-path entries

The inventory observes Pi's recursive discovery rules: a directory containing
`SKILL.md` is one skill and traversal does not continue under it; root Markdown
files are only valid in Pi's `.pi/skills` roots; hidden directories, `node_modules`,
and entries ignored by `.gitignore`, `.ignore`, or `.fdignore` are excluded.

Package-provided skills are not mutable through the **Discovered** tab. They
are neither assigned to a top-level auto-discovery directory card nor silently
rewritten in a package filter. They are shown read-only in the dedicated
**Packages skills** tab specified by
[`2026-07-27-package-skills-tab-design.md`](2026-07-27-package-skills-tab-design.md).

### Pattern semantics

Within a scope, the resolver treats the scope's `skills` array as Pi does:

1. `!pattern` disables all glob matches;
2. `+path` force-enables an exact skill path or its skill directory after `!`
   exclusions;
3. `-path` force-disables an exact path after `+` rules.

The card status comes from the resolved result, not textual rule order:
`all-on`, `all-off`, or `mixed`.

Every discovered root has its own Pi resource base directory; patterns never
use a card's bare directory-relative name as their base. The generated pattern
text is a portable, POSIX-normalized path relative to **that resource base**.
For example, a group named `baoyu-skills` beneath
`~/.pi/agent/skills/` writes `!skills/baoyu-skills/**`, not
`!baoyu-skills/**`; its exact child override writes
`+skills/baoyu-skills/baoyu-diagram`. Roots at `~/.agents/skills/` and every
ancestor project's `.agents/skills/` each have their own `.agents` base, so
those rules likewise start with `skills/`. A `SKILL.md` row is represented by
its skill directory for exact `+` or `-` overrides, because Pi recognizes either
the skill file or its parent skill directory as an exact override target.

Unprefixed glob entries already present in `settings.json` are shown as
**custom include/filter rules** and are read-only in this page's first version.
They can alter the candidate resource set in Pi's local-path resolver and may
interact with a plain source path; the page must not assume they behave like
normal auto-discovery roots or rewrite them while toggling other resources.
The existing raw Configuration editor remains the deliberate escape hatch.

### Minimal mutation policy

The writer reads the latest JSON object on every request, preserves all keys and
unmanaged `skills` entries, computes a candidate array, writes it atomically,
then returns a newly resolved configuration inventory. It does not claim that
the current Pi runtime has applied the changed resources.

- **Disable one skill:** preserve existing rules and append/update a managed
  exact `-<skill-directory>` rule. The exact `-` has final precedence, including
  over existing `+` rules.
- **Enable one skill:** remove its managed exact `-` rule and, if an existing
  `!` exclusion still matches it, append/update `+<skill-directory>`.
- **Disable a group:** append/update `!<base-relative-skills-path>/**` and remove
  exact `+` overrides for members of that group. The group switch consequently
  means every currently discovered member is disabled; users can re-enable a
  child afterwards with its row switch.
- **Enable a group:** remove the exact group exclusion and preserve child `-`
  rules. If another broader `!` exclusion still matches a member, append an
  exact `+<skill-directory>` for that member, so the group switch consequently
  means every member except explicitly individually disabled members is enabled.

The server preserves settings keys and resource entries outside the target
group. A group operation may replace conflicting exact `+` entries inside that
group because those entries directly determine the requested group state; its
returned inventory names every resulting effective exception. Generated exact
`+` entries are idempotent: repeat enable does not duplicate them. They are
removed when the page later disables the same group, but intentionally remain
when an unrelated broader exclusion is manually removed; the page does not
infer ownership or delete user-authored rules outside the target group.

Before any mutation, the server detects duplicate rule-relative targets across
all roots in the selected scope. For example, `skills/foo` may exist under both
`~/.pi/agent` and `~/.agents`; one portable `!skills/foo/**` rule would affect
both. Such an ambiguous group or item is displayed but its switch is disabled
with a diagnostic directing the user to the raw Configuration editor. The page
never silently mutates multiple roots.

## User Experience

### Settings navigation and scope

`Skills` sits with General, Extensions, Usage, Configuration, and Chat in the
existing Settings sidebar. The settings URL opens it through the current
`#/settings/<tab>` handling.

The page header explains that changes apply to new sessions or restarted Pi
processes and contains a **Rescan** button. A two-option segmented tab control selects **Global** or
**Current project**, and shows a discovered-skill count. The scope header shows
the exact settings file that will be modified.

If the project has not been trusted, the project tab shows its resource roots
and an explicit trust warning but does not enable mutation controls. It does
not falsely report that project skills are active.

### Group cards

A group is a folder relative to a discovery root. The card header follows the
existing provider card hierarchy. The server also retains the root's Pi resource
base directory so it can produce the correct `skills/<group>/...` rules:

- disclosure control;
- group path and source root;
- compact effective-state badge: `All enabled`, `All disabled`, or `n/m enabled`;
- group switch.

A group switch toggles all group members through the mutation rules above. It
is visually indeterminate for a mixed group. Cards are initially expanded in
the first release; their open state is local UI state only.

### Skill rows

A row lists the frontmatter name, description, and concise rule/status context,
with an independent switch. Full canonical paths remain available as tooltip or
accessible label. A row can be individually enabled beneath a disabled group;
the resolved result renders it enabled and exposes the resulting `+` override.

After enable/disable resolution, the inventory resolves frontmatter-name
collisions in Pi precedence order. A losing row is labelled `Shadowed by <path>`
and its switch is disabled, because it cannot register a slash command while
its winning peer remains enabled. Current Pi tests establish project resources
as higher precedence than user resources; the implementation must derive the
winner from Pi-compatible precedence metadata rather than assume a fixed
user-first order.

Save progress disables only the affected group or row controls. Success shows
the existing Settings save-status treatment plus the explicit runtime-restart
requirement; failures retain the previous server-backed state and expose the
error inline. The card/row controls are disabled when their generated rule is
ambiguous across roots.

## Architecture

```text
Settings → Skills page (browser)
  └─ existing authenticated WebSocket RPC
       └─ embedded-server skill-inventory commands
            ├─ pure discovery + Pi-compatible pattern resolver
            └─ atomic settings JSON read/patch/write
                 └─ persisted configuration for the next Pi resource load
```

### Frontend

Create a dedicated `public/settings/skills-page.js` module. It owns the three
inner tabs, DOM rendering, scope selection, card expansion state, request
pending state, and inline error/status handling. Focused submodules may own the
Install and Packages skills tab behavior. `public/app.js` only wires the page into Settings
navigation and calls its public setup/load functions. Add the static Settings
tab shell to `public/index.html`, theme-compatible styles to `public/style.css`,
and English/Chinese locale keys.

The module uses DOM APIs and text content, never string interpolation of skill
metadata into HTML. It re-renders its current scope from the server response
after every completed mutation.

### Embedded server

Extract testable logic into a focused module, e.g.
`extensions/skill-inventory.ts`, rather than placing filesystem traversal and
pattern evaluation in `embedded-server.ts`. It owns:

- discovery-root construction and trust-gated project traversal;
- Pi-compatible skill discovery and frontmatter parsing;
- group construction, stable canonical IDs, and resource-base-relative rule paths;
- pattern evaluation, custom-glob annotations, and match diagnostics;
- post-filter name-collision resolution with winner/loser metadata;
- cross-root rule-target ambiguity detection;
- minimal `skills`-array mutation; and
- atomic JSON-object persistence.

`extensions/embedded-server.ts` remains the loopback-only transport adapter and
adds two owner-authorized RPC commands:

- `list_skill_inventory { scope: "global" | "project" }`
- `set_skill_enabled { scope, target: { kind: "skill" | "group", id }, enabled }`

Both commands must be loopback-only through the existing WebSocket policy. The
mutation command rejects unknown IDs, invalid scope, untrusted projects, invalid
settings JSON, and non-object settings files. It serializes mutations per
settings path to avoid two browser actions overwriting each other.

After write, it builds and returns the new configuration inventory with
`runtimeRestartRequired: true`. The embedded server must not call `ctx.reload()`:
its retained event context is `ExtensionContext`, whose public API has no
`reload()` method. A future Pi-supported server-callable reload API may replace
this behavior, but is outside this feature's scope.

## Errors and Constraints

- Unreadable or malformed `SKILL.md` yields a per-item/root diagnostic rather
  than crashing the whole inventory.
- Invalid `settings.json` is not overwritten; show its path and parser error.
- Filesystem races are handled by read-validate-write plus re-inventory; a
  disappeared target returns a not-found error.
- Symlinked skills use canonical paths to avoid duplicate rows. Discovery must
  retain Pi's symlink, hidden-file, and ignore-file behavior.
- No raw settings editor is introduced. Users retain the existing Configuration
  editor for advanced/manual changes.
- No running Pi process automatically reloads. The success copy states that a
  new session or Pi-process restart is required; the page never reports a
  configuration mutation as immediately active.

## Verification

### Pure extension tests

Add deterministic fixture tests for:

- global Pi and `.agents` roots; trusted and untrusted project roots; ancestor
  stopping at the Git root;
- recursive `SKILL.md`, direct Pi root Markdown, nested-skill termination,
  hidden/node_modules exclusion, ignore rules, and symlinks;
- grouping by discovery-relative folder and canonical-path deduplication;
- frontmatter diagnostics and duplicate names at different paths;
- `!`, `+`, and `-` precedence, including the required `skills/<group>/**`
  resource-base prefix and mixed groups;
- per-root `.agents` bases, POSIX rule serialization, exact child paths, and
  idempotent generated-rule cleanup;
- effective name collisions in Pi precedence order (`project settings`,
  `project auto`, `user settings`, `user auto`), including a shadowed row;
- custom unprefixed glob entries shown read-only without mutation;
- exact group and individual mutations while preserving unrelated settings keys
  and user patterns;
- invalid JSON / non-object settings, atomic-write failures, unknown IDs, and
  disappearance races.

### Frontend tests

Add jsdom tests for three-tab navigation, global/project selection, grouped
provider-style card rendering, expanded/collapsed cards, all-on/all-off/mixed
switches, pending controls, server-inventory re-render after save, trust
warning, and inline failure display. Locale completeness tests must remain
green.

### Release checks

After JS/TS changes run:

```bash
bun run check
bun run build:extensions
bun run test
```

Update `ARCHITECTURE.md` in the same implementation change: add the Skills
Settings module, inventory transport, settings-file ownership, runtime-restart
requirement, ambiguity handling, and trust invariants to the appropriate
architecture and module-map sections.

Also perform a manual local smoke test in Settings with a known nested skill
folder: disable its group, force-enable one child, close and start a fresh Pi
session, and confirm the slash-command list changes only in that fresh runtime.

## Non-goals

- Editing SKILL.md content, installing skill packages, or creating skills
- Managing package-resource filters in this page
- Modifying arbitrary external skill roots not already configured in the scope
- Reloading resources in an already running Pi process or synchronizing
  configuration application across Pi processes
- Changing Pi's trust model or exposing Skills controls to LAN/mobile clients
