// ABOUTME: Tests for the terminal tab xterm adapter and its vendor bundle contract.
// ABOUTME: The vendor contract test guards that xterm is bundled same-origin only.
import { beforeAll, expect, test, vi } from "vitest";
import {
  encodeBase64,
  picotThemeToXterm,
  resolveTerminalTheme,
  TerminalTab,
} from "./terminal-tab.js";

// xterm probes a canvas 2D context during module load to detect renderer
// capabilities. jsdom does not implement getContext, which only emits a noisy
// not-implemented warning (the import still succeeds). Stub it before loading
// the bundle so the contract test output stays clean.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

test("terminal vendor bundle exposes only same-origin xterm constructors", async () => {
  await import("./vendor/xterm.js");
  expect(globalThis.PicotXterm).toEqual(
    expect.objectContaining({
      Terminal: expect.any(Function),
      FitAddon: expect.any(Function),
      SerializeAddon: expect.any(Function),
      SearchAddon: expect.any(Function),
      Unicode11Addon: expect.any(Function),
      WebglAddon: expect.any(Function),
    }),
  );
});

function fakeTerm() {
  const state = { written: [], disposed: false, dataCbs: [], resizeCbs: [], addons: [] };
  return {
    state,
    unicode: { activeVersion: "6" },
    onData: (cb) => {
      state.dataCbs.push(cb);
      return { dispose: () => {} };
    },
    onResize: (cb) => {
      state.resizeCbs.push(cb);
      return { dispose: () => {} };
    },
    loadAddon: (addon) => {
      state.addons.push(addon);
    },
    open: () => {},
    reset: () => {
      state.written.length = 0;
    },
    write: (b) => {
      state.written.push(b);
    },
    dispose: () => {
      state.disposed = true;
    },
    focus: () => {},
  };
}

function makeTab(overrides = {}, termOverrides = {}) {
  const term = fakeTerm();
  Object.assign(term, termOverrides);
  const tab = new TerminalTab({
    terminalId: "t1",
    generation: 1,
    container: null,
    terminalFactory: () => term,
    fitAddonFactory: () => ({ fit: () => {} }),
    serializeAddonFactory: () => ({ serialize: () => "" }),
    sendInput: () => {},
    sendResize: () => {},
    ...overrides,
  });
  return { tab, term };
}

test("waits for the terminal font before the first fit", async () => {
  let resolveFont;
  const fontReady = new Promise((resolve) => {
    resolveFont = resolve;
  });
  const fit = vi.fn();
  const { tab } = makeTab({
    fitAddonFactory: () => ({ fit }),
    loadFont: () => fontReady,
  });
  expect(fit).not.toHaveBeenCalled();
  resolveFont();
  await tab.ready;
  expect(fit).toHaveBeenCalledTimes(1);
  tab.destroy();
});

test("onData encodes input and sends with terminal id + generation", () => {
  const sent = [];
  const { tab, term } = makeTab({
    sendInput: (id, gen, b64) => sent.push([id, gen, b64]),
  });
  term.state.dataCbs[0]("ls\n");
  expect(sent).toEqual([["t1", 1, encodeBase64(new TextEncoder().encode("ls\n"))]]);
  tab.destroy();
});

test("writeSnapshot resets then writes; writeOutput appends", () => {
  const { tab, term } = makeTab();
  tab.writeSnapshot(btoa("snapshot-ansi"));
  tab.writeOutput(btoa("output-bytes"));
  expect(term.state.written.length).toBe(2);
  tab.destroy();
});

test("resize is debounced by 100ms and sends only the latest size", () => {
  vi.useFakeTimers();
  const resizes = [];
  const { tab, term } = makeTab({
    sendResize: (...args) => resizes.push(args),
  });
  term.state.resizeCbs[0]({ cols: 80, rows: 24 });
  term.state.resizeCbs[0]({ cols: 90, rows: 30 });
  expect(resizes.length).toBe(0);
  vi.advanceTimersByTime(100);
  expect(resizes).toEqual([["t1", 1, 90, 30]]);
  vi.useRealTimers();
  tab.destroy();
});

test("destroy is idempotent and disposes the terminal once", () => {
  const { tab, term } = makeTab();
  tab.destroy();
  tab.destroy();
  expect(term.state.disposed).toBe(true);
});

test("ack tracks the last applied sequence", () => {
  const { tab } = makeTab();
  tab.ack(42);
  expect(tab.lastAppliedSequence).toBe(42);
  tab.destroy();
});

test("applies display preferences to the live terminal and refits font changes", () => {
  const fit = vi.fn();
  const { tab, term } = makeTab({ fitAddonFactory: () => ({ fit }) });
  term.options = { fontSize: 15, scrollback: 1000, smoothScrollDuration: 0 };
  tab.applyPreferences({
    fontSize: 18,
    scrollback: 5000,
    smoothScrollDuration: 120,
  });

  expect(term.options).toMatchObject({
    fontSize: 18,
    scrollback: 5000,
    smoothScrollDuration: 120,
  });
  expect(fit).toHaveBeenCalledTimes(1);
  tab.destroy();
});

test("does not refit when only non-font preferences change", () => {
  const fit = vi.fn();
  const { tab, term } = makeTab({ fitAddonFactory: () => ({ fit }) });
  term.options = { fontSize: 15, scrollback: 1000, smoothScrollDuration: 0 };
  tab.applyPreferences({ scrollback: 5000, smoothScrollDuration: 120 });

  expect(term.options.scrollback).toBe(5000);
  expect(term.options.smoothScrollDuration).toBe(120);
  expect(fit).not.toHaveBeenCalled();
  tab.destroy();
});

test("ignores unknown preferences and destroyed tabs", () => {
  const { tab, term } = makeTab();
  term.options = { fontSize: 15 };
  tab.applyPreferences({ unknown: "ignored" });
  expect(term.options).toEqual({ fontSize: 15 });
  tab.destroy();
  expect(() => tab.applyPreferences({ fontSize: 20 })).not.toThrow();
  expect(term.options.fontSize).toBe(15);
});

test("serializes checkpoints and refreshes after a theme change", () => {
  const serialize = vi.fn(() => "checkpoint");
  const { tab, term } = makeTab({ serializeAddonFactory: () => ({ serialize }) });
  term.options = {};
  term.rows = 24;
  term.refresh = vi.fn();

  expect(tab.serializeForCheckpoint(123)).toBe("checkpoint");
  expect(serialize).toHaveBeenCalledWith({ scrollback: 123 });

  const theme = { background: "#123456" };
  tab.setTheme(theme);
  expect(term.options.theme).toBe(theme);
  expect(term.refresh).toHaveBeenCalledWith(0, 23);
  tab.destroy();
});

test("maps Picot CSS variables and a light theme to xterm colors", () => {
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.style.setProperty("--bg-solid", "#fefefe");
  document.documentElement.style.setProperty("--text-primary", "#101010");
  document.documentElement.style.setProperty("--bg-glass-active", "#dddddd");

  expect(picotThemeToXterm()).toMatchObject({
    background: "#fefefe",
    foreground: "#101010",
    cursor: "#101010",
    cursorAccent: "#fefefe",
    selection: "#dddddd",
    red: "#c72424",
  });
});

test("unicode11 addon loads and switches the active version", () => {
  const { tab, term } = makeTab({ unicode11AddonFactory: () => ({ id: "unicode11" }) });
  expect(term.state.addons.some((addon) => addon.id === "unicode11")).toBe(true);
  expect(term.unicode.activeVersion).toBe("11");
  tab.destroy();
});

test("without a unicode11 factory the default width provider stays active", () => {
  const { tab, term } = makeTab();
  expect(term.unicode.activeVersion).toBe("6");
  tab.destroy();
});

test("search delegates to the addon and reports misses", () => {
  const nextQueries = [];
  const prevQueries = [];
  const { tab } = makeTab({
    searchAddonFactory: () => ({
      findNext: (term) => {
        nextQueries.push(term);
        return true;
      },
      findPrevious: (term) => {
        prevQueries.push(term);
        return false;
      },
      clearActiveDecoration: () => {},
    }),
  });
  expect(tab.findNext("ls")).toBe(true);
  expect(tab.findPrevious("ls")).toBe(false);
  expect(nextQueries).toEqual(["ls"]);
  expect(prevQueries).toEqual(["ls"]);
  expect(() => tab.clearSearch()).not.toThrow();
  tab.destroy();
  // After destruction the find API is a safe no-op.
  expect(tab.findNext("ls")).toBe(false);
});

test("without a search addon the find API is a safe no-op", () => {
  const { tab } = makeTab();
  expect(tab.findNext("x")).toBe(false);
  expect(tab.findPrevious("x")).toBe(false);
  expect(() => tab.clearSearch()).not.toThrow();
  tab.destroy();
});

test("webgl addon loads after open and disposes with the tab", () => {
  const order = [];
  const webgl = {
    dispose: () => order.push("dispose-webgl"),
    onContextLoss: () => {},
  };
  const { tab } = makeTab(
    {
      container: {},
      webglAddonFactory: () => {
        order.push("factory");
        return webgl;
      },
    },
    {
      open: () => order.push("open"),
      dispose: () => order.push("dispose-terminal"),
    },
  );
  expect(order).toEqual(["open", "factory"]);
  expect(tab.webglAddon).toBe(webgl);
  tab.destroy();
  expect(order).toEqual(["open", "factory", "dispose-webgl", "dispose-terminal"]);
  expect(tab.webglAddon).toBeNull();
});

test("webgl context loss falls back to the DOM renderer", () => {
  let onContextLoss;
  const webgl = {
    dispose: vi.fn(),
    onContextLoss: (cb) => {
      onContextLoss = cb;
    },
  };
  const { tab, term } = makeTab({
    container: {},
    webglAddonFactory: () => webgl,
  });
  onContextLoss();
  expect(webgl.dispose).toHaveBeenCalledTimes(1);
  expect(tab.webglAddon).toBeNull();
  // The tab keeps working on the DOM renderer after the fallback.
  tab.writeOutput(btoa("still-alive"));
  expect(term.state.written.length).toBe(1);
  tab.destroy();
});

test("a failing webgl factory leaves the tab on the DOM renderer", () => {
  const { tab, term } = makeTab({
    container: {},
    webglAddonFactory: () => {
      throw new Error("no gpu");
    },
  });
  expect(tab.webglAddon).toBeNull();
  tab.writeOutput(btoa("ok"));
  expect(term.state.written.length).toBe(1);
  tab.destroy();
});

test("enableWebgl upgrades a DOM-rendered tab and disableWebgl drops it", () => {
  const webgl = { dispose: vi.fn(), onContextLoss: () => {} };
  const { tab } = makeTab({ container: {} });
  // No addon initially (no factory passed).
  expect(tab.webglAddon).toBeNull();
  expect(tab.enableWebgl(() => webgl)).toBe(true);
  expect(tab.webglAddon).toBe(webgl);
  // Already enabled: a second upgrade is a no-op.
  expect(tab.enableWebgl(() => webgl)).toBe(false);
  expect(tab.disableWebgl()).toBe(true);
  expect(webgl.dispose).toHaveBeenCalledTimes(1);
  expect(tab.webglAddon).toBeNull();
  // Nothing left to disable.
  expect(tab.disableWebgl()).toBe(false);
  tab.destroy();
});

test("enableWebgl keeps the DOM renderer when the factory fails", () => {
  const { tab, term } = makeTab({ container: {} });
  expect(
    tab.enableWebgl(() => {
      throw new Error("context lost");
    }),
  ).toBe(false);
  expect(tab.webglAddon).toBeNull();
  tab.writeOutput(btoa("dom"));
  expect(term.state.written.length).toBe(1);
  tab.destroy();
});

test("resolveTerminalTheme forces canonical palettes for light and dark", () => {
  const dark = resolveTerminalTheme("dark");
  expect(dark.background).toBe("#212121");
  expect(dark.red).toBe("#cd3131");
  const light = resolveTerminalTheme("light");
  expect(light.background).toBe("#ffffff");
  expect(light.red).toBe("#c72424");
});

test("resolveTerminalTheme falls back to the Picot theme for system/unknown", () => {
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.style.setProperty("--bg-solid", "#fefefe");
  document.documentElement.style.setProperty("--text-primary", "#101010");
  document.documentElement.style.setProperty("--bg-glass-active", "#dddddd");
  expect(resolveTerminalTheme("system")).toEqual(picotThemeToXterm());
  expect(resolveTerminalTheme("sepia")).toEqual(picotThemeToXterm());
  expect(resolveTerminalTheme(undefined)).toEqual(picotThemeToXterm());
});

test("initialTheme overrides the Picot theme at construction", () => {
  const forced = { background: "#101010", foreground: "#eeeeee" };
  const { tab, term } = makeTab({ initialTheme: forced }, { options: {} });
  expect(term.options.theme).toBe(forced);
  tab.destroy();
});

test("setTheme mirrors the background onto the xterm element", () => {
  const element = { style: {} };
  const forced = { background: "#212121", foreground: "#eeeeee" };
  const { tab, term } = makeTab({ initialTheme: forced }, { options: {}, element });
  expect(element.style.backgroundColor).toBe("#212121");
  const next = { ...forced, background: "#ffffff" };
  term.rows = 24;
  term.refresh = vi.fn();
  tab.setTheme(next);
  expect(element.style.backgroundColor).toBe("#ffffff");
  tab.destroy();
});
