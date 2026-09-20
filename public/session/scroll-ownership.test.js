import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createScrollOwner } from "./scroll-ownership.js";

function makeContainer({ scrollHeight = 2000, clientHeight = 500 } = {}) {
  const dom = new JSDOM("<div id='c'></div>");
  const container = dom.window.document.getElementById("c");
  Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(container, "scrollTop", { writable: true, value: 1500 });
  container.scrollTo = vi.fn(({ top } = {}) => {
    if (typeof top === "number") container.scrollTop = top;
  });
  const scroll = () => container.dispatchEvent(new dom.window.Event("scroll"));
  const wheel = () => container.dispatchEvent(new dom.window.WheelEvent("wheel"));
  return { dom, container, scroll, wheel };
}

describe("createScrollOwner", () => {
  let doms = [];
  beforeEach(() => {
    doms = [];
  });
  afterEach(() => {
    for (const d of doms) d.dom.window.close();
  });

  const track = (c) => {
    doms.push(c);
    return c;
  };

  test("follows by default; programmatic matching scroll keeps follow state", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    expect(owner.isFollowing()).toBe(true);
    expect(owner.scrollToBottom()).toBe(true); // scrollTop → 1500 (= 2000-500)
    c.scroll();
    expect(owner.isFollowing()).toBe(true);
  });

  test("a diverging scroll clears the token but never suspends follow", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    owner.noteProgrammatic(1500);
    c.container.scrollTop = 1200; // diverged (momentum/settling, no user intent)
    c.scroll();
    expect(owner.isFollowing()).toBe(true); // scroll alone never suspends
    // Token consumed: a later scroll event also changes nothing.
    c.scroll();
    expect(owner.isFollowing()).toBe(true);
  });

  test("a user wheel suspends following regardless of distance", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    c.wheel(); // user intent armed
    c.container.scrollTop = 300; // far from the bottom
    c.scroll();
    expect(owner.isFollowing()).toBe(false);
    expect(owner.scrollToBottom()).toBe(false); // suspended: no follow write
  });

  test("a scroll event with no user intent never suspends", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    // No wheel/touch/key/pointerdown: pure layout-driven scroll.
    c.container.scrollTop = 0;
    c.scroll();
    expect(owner.isFollowing()).toBe(true);
  });

  test("TTL expiry does not create user intent", () => {
    const c = track(makeContainer());
    let clock = 0;
    const owner = createScrollOwner({ container: c.container, now: () => clock });

    c.wheel(); // user intent at t=0
    clock = 601; // intent window expired
    c.container.scrollTop = 100;
    c.scroll();
    expect(owner.isFollowing()).toBe(true); // expired intent: no state change
  });

  test("re-arms when a user-caused scroll returns under the threshold", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    c.wheel();
    c.container.scrollTop = 300;
    c.scroll();
    expect(owner.isFollowing()).toBe(false);

    // The user scrolls back to (near) the bottom: 1500 = bottom here.
    c.wheel();
    c.container.scrollTop = 1480; // 20px from the bottom (< 100 threshold)
    c.scroll();
    expect(owner.isFollowing()).toBe(true);
  });

  test("a jump suspends following so the next streamed chunk cannot cancel it", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    owner.scrollTo(100, { smooth: false });

    expect(owner.isFollowing()).toBe(false);
    // This is the regression: a chunk arriving right after the jump must not
    // drag the viewport back to the bottom.
    expect(owner.scrollToBottom()).toBe(false);
    expect(c.container.scrollTop).toBe(100);

    // The scroll-to-bottom control still re-arms following.
    expect(owner.followBottom()).toBe(true);
    expect(owner.isFollowing()).toBe(true);
  });

  test("suspendFollow stops following without moving the viewport", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    owner.suspendFollow();

    expect(owner.isFollowing()).toBe(false);
    expect(c.container.scrollTop).toBe(1500);
    expect(owner.scrollToBottom()).toBe(false);
  });

  test("followBottom re-arms unconditionally (scroll-to-bottom control)", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    c.wheel();
    c.container.scrollTop = 100;
    c.scroll();
    expect(owner.isFollowing()).toBe(false);

    expect(owner.followBottom()).toBe(true);
    expect(owner.isFollowing()).toBe(true);
  });

  test("isUserScrollEvent is true only for input-initiated scrolls", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });

    expect(owner.isUserScrollEvent()).toBe(false);
    c.wheel();
    expect(owner.isUserScrollEvent()).toBe(true);

    // A programmatic write masks the intent while its token is live.
    owner.noteProgrammatic(1500);
    expect(owner.isUserScrollEvent()).toBe(false);
  });

  test("onUserIntent observers receive wheel and touchstart", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });
    const seen = vi.fn();
    const off = owner.onUserIntent(seen);

    c.wheel();
    expect(seen).toHaveBeenCalledOnce();
    c.container.dispatchEvent(new c.dom.window.Event("touchstart"));
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    c.wheel();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test("destroy removes every listener", () => {
    const c = track(makeContainer());
    const owner = createScrollOwner({ container: c.container, now: () => 0 });
    owner.destroy();
    c.wheel();
    c.container.scrollTop = 0;
    c.scroll();
    expect(owner.isFollowing()).toBe(true); // no listener ran
  });
});
