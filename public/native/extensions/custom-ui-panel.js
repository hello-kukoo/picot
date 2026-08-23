// ABOUTME: Renders `ctx.ui.custom()` extension overlays bridged out of the pi process.
// ABOUTME: Uses xterm.js so the component's own ANSI output and keys work unchanged.

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_STACK,
} from "../../terminal-font.js";
import { picotThemeToXterm } from "../../terminal-tab.js";
import { onThemeChange } from "../../themes.js";

// The extension side (extensions/custom-ui-bridge.ts) drives a pi-tui component
// headlessly and ships its rendered lines here as `notify` payloads tagged with
// `__picotCustomUi`. Those lines are real terminal output — box drawing, SGR
// colour, cursor-free full repaints — so we hand them to an xterm.js instance
// rather than re-implementing an ANSI parser. xterm also gives us faithful key
// encoding: `onData` already produces exactly the byte sequences a pi-tui
// component expects from a terminal.

const DEFAULT_WIDTH = 82;
const MIN_ROWS = 3;
/** Home the cursor, then clear the screen, before painting a full frame. */
const HOME_AND_CLEAR = `${String.fromCharCode(27)}[H${String.fromCharCode(27)}[2J`;

export function consumeCustomUiFrame(panel, frame) {
  return Boolean(
    frame?.type === "runtime_event" &&
      frame.event?.type === "extension_ui_request" &&
      panel.consumeNotify(frame.event),
  );
}

export class CustomUiPanel {
  #runtime;
  #getTarget;
  #container;
  #host = null;
  #terminal = null;
  #dataDisposable = null;
  #themeDisposable = null;
  #panelId = null;
  #onError;
  #enabled;

  constructor({ runtime, getTarget, container = null, onError = () => {}, enabled = false }) {
    this.#runtime = runtime;
    this.#getTarget = getTarget;
    this.#container = container;
    this.#onError = onError;
    // Off by default: `ctx.ui.custom()` overlays are unstable in the GUI
    // (they flash on session start). Pass `{ enabled: true }` to exercise
    // the renderer; production app.js leaves this unset.
    this.#enabled = enabled === true;
  }

  get isOpen() {
    return this.#panelId !== null;
  }

  /**
   * Returns true when the notification carried a custom-UI frame, so callers
   * can keep it out of the chat transcript.
   */
  consumeNotify(request) {
    const message = request?.message;
    if (typeof message !== "string" || !message.includes("__picotCustomUi")) return false;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return false;
    }
    const frame = payload?.__picotCustomUi;
    if (!frame || typeof frame.op !== "string") return false;
    // Still consume the notify so JSON frames do not land in the transcript,
    // even while the overlay itself is disabled.
    if (!this.#enabled) return true;

    switch (frame.op) {
      case "open":
        this.#open(frame);
        break;
      case "update":
        // A stale update for a panel that has already closed must not reopen it.
        if (frame.id === this.#panelId) this.#paint(frame.lines);
        break;
      case "close":
        if (frame.id === this.#panelId) this.close({ notifyExtension: false });
        break;
      case "error":
        this.#onError(new Error(frame.message || "Extension panel failed"));
        if (frame.id === this.#panelId) this.close({ notifyExtension: false });
        break;
      default:
        break;
    }
    return true;
  }

  #open(frame) {
    // Only one panel is visible at a time; the extension side keeps the stack
    // and re-sends the panel underneath when the top one closes.
    if (this.#panelId) this.#teardown();
    this.#panelId = frame.id;

    const cols = Number.isFinite(frame.width) ? frame.width : DEFAULT_WIDTH;
    const rows = Math.max(MIN_ROWS, frame.lines?.length ?? MIN_ROWS);

    const overlay = document.createElement("div");
    // `ui-overlay` / `ui-dialog` carry the shared backdrop and frosted-panel
    // look from design-system.css; the local classes only add sizing.
    overlay.className = "ui-overlay custom-ui-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const surface = document.createElement("div");
    surface.className = "ui-dialog custom-ui-surface";
    const screen = document.createElement("div");
    screen.className = "custom-ui-screen";
    surface.appendChild(screen);
    overlay.appendChild(surface);
    (this.#container ?? document.body).appendChild(overlay);
    this.#host = overlay;

    // Clicking the backdrop asks the component to close via its own key, the
    // same path the panel's on-screen "esc" hint describes.
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) this.close();
    });

    const terminal = new globalThis.PicotXterm.Terminal({
      cols,
      rows,
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      fontWeight: 400,
      cursorStyle: "underline",
      cursorBlink: false,
      theme: picotThemeToXterm(),
      scrollback: 0,
    });
    terminal.open(screen);
    this.#terminal = terminal;
    this.#dataDisposable = terminal.onData((data) => this.#sendInput(data));
    this.#themeDisposable = onThemeChange(() => {
      if (this.#terminal?.options) this.#terminal.options.theme = picotThemeToXterm();
    });

    void loadTerminalFont({ family: TERMINAL_FONT_FAMILY, fontSize: DEFAULT_TERMINAL_FONT_SIZE })
      .catch(() => undefined)
      .then(() => this.#paint(frame.lines));

    this.#paint(frame.lines);
    terminal.focus();
  }

  #paint(lines) {
    const terminal = this.#terminal;
    if (!terminal || !Array.isArray(lines)) return;
    // Components always emit a full frame, so resize to fit and repaint rather
    // than tracking deltas. `\x1b[H` homes the cursor; `\x1b[2J` clears.
    const rows = Math.max(MIN_ROWS, lines.length);
    if (terminal.rows !== rows) terminal.resize(terminal.cols, rows);
    terminal.write(`${HOME_AND_CLEAR}${lines.join("\r\n")}`);
  }

  #sendInput(data) {
    const target = this.#getTarget();
    if (!target || !this.#panelId) return;
    const message = `/picot-custom-ui ${JSON.stringify({ id: this.#panelId, data })}`;
    this.#runtime
      .request({ type: "prompt", message }, target)
      .catch((error) => this.#onError(error));
  }

  /**
   * Close the panel. By default the extension is told to cancel, which feeds
   * the component its close key so the blocked caller actually resolves.
   */
  close({ notifyExtension = true } = {}) {
    if (!this.#panelId) return;
    const id = this.#panelId;
    const target = this.#getTarget();
    this.#teardown();
    if (!notifyExtension || !target) return;
    const message = `/picot-custom-ui ${JSON.stringify({ id, cancel: true })}`;
    this.#runtime.request({ type: "prompt", message }, target).catch(() => {});
  }

  #teardown() {
    this.#panelId = null;
    this.#dataDisposable?.dispose?.();
    this.#dataDisposable = null;
    this.#themeDisposable?.();
    this.#themeDisposable = null;
    this.#terminal?.dispose?.();
    this.#terminal = null;
    this.#host?.remove();
    this.#host = null;
  }
}
