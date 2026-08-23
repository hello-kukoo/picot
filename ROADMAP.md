# Picot Roadmap

Ideas and planned features. Nothing here is committed — just captured so it doesn't get lost.

---

## Shipped

### Session Name Display & Rename in Sidebar

Picot uses Pi's no-argument `SessionManager.listAll()` names, preserves the existing catalog policy, exposes a loopback-only managed-session rename endpoint, and provides target-aware rename controls across sidebar row variants. See [`docs/superpowers/specs/2026-07-26-session-rename-design.md`](docs/superpowers/specs/2026-07-26-session-rename-design.md) for the persisted contract and validation boundaries.

### File Preview Panel

Context-aware split pane for files the agent and the user are working on.

Shipped:

- Code → syntax-highlighted CodeMirror viewer (editable text)
- Images → preview (PNG, SVG, generated images)
- Markdown → rendered preview and source edit
- HTML → sandboxed live iframe preview (hot-reloads on agent writes); source edit via CodeMirror
- PDF → PDF.js
- Office / email → read-only MarkItDown conversion
- Git diffs in the same panel
- Desktop split pane (preview up to ~70% width, enlarge / collapse)
- Mobile full-screen overlay
- Open from the file browser, Git panel, and clickable file paths on tool cards
- Auto-show / refresh when the agent writes or edits a file

---

## In Progress

_(nothing queued right now)_

---

## Low-Hanging Fruit

_(nothing queued right now — see Bigger Ideas below)_

---

## Bigger Ideas

### Agent Teams (bundled)

Ship a subagent/team extension as part of Picot. Spawn agent teams from the web UI, visual grouping in sidebar, team status overview, live-switch between agents. Based on Pi's subagent pattern but tightly integrated.

Not the same as Agent Inbox / Super Agent, which dispatches incoming Telegram work into a pinned session.

### Session Templates

Start a new session pre-loaded with context for a specific project. Each with its own CLAUDE.md, working directory, and maybe a starter prompt.

### Multi-Model A/B Testing

Send the same prompt to two models side by side and compare responses. Split view with both responses streaming.

---

## Out of scope

### memoryd Dashboard

Standalone viewer for memoryd memory files. Was previously built into Picot, stripped out to keep the core lean. The viewer code is saved at `~/Desktop/memoryd-viewer/`. Now being integrated into the native macOS memoryd menu bar app — not a Picot feature.
