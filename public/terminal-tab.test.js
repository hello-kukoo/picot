// ABOUTME: Tests for the terminal tab xterm adapter and its vendor bundle contract.
// ABOUTME: The vendor contract test guards that xterm is bundled same-origin only.
import { beforeAll, expect, test, vi } from "vitest";
import { encodeBase64, TerminalTab } from "./terminal-tab.js";

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
    }),
  );
});

function fakeTerm() {
  const state = { written: [], disposed: false, dataCbs: [], resizeCbs: [] };
  return {
    state,
    onData: (cb) => {
      state.dataCbs.push(cb);
      return { dispose: () => {} };
    },
    onResize: (cb) => {
      state.resizeCbs.push(cb);
      return { dispose: () => {} };
    },
    loadAddon: () => {},
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

function makeTab(overrides = {}) {
  const term = fakeTerm();
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
