// ABOUTME: Renders `ctx.ui.custom()` overlays headlessly so they reach the Picot WebView.
// ABOUTME: pi's RPC mode stubs custom() out, which hangs any extension that awaits it.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi's RPC-mode UI context implements `custom()` as `async () => undefined`: the
// factory is never invoked and the caller's `done` callback never fires. An
// extension that wraps the call in `new Promise(resolve => ctx.ui.custom(...))`
// — pi-mcp-adapter's `/mcp` panel does exactly this — therefore blocks forever.
//
// Every extension shares one mutable UI context object (ExtensionRunner exposes
// it through a `get ui()` accessor), so replacing `custom` here makes the real
// implementation visible to extensions Picot does not own. We drive the
// component the way a terminal would: render it to lines, ship those to the
// WebView, and feed keystrokes back in through the `picot-custom-ui` command.
//
// The wire format rides `ctx.ui.notify(JSON)` and the frontend correlates by
// panel id, mirroring the `picot-config` data plane (see
// public/native/extensions/custom-ui-panel.js).
//
// The overlay is currently off: session_start panels (MCP, etc.) flash a TUI
// dialog in the GUI because Picot has no hidden-overlay equivalent. Leave
// `custom()` as Pi's RPC stub until that mapping is stable. Tests pass
// `{ enabled: true }` to exercise the implementation.

/** When false, `registerCustomUiBridge` is a no-op and `custom()` stays stubbed. */
export const CUSTOM_UI_OVERLAY_ENABLED = false;

const DEFAULT_WIDTH = 82;
const MIN_WIDTH = 20;
const MAX_WIDTH = 200;
/** ESC — the conventional "close this overlay" key for pi-tui components. */
const ESCAPE = String.fromCharCode(27);

/** Structural subset of pi-tui's `Component` that a custom overlay must satisfy. */
type OverlayComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
};

type CustomUiOptions = {
  overlay?: boolean;
  overlayOptions?: { width?: number } | (() => { width?: number } | undefined);
  onHandle?: (handle: unknown) => void;
};

type Panel = {
  id: string;
  component: OverlayComponent;
  width: number;
  settle: (result: unknown) => void;
};

function resolveWidth(options: CustomUiOptions | undefined): number {
  const raw =
    typeof options?.overlayOptions === "function"
      ? options.overlayOptions()
      : options?.overlayOptions;
  const width = raw?.width;
  if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/**
 * A no-op overlay handle for extensions that pass `onHandle`. Picot renders the
 * panel as a modal that is always visible and always focused while it is open,
 * so the visibility controls have nothing to toggle.
 */
function createOverlayHandle(close: () => void) {
  return {
    hide: close,
    setHidden: () => {},
    isHidden: () => false,
    focus: () => {},
    unfocus: () => {},
    isFocused: () => true,
  };
}

export function registerCustomUiBridge(pi: ExtensionAPI, options?: { enabled?: boolean }): void {
  if (!(options?.enabled ?? CUSTOM_UI_OVERLAY_ENABLED)) return;

  // Panels form a stack so a component that opens a nested overlay behaves the
  // way it would in the TUI: input goes to the topmost panel.
  const stack: Panel[] = [];
  let nextPanelId = 0;

  const top = (): Panel | undefined => stack[stack.length - 1];

  const emit = (ui: ExtensionContext["ui"], payload: Record<string, unknown>): void => {
    ui.notify(JSON.stringify({ __picotCustomUi: payload }), "info");
  };

  const renderPanel = (panel: Panel): string[] => {
    try {
      return panel.component.render(panel.width) ?? [];
    } catch (error) {
      return [`Failed to render panel: ${error instanceof Error ? error.message : String(error)}`];
    }
  };

  // Tracked by identity rather than a marker property: the RPC host rebuilds
  // the UI context on every session rebind, and a copied marker would make a
  // genuinely unpatched context look patched.
  const patched = new WeakSet<object>();

  const ensurePatched = (ctx: ExtensionContext): void => {
    const ui = ctx.ui;
    if (!ui || patched.has(ui)) return;
    patched.add(ui);

    ui.custom = (<T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => OverlayComponent | Promise<OverlayComponent>,
      options?: CustomUiOptions,
    ): Promise<T> => {
      const id = `panel-${++nextPanelId}`;
      const width = resolveWidth(options);

      return new Promise<T>((resolve) => {
        let panel: Panel | undefined;
        let settled = false;

        const settle = (result: unknown): void => {
          if (settled) return;
          settled = true;
          const index = stack.findIndex((entry) => entry.id === id);
          if (index >= 0) stack.splice(index, 1);
          try {
            panel?.component.dispose?.();
          } catch {
            // A failing dispose must not strand the awaiting extension.
          }
          emit(ui, { op: "close", id });
          const next = top();
          if (next) emit(ui, { op: "update", id: next.id, lines: renderPanel(next) });
          resolve(result as T);
        };

        const push = (): void => {
          if (settled || !panel) return;
          emit(ui, { op: "update", id, lines: renderPanel(panel) });
        };

        // Components only ever ask the host to re-render; everything else they
        // need (`matchesKey`, width helpers) they import from pi-tui directly.
        const tui = { requestRender: push };
        // Passing no keybindings manager makes components fall back to pi-tui's
        // stock arrow/enter bindings, which is what the WebView sends.
        const keybindings = undefined;

        let created: OverlayComponent | Promise<OverlayComponent>;
        try {
          created = factory(tui, ui.theme, keybindings, (result: T) => settle(result));
        } catch (error) {
          emit(ui, {
            op: "error",
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          settle(undefined);
          return;
        }

        void Promise.resolve(created)
          .then((component) => {
            if (settled) {
              // `done` fired synchronously inside the factory.
              component.dispose?.();
              return;
            }
            panel = { id, component, width, settle };
            stack.push(panel);
            options?.onHandle?.(createOverlayHandle(() => settle(undefined)));
            emit(ui, { op: "open", id, width, lines: renderPanel(panel) });
          })
          .catch((error) => {
            emit(ui, {
              op: "error",
              id,
              message: error instanceof Error ? error.message : String(error),
            });
            settle(undefined);
          });
      });
    }) as ExtensionContext["ui"]["custom"];
  };

  // Patch as early and as often as is cheap: `ensurePatched` is a single flag
  // check once the current UI context has been wrapped.
  pi.on("session_start", (_event, ctx) => ensurePatched(ctx));
  pi.on("input", (_event, ctx) => ensurePatched(ctx));
  pi.on("before_agent_start", (_event, ctx) => ensurePatched(ctx));

  // Abandoned panels would otherwise keep their caller blocked past shutdown.
  pi.on("session_shutdown", () => {
    for (const panel of [...stack].reverse()) panel.settle(undefined);
  });

  pi.registerCommand("picot-custom-ui", {
    description: "Picot internal: deliver input to a custom extension UI panel",
    handler: (rawArguments, ctx) => {
      ensurePatched(ctx);
      let request: { id?: string; data?: string; cancel?: boolean };
      try {
        request = JSON.parse(rawArguments) as typeof request;
      } catch {
        return;
      }
      const panel = request.id ? stack.find((entry) => entry.id === request.id) : top();
      if (!panel) return;

      // Cancelling goes through the component's own close key rather than
      // straight to `settle`. A component typically resolves its caller from
      // inside that handler (pi-mcp-adapter's panel calls `done()` there), and
      // force-settling would leave the caller's own promise pending forever.
      const data = request.cancel ? ESCAPE : request.data;
      if (typeof data !== "string" || !data) return;

      try {
        panel.component.handleInput?.(data);
      } catch (error) {
        emit(ctx.ui, {
          op: "error",
          id: panel.id,
          message: error instanceof Error ? error.message : String(error),
        });
        panel.settle(undefined);
        return;
      }

      // The keystroke may have closed the panel, in which case `settle` has
      // already emitted `close` and repainting would resurrect it.
      if (!stack.includes(panel)) return;
      if (request.cancel) {
        // The component ignored its close key; fall back to force-settling so
        // the panel does not become unclosable from the WebView.
        panel.settle(undefined);
        return;
      }
      // Components normally repaint through `tui.requestRender()`, but repaint
      // unconditionally so a component that mutates state without asking for a
      // render still shows the result of the keystroke.
      emit(ctx.ui, { op: "update", id: panel.id, lines: renderPanel(panel) });
    },
  });
}
