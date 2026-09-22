// ABOUTME: Unit tests for the history-gate auto-reveal IntersectionObserver
// ABOUTME: state machine (spec: history gate scroll auto-load).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AUTO_REVEAL_THRESHOLD_PX,
  disconnectGateAutoReveal,
  observeGateAutoReveal,
} from "./ui/history-gate-auto-reveal.js";

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = [];
    this.disconnected = false;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.observed.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  fire(isIntersecting, target = this.observed[0]) {
    this.callback([{ isIntersecting, target }]);
  }
}

let rafQueue;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  rafQueue = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  globalThis.requestAnimationFrame = (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  };
});

afterEach(() => {
  disconnectGateAutoReveal();
  vi.unstubAllGlobals();
  delete globalThis.requestAnimationFrame;
});

function flushRaf() {
  // One frame: run only the callbacks queued before it; continuations
  // queue up for the next frame.
  const frame = rafQueue.splice(0);
  for (const callback of frame) callback();
}

test("observes the gate control against the scroller with a top rootMargin", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  const root = document.createElement("div");

  observeGateAutoReveal(control, root, () => 0);

  const observer = FakeIntersectionObserver.instances.at(-1);
  expect(observer).toBeDefined();
  expect(observer.options.root).toBe(root);
  expect(observer.options.rootMargin).toBe(`${AUTO_REVEAL_THRESHOLD_PX}px 0px 0px 0px`);
  expect(observer.observed).toEqual([control]);
});

test("intersection reveals one batch and keeps filling the viewport while it stays intersecting", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  let remaining = 6;
  const reveal = vi.fn(() => {
    remaining -= 2;
    return remaining;
  });

  observeGateAutoReveal(control, document.body, reveal);
  const observer = FakeIntersectionObserver.instances.at(-1);

  observer.fire(true);
  expect(reveal).toHaveBeenCalledTimes(1);

  // Viewport still not filled: one rAF continuation per batch, serial.
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(2);
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(3);
  expect(remaining).toBe(0);

  // remaining <= 0 stops the chain: no further rAF continuation is queued.
  expect(rafQueue).toHaveLength(0);
});

test("chain stops when the control leaves the viewport", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  const reveal = vi.fn(() => 5);

  observeGateAutoReveal(control, document.body, reveal);
  const observer = FakeIntersectionObserver.instances.at(-1);

  observer.fire(true);
  observer.fire(false);
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(1);
});

test("chain stops when the control is disconnected from the DOM", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  const reveal = vi.fn(() => 5);

  observeGateAutoReveal(control, document.body, reveal);
  const observer = FakeIntersectionObserver.instances.at(-1);

  observer.fire(true);
  control.remove();
  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(1);
});

test("re-observing disconnects the previous observer", () => {
  const first = document.createElement("div");
  document.body.appendChild(first);

  observeGateAutoReveal(first, document.body, () => 0);
  const firstObserver = FakeIntersectionObserver.instances.at(-1);

  observeGateAutoReveal(document.createElement("div"), document.body, () => 0);
  expect(firstObserver.disconnected).toBe(true);
});

test("disconnect cancels the observer and any queued continuation", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  const reveal = vi.fn(() => 5);

  observeGateAutoReveal(control, document.body, reveal);
  const observer = FakeIntersectionObserver.instances.at(-1);

  observer.fire(true);
  disconnectGateAutoReveal();
  expect(observer.disconnected).toBe(true);

  flushRaf();
  expect(reveal).toHaveBeenCalledTimes(1);
});

test("a stale intersection callback from a replaced observer never reveals", () => {
  const control = document.createElement("div");
  document.body.appendChild(control);
  const reveal = vi.fn(() => 5);

  observeGateAutoReveal(control, document.body, reveal);
  const staleObserver = FakeIntersectionObserver.instances.at(-1);

  observeGateAutoReveal(control, document.body, reveal);
  staleObserver.fire(true);
  expect(reveal).not.toHaveBeenCalled();
});
