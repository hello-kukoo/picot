# Terminal Display Settings Design

## Status

Implemented on 2026-09-04. Approved by Dr. Lin on 2026-09-04.

> 2026-09-04 update: this spec's localStorage contracts (fontSize 10–32,
> scrollback, smoothScroll, WebGL in per-origin localStorage on the General
> page) are superseded by
> `2026-09-04-appearance-settings-page-design.md` — every terminal display
> preference is now a global dual-track preference (cookie + DB) on the
> Appearance page, and `terminal-preferences.js` is deleted.

## Scope

Add three display-only terminal settings to Settings → General → Terminal:

- `fontSize`: terminal font size in pixels.
- `scrollbackLimit`: retained terminal scrollback rows.
- `smoothScrollDuration`: xterm.js scroll animation duration in milliseconds.

`bellStyle` is not implemented because xterm.js has no corresponding terminal
option. The old `smoothScroll` boolean name is not retained; the persisted key
matches xterm.js directly.

## Contract

| Key | Type | Range | Default | xterm.js option |
| --- | --- | --- | --- | --- |
| `fontSize` | integer | 10–32 | 15 | `fontSize` |
| `scrollbackLimit` | integer | 100–50,000 | 1,000 | `scrollback` |
| `smoothScrollDuration` | integer | 0–1,000 | 0 | `smoothScrollDuration` |

Invalid or out-of-range stored values are normalized on read by the UI. The
settings remain local display preferences and never cross the terminal broker
or enter the PTY environment.

## Runtime application

`TerminalTab.applyPreferences(prefs)` mutates xterm.js's live `options` object.
Font changes trigger the existing FitAddon; scrollback and smooth scrolling use
xterm.js's mutable option setters. Unknown keys and calls after destruction are
no-ops. The terminal is never recreated, so PTY state and output journals are
preserved.

New tabs receive the current normalized values at construction. Existing tabs
receive each setting change immediately.

## Verification

- Preference normalizers cover defaults, lower/upper bounds, and invalid input.
- TerminalTab tests cover all three option mappings, font refit, unknown keys,
  and destroyed-tab behavior.
- Frontend checks must pass with `bun run check`.
