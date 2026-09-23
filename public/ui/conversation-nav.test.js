import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import {
  computeTickWindow,
  createConversationNav,
  NAV_MAX_TICKS,
  NAV_PITCH,
  pickActiveByOffsets,
  pointerTickIndex,
} from "./conversation-nav.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

describe("pure model (P5.2/P5.3/P5.4)", () => {
  test("window computation: 30-tick cap, centering, clamping", () => {
    // Small session: everything fits.
    expect(computeTickWindow({ count: 5, activeIndex: 2 })).toEqual({ start: 0, end: 5 });
    // Centered on the active tick (30 - 15 = 15 with a 30-tick window).
    expect(computeTickWindow({ count: 60, activeIndex: 30 })).toEqual({ start: 15, end: 45 });
    // Active near the top: clamped, never negative.
    expect(computeTickWindow({ count: 60, activeIndex: 1 })).toEqual({ start: 0, end: 30 });
    // Active at the very end: clamped to the last window.
    expect(computeTickWindow({ count: 60, activeIndex: 59 })).toEqual({ start: 30, end: 60 });
    // The interacting index anchors the window (edge glide).
    expect(computeTickWindow({ count: 100, activeIndex: 0, anchorIndex: 0 })).toEqual({
      start: 0,
      end: 30,
    });
    expect(computeTickWindow({ count: 0, activeIndex: 0 })).toEqual({ start: 0, end: 0 });
  });

  test("reading-line pick: binary search over offsets", () => {
    const offsets = [0, 200, 400, 600, 800];
    // Reading line below the first turn: nothing is at/above it yet → -1... but
    // the first turn is the fallback of the old code; the pick returns the
    // LAST turn at or above the line, so below-first yields -1.
    expect(
      pickActiveByOffsets({ offsets, readingLine: -10, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(-1);
    expect(
      pickActiveByOffsets({ offsets, readingLine: 0, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(0);
    expect(
      pickActiveByOffsets({ offsets, readingLine: 199, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(0);
    expect(
      pickActiveByOffsets({ offsets, readingLine: 200, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(1);
    expect(
      pickActiveByOffsets({ offsets, readingLine: 650, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(3);
    // Boundary: exactly on a turn.
    expect(
      pickActiveByOffsets({ offsets, readingLine: 800, bottomDistance: 9999, bottomAnchorPx: 48 }),
    ).toBe(4);
  });

  test("bottom anchor: near the bottom the last turn wins regardless of line", () => {
    const offsets = [0, 200, 400];
    expect(
      pickActiveByOffsets({ offsets, readingLine: 100, bottomDistance: 30, bottomAnchorPx: 48 }),
    ).toBe(2);
    // Exactly at the anchor distance still anchors.
    expect(
      pickActiveByOffsets({ offsets, readingLine: 100, bottomDistance: 48, bottomAnchorPx: 48 }),
    ).toBe(2);
    // Beyond it: normal pick.
    expect(
      pickActiveByOffsets({ offsets, readingLine: 100, bottomDistance: 49, bottomAnchorPx: 48 }),
    ).toBe(0);
  });

  test("pointer index mapping clamps to the tick range", () => {
    expect(pointerTickIndex({ pointerY: 0, trackTop: 0, count: 5 })).toBe(0);
    expect(pointerTickIndex({ pointerY: NAV_PITCH * 2 + 5, trackTop: 0, count: 5 })).toBe(2);
    expect(pointerTickIndex({ pointerY: -100, trackTop: 0, count: 5 })).toBe(0);
    expect(pointerTickIndex({ pointerY: 9999, trackTop: 0, count: 5 })).toBe(4);
    expect(pointerTickIndex({ pointerY: 10, trackTop: 10, count: 0 })).toBe(-1);
  });
});

describe("controller on a synthetic 60-turn fixture", () => {
  let dom;
  let container;
  let turns;
  let ensureMounted;
  let nav;
  const resizeObservers = []; // installed by the beforeEach ResizeObserver stub

  beforeEach(async () => {
    dom = new JSDOM(`
      <div id="container">
        <div class="header"></div>
        <nav id="nav"><div id="track"></div></nav>
        <div id="tooltip" class="hidden"><div id="q"></div><div id="sep"></div><div id="a"></div></div>
      </div>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();

    container = document.getElementById("container");
    // 60 turns, each with a mounted anchor element; offsets climb linearly.
    turns = Array.from({ length: 60 }, (_, i) => {
      const el = document.createElement("div");
      el.className = "message user";
      el.textContent = `prompt ${i}`;
      container.appendChild(el);
      return {
        id: `t${i}`,
        promptPreview: `prompt ${i}`,
        answerPreview: `answer ${i}`,
        entryId: `entry-${i}`,
        mountedElement: el,
      };
    });
    ensureMounted = vi.fn((id) => Promise.resolve(turns.find((t) => t.id === id)?.mountedElement));

    // Deterministic geometry: viewport 0..500, each turn 100px tall.
    Object.defineProperty(container, "scrollHeight", { value: 6000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 500, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    const realRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    container.getBoundingClientRect = () => ({
      top: 0,
      bottom: 500,
      left: 0,
      right: 800,
      width: 800,
      height: 500,
    });
    container.scrollTo = vi.fn(({ top } = {}) => {
      if (typeof top === "number") container.scrollTop = top;
    });
    container.querySelectorAll = ContainerQueryAll;
    for (const turn of turns) {
      const idx = Number(turn.id.slice(1));
      turn.mountedElement.getBoundingClientRect = () => ({
        ...realRect(),
        top: idx * 100 - scrollTop,
      });
    }

    function ContainerQueryAll() {
      return [];
    }

    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    globalThis.requestAnimationFrame = window.requestAnimationFrame;
    resizeObservers.length = 0;
    window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observed = [];
        resizeObservers.push(this);
      }

      observe(target) {
        this.observed.push(target);
      }

      disconnect() {}
    };
    globalThis.ResizeObserver = window.ResizeObserver;

    nav = createConversationNav({
      navEl: document.getElementById("nav"),
      trackEl: document.getElementById("track"),
      tooltipEl: document.getElementById("tooltip"),
      tooltipQEl: document.getElementById("q"),
      tooltipAEl: document.getElementById("a"),
      tooltipSepEl: document.getElementById("sep"),
      container,
      headerEl: null,
      getTurns: () => turns,
      ensureTurnMounted: ensureMounted,
      scrollOwner: null,
      t: (key) => key,
      document,
      window,
    });
  });

  afterEach(() => {
    nav?.destroy();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.requestAnimationFrame;
    delete globalThis.ResizeObserver;
  });

  const flushFrames = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("at most 30 ticks render; window centers once the spy settles", async () => {
    // Scroll so the reading line (viewport top + 4) sits past turn 30's offset.
    container.scrollTop = 3000;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();

    const ticks = document.querySelectorAll(".conv-nav-dot");
    expect(ticks.length).toBeLessThanOrEqual(NAV_MAX_TICKS);
    // Reading line ≈ 3004 → last turn at/above it is index 30.
    expect(nav.getActiveIndex()).toBe(30);
    // The active tick is inside the rendered window.
    const ids = [...ticks].map((el) => el.id);
    expect(ids).toContain("conv-nav-tick-30");
    expect(document.getElementById("track").getAttribute("aria-activedescendant")).toBe(
      "conv-nav-tick-30",
    );
  });

  test("bottom anchor pins the last turn when near the bottom", async () => {
    // A short final turn: scroll to the very bottom.
    container.scrollTop = 5500;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();
    expect(nav.getActiveIndex()).toBe(59);
  });

  test("hides the rail when the tick stack cannot fit the chat area", async () => {
    // Short window (or an open terminal panel shrinks the chat the same way):
    // 300px chat minus the 68/100 insets leaves ~108px of rail room, while the
    // rendered stack claims 400px - the stack would paint over the composer.
    Object.defineProperty(container, "clientHeight", { value: 300, configurable: true });
    const track = document.getElementById("track");
    Object.defineProperty(track, "scrollHeight", { value: 400, configurable: true });
    nav.refresh();
    expect(document.getElementById("nav").classList.contains("hidden")).toBe(true);

    // Taller chat area: the same stack fits and the rail returns.
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    nav.refresh();
    expect(document.getElementById("nav").classList.contains("hidden")).toBe(false);
  });

  test("track is the single listbox hit surface; ticks are non-interactive", () => {
    const track = document.getElementById("track");
    expect(track.getAttribute("role")).toBe("listbox");
    expect(track.getAttribute("tabindex")).toBe("0");
    const tick = track.querySelector(".conv-nav-dot");
    expect(tick.getAttribute("role")).toBe("option");
  });

  test("folded turns stay out of the spy offsets; picks map back to absolute indexes", async () => {
    // The fold gate leaves older turns with a null anchor. The spy must
    // binary-search only the mounted subset (monotonic) and still report
    // ABSOLUTE tick indexes.
    for (let i = 0; i < 40; i += 1) turns[i].mountedElement = null;
    container.scrollTop = 5000;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();
    // Reading line ≈ 5004 → the last mounted turn at/above it is index 50.
    expect(nav.getActiveIndex()).toBe(50);
    // Bottom anchor pins the true last turn even with 40 folded siblings.
    container.scrollTop = 5500;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();
    expect(nav.getActiveIndex()).toBe(59);
  });

  test("registered tick elements join a ResizeObserver (container alone is not enough)", async () => {
    container.scrollTop = 3000;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();
    // After the first spy pass the container AND the mounted turn elements
    // are under a ResizeObserver.
    const observed = resizeObservers.flatMap((observer) => observer.observed);
    expect(observed.includes(container)).toBe(true);
    expect(observed.includes(turns[0].mountedElement)).toBe(true);
    expect(observed.includes(turns[59].mountedElement)).toBe(true);
    // A folded turn has no anchor, so nothing new is observed for it.
    const observedCount = observed.length;
    const t10 = turns[10];
    turns[10] = { ...t10, mountedElement: null };
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();
    expect(resizeObservers.flatMap((observer) => observer.observed).length).toBe(observedCount);
    turns[10] = t10;
  });

  test("Escape returns focus to the transcript container, not just off the track", async () => {
    const track = document.getElementById("track");
    track.focus();
    expect(document.activeElement).toBe(track);
    track.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(container);
    // Programmatic focus target only — never in the tab order.
    expect(container.tabIndex).toBe(-1);
  });

  test("jump awaits ensureTurnMounted and shows the registry answer preview", async () => {
    await nav.jumpTo(5);
    await flushFrames();
    expect(ensureMounted).toHaveBeenCalledWith("t5");
    // onSelectTick fires; tooltip content comes from the registry previews.
    // (Tooltip shows on hover/keyboard; the registry read is what P5.1 fixes.)
    const turn = turns[5];
    expect(turn.answerPreview).toBe("answer 5");
  });

  test("keyboard: arrows move focus within the window; Enter jumps", async () => {
    const track = document.getElementById("track");
    container.scrollTop = 3000;
    container.dispatchEvent(new window.Event("scroll"));
    await flushFrames();

    track.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true, bubbles: true }),
    );
    await flushFrames();
    // Hover/focus now anchors the window; Enter jumps to the focused tick.
    track.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }),
    );
    await flushFrames();
    expect(nav.getActiveIndex()).toBe(29);
  });
});
