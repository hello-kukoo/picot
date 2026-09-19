import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { createTurnSection } from "./turn.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

describe("createTurnSection", () => {
  let dom;

  beforeEach(async () => {
    dom = new JSDOM("<main id='m'></main>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  afterEach(() => {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.fetch;
  });

  test("section exposes status / rail / answer slots in order", () => {
    const turn = createTurnSection({ turnId: "t-42" });
    expect(turn.element.classList.contains("turn")).toBe(true);
    expect(turn.element.dataset.turnId).toBe("t-42");
    const slots = [...turn.element.children].map((el) => el.className);
    expect(slots[0]).toContain("turn-status");
    expect(slots[1]).toContain("turn-rail");
    expect(slots[2]).toContain("turn-answer");
    expect(turn.rail.host.classList.contains("process-details-body")).toBe(true);
  });

  test("a missing turnId allocates a local display id", () => {
    const a = createTurnSection({});
    const b = createTurnSection({});
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  test("claimUserElement moves an optimistic bubble into the user slot", () => {
    const main = document.getElementById("m");
    const bubble = document.createElement("div");
    bubble.className = "message user";
    main.appendChild(bubble);

    const turn = createTurnSection({ turnId: "t" });
    main.appendChild(turn.element);
    expect(turn.claimUserElement(bubble)).toBe(true);
    expect(turn.element.firstElementChild).toBe(bubble);
    // A disconnected element can never be claimed.
    expect(turn.claimUserElement(document.createElement("div"))).toBe(false);
  });

  test("status lifecycle: live label → settled label, spinner removed, timer cleared", () => {
    vi.useFakeTimers();
    try {
      const turn = createTurnSection({ turnId: "t", startedAt: Date.now() - 12000 });
      document.getElementById("m").appendChild(turn.element); // keep isConnected true
      turn.status.setLive();
      expect(turn.status.host.classList.contains("live")).toBe(true);
      const before = turn.status.host.querySelector(".turn-status-text").textContent;
      vi.advanceTimersByTime(1500);
      const after = turn.status.host.querySelector(".turn-status-text").textContent;
      expect(after).not.toBe(before); // elapsed ticks via the 1s interval

      turn.status.setSettled(12000);
      expect(turn.status.host.classList.contains("settled")).toBe(true);
      expect(turn.status.host.querySelector(".turn-status-text").textContent).toBe(
        "Worked for 12s",
      );
      expect(turn.status.host.querySelector(".turn-status-spinner")).toBeNull();
      // No interval survives settle.
      vi.advanceTimersByTime(5000);
      expect(turn.status.host.querySelector(".turn-status-text").textContent).toBe(
        "Worked for 12s",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("withStatus:false builds the history variant — no status row", () => {
    const turn = createTurnSection({ turnId: "h-1", withStatus: false });
    expect(turn.element.querySelector(".turn-status")).toBeNull();
    expect(turn.element.classList.contains("turn")).toBe(true);
    expect(turn.element.dataset.turnId).toBe("h-1");
    const slots = [...turn.element.children].map((el) => el.className);
    expect(slots[0]).toContain("turn-rail");
    expect(slots[1]).toContain("turn-answer");
    // Status API degrades to no-ops (history never calls it defensively).
    turn.status.setLive();
    turn.status.setSettled(1000);
    turn.status.destroy();
    expect(turn.element.querySelector(".turn-status")).toBeNull();
  });

  test("withStatus:false still claims a user bubble before the rail", () => {
    const main = document.getElementById("m");
    const bubble = document.createElement("div");
    bubble.className = "message user";
    main.appendChild(bubble);
    const turn = createTurnSection({ turnId: "h-2", withStatus: false });
    main.appendChild(turn.element);
    expect(turn.claimUserElement(bubble)).toBe(true);
    expect(turn.element.firstElementChild).toBe(bubble);
    expect(turn.element.children[1].classList.contains("turn-rail")).toBe(true);
  });

  test("rail disclosure toggles and the label writes through", () => {
    const turn = createTurnSection({ turnId: "t" });
    expect(turn.rail.wrapper.classList.contains("expanded")).toBe(true);
    turn.rail.setDisclosure(false);
    expect(turn.rail.wrapper.classList.contains("expanded")).toBe(false);
    turn.rail.setLabel("Process details · 2 steps");
    expect(turn.rail.wrapper.querySelector(".process-details-label").textContent).toBe(
      "Process details · 2 steps",
    );
  });
});
