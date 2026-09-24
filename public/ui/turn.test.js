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

  test("section exposes rail / card / answer / status slots in order", () => {
    const turn = createTurnSection({ turnId: "t-42" });
    expect(turn.element.classList.contains("turn")).toBe(true);
    expect(turn.element.dataset.turnId).toBe("t-42");
    const slots = [...turn.element.children].map((el) => el.className);
    expect(slots[0]).toContain("turn-rail");
    expect(slots[1]).toContain("turn-answer");
    expect(slots[2]).toContain("turn-status");
    // The card slot is the turn's last element: a blocking prompt (safety
    // guard approval, ask-user-question) reads as the newest item of the
    // turn's stream, after the answer and its footer.
    expect(slots[3]).toContain("turn-card-slot");
    expect(turn.card.host.classList.contains("hidden")).toBe(true);
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
    // A DETACHED element is claimed too: the history fold gate builds revealed
    // turns inside a DocumentFragment, so requiring attachment would leave those
    // bubbles below their own answer.
    const detachedHost = document.createElement("div");
    const fragmentTurn = createTurnSection({ turnId: "t-fragment", withStatus: false });
    detachedHost.appendChild(fragmentTurn.element);
    const detachedBubble = document.createElement("div");
    detachedBubble.className = "message user";
    fragmentTurn.element.appendChild(detachedBubble);
    expect(detachedBubble.isConnected).toBe(false);
    expect(fragmentTurn.claimUserElement(detachedBubble)).toBe(true);
    expect(fragmentTurn.element.firstElementChild).toBe(detachedBubble);

    // Non-elements are still refused.
    expect(turn.claimUserElement(document.createTextNode("nope"))).toBe(false);
    expect(turn.claimUserElement(null)).toBe(false);
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

  test("settled duration merges into the answer toolbar and drops the status row", () => {
    const turn = createTurnSection({ turnId: "t-merge", startedAt: Date.now() });
    document.getElementById("m").appendChild(turn.element);
    turn.status.setLive();
    // Only the last assistant element carries a toolbar (demoted rail rows
    // have theirs stripped), so the merge target is the answer slot's own.
    const message = document.createElement("div");
    message.className = "message assistant";
    const actions = document.createElement("div");
    actions.className = "message-actions";
    message.appendChild(actions);
    turn.answer.host.appendChild(message);

    turn.status.setSettled(12000);

    expect(actions.lastElementChild.classList.contains("turn-duration")).toBe(true);
    expect(actions.lastElementChild.textContent).toBe("Worked for 12s");
    // One meta line: the standalone status row is gone, and with it removed
    // only the (empty, hidden) card slot follows the answer.
    expect(turn.element.querySelector(".turn-status")).toBeNull();
    expect(turn.element.lastElementChild.classList.contains("turn-card-slot")).toBe(true);
    expect(turn.answer.host.nextElementSibling).toBe(turn.card.host);
  });
  test("withStatus:false builds the history variant — no status row", () => {
    const turn = createTurnSection({ turnId: "h-1", withStatus: false });
    expect(turn.element.querySelector(".turn-status")).toBeNull();
    expect(turn.element.classList.contains("turn")).toBe(true);
    expect(turn.element.dataset.turnId).toBe("h-1");
    const slots = [...turn.element.children].map((el) => el.className);
    expect(slots[0]).toContain("turn-rail");
    expect(slots[1]).toContain("turn-answer");
    // No inline-card slot on the history variant: nothing to rebuild it from.
    expect(turn.card.host).toBeNull();
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
