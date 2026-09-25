// ABOUTME: Unit tests for the history-gate auto-reveal scroll trigger
// ABOUTME: (spec: history gate scroll auto-load; Paseo's position rule).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AUTO_REVEAL_THRESHOLD_PX,
  disconnectGateAutoReveal,
  observeGateAutoReveal,
} from "./ui/history-gate-auto-reveal.js";

let rafQueue;

beforeEach(() => {
  rafQueue = [];
  globalThis.requestAnimationFrame = (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  };
});

afterEach(() => {
  disconnectGateAutoReveal();
  delete globalThis.requestAnimationFrame;
});

function flushRaf() {
  // One frame: run only the callbacks queued before it; continuations
  // queue up for the next frame.
  const frame = rafQueue.splice(0);
  for (const callback of frame) callback();
}

function makeScroller({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  document.body.appendChild(el);
  return el;
}

test("a scroll within the threshold reveals one batch", () => {
  const root = makeScroller({
    scrollTop: AUTO_REVEAL_THRESHOLD_PX - 10,
    scrollHeight: 3000,
    clientHeight: 800,
  });
  const reveal = vi.fn(() => 4);

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));

  expect(reveal).toHaveBeenCalledTimes(1);
});

test("a scroll beyond the threshold reveals nothing", () => {
  const root = makeScroller({
    scrollTop: AUTO_REVEAL_THRESHOLD_PX + 10,
    scrollHeight: 3000,
    clientHeight: 800,
  });
  const reveal = vi.fn(() => 4);

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));

  expect(reveal).not.toHaveBeenCalled();
});

test("the chain keeps filling while the scroller has not overflowed", () => {
  // A transcript shorter than the viewport cannot scroll: the batch itself
  // must keep arriving until the viewport fills (the reader sees a full
  // screen, not a stub with a gate above empty space).
  const root = makeScroller({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  let remaining = 6;
  const reveal = vi.fn(() => {
    remaining -= 2;
    return remaining;
  });

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1);

  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(2);
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(3);
  expect(remaining).toBe(0);

  // remaining <= 0 stops the chain: no further rAF continuation is queued.
  expect(rafQueue).toHaveLength(0);
});

test("the chain stops once the scroller overflows", () => {
  // The control is anchored at the transcript top and never leaves the
  // trigger zone after a batch — geometry, not visibility transitions,
  // decides when the fill chain comes to rest.
  const root = makeScroller({ scrollTop: 40, scrollHeight: 3000, clientHeight: 800 });
  const reveal = vi.fn(() => 4);

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1);

  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(1);
  expect(rafQueue).toHaveLength(0);
});

test("a second scroll arrival reveals another batch", () => {
  // The reader settles below the threshold (the insert settle), scrolls up
  // again, and the position rule fires again — no visibility transition
  // required.
  const root = makeScroller({ scrollTop: 0, scrollHeight: 3000, clientHeight: 800 });
  const reveal = vi.fn(() => 4);

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1);

  root.scrollTop = AUTO_REVEAL_THRESHOLD_PX + 32; // the settle
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1); // beyond the threshold: nothing

  root.scrollTop = 30; // the reader scrolls up again
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(2);
});

test("disconnect removes the scroll listener and cancels the chain", () => {
  const root = makeScroller({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const reveal = vi.fn(() => 4);

  observeGateAutoReveal(root, reveal);
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1);

  disconnectGateAutoReveal();
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(1);

  root.scrollTop = 10;
  root.dispatchEvent(new Event("scroll"));
  expect(reveal).toHaveBeenCalledTimes(1);
});

test("re-observing replaces the previous listener", () => {
  const first = makeScroller({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const second = makeScroller({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const revealFirst = vi.fn(() => 0);
  const revealSecond = vi.fn(() => 0);

  observeGateAutoReveal(first, revealFirst);
  observeGateAutoReveal(second, revealSecond);

  first.dispatchEvent(new Event("scroll"));
  expect(revealFirst).not.toHaveBeenCalled();

  second.dispatchEvent(new Event("scroll"));
  expect(revealSecond).toHaveBeenCalledTimes(1);
});
