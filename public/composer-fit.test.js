// @vitest-environment jsdom
// ABOUTME: Pins the composer fit stepper: hide on measured overflow, never on a
// ABOUTME: viewport breakpoint, and release only with slack so the row cannot flap.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_FIT_MAX_LEVEL,
  composerFitClasses,
  nextComposerFitLevel,
  setupComposerFit,
} from "./composer-fit.js";

describe("nextComposerFitLevel", () => {
  it("stays at level 0 while the row fits", () => {
    expect(nextComposerFitLevel({ current: 0, overflowPx: () => -40 })).toBe(0);
  });

  it("raises the level until the row stops overflowing", () => {
    // Levels 0-2 overflow; level 3 fits exactly.
    const overflowPx = (level) => (level < 3 ? 10 : 0);
    expect(nextComposerFitLevel({ current: 0, overflowPx })).toBe(3);
  });

  it("clamps at the last level when even the tightest row overflows", () => {
    expect(nextComposerFitLevel({ current: 0, overflowPx: () => 5 })).toBe(COMPOSER_FIT_MAX_LEVEL);
  });

  it("releases a level only when the tighter row keeps real slack", () => {
    // Level 2 fits with 3px spare — too tight to release.
    const tight = (level) => (level >= 2 ? -3 : 20);
    expect(nextComposerFitLevel({ current: 2, overflowPx: tight })).toBe(2);
    // Same level, but now with room to spare at level 1 as well.
    const roomy = (level) => (level >= 1 ? -30 : 20);
    expect(nextComposerFitLevel({ current: 2, overflowPx: roomy })).toBe(1);
  });

  it("releases through several levels in one call when the room is there", () => {
    const seen = [];
    const overflowPx = (level) => {
      seen.push(level);
      if (level === 5) return 10; // still tight at the level we are on
      if (level === 1) return 0; // no slack: 1 is as tight as it may get
      return -40;
    };
    expect(nextComposerFitLevel({ current: 5, overflowPx })).toBe(2);
    // 5 is tried first, then 4, 3, 2 are accepted and 1 is rejected.
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  it("settles on the fitting level in one call, measuring each step", () => {
    const seen = [];
    const overflowPx = (level) => {
      seen.push(level);
      return level < 5 ? 10 : 0;
    };
    expect(nextComposerFitLevel({ current: 0, overflowPx })).toBe(5);
    // Measured 0..5 walking up, then level 4 once for the release check.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 4]);
  });
});

describe("composerFitClasses", () => {
  it("is cumulative, so each level keeps the earlier hides", () => {
    const classes = composerFitClasses(3);
    expect(classes.has("composer-fit--hide-usage")).toBe(true);
    expect(classes.has("composer-fit--hide-toolbox")).toBe(true);
    expect(classes.has("composer-fit--hide-mic")).toBe(true);
    expect(classes.has("composer-fit--shrink-model")).toBe(false);
  });
});

describe("composer fit CSS contract", () => {
  it("never clips the toolbar, so the upward model dropdown survives", () => {
    const css = readFileSync(join(process.cwd(), "public", "style.css"), "utf8");
    const ruleBody = (selector) => {
      const start = css.indexOf(`${selector} {`);
      return start < 0 ? "" : css.slice(start, css.indexOf("}", start)).replace(/\s+/g, " ");
    };

    // Clipping this row cut the composer's model menu down to a sliver: it
    // opens upward (bottom: calc(100% + 6px)) out of the toolbar's box.
    expect(ruleBody(".composer-toolbar")).not.toContain("overflow: hidden");
    expect(ruleBody(".composer-toolbar .model-dropdown-menu")).toContain(
      "bottom: calc(100% + 6px)",
    );
  });
});

describe("setupComposerFit", () => {
  let card;
  let toolbar;
  let widths;

  /** Control widths for the live row, in DOM order. */
  const BASE = {
    "attach-btn": 34,
    "command-btn": 34,
    "session-usage": 120,
    "token-usage": 26,
    "model-dropdown": 130,
    "thinking-btn": 60,
    "mic-btn": 28,
    "send-btn": 32,
  };

  function buildRow() {
    document.body.replaceChildren();
    card = document.createElement("div");
    card.id = "composer-card";
    toolbar = document.createElement("div");
    toolbar.className = "composer-toolbar";
    const left = document.createElement("div");
    left.className = "composer-toolbar-left";
    const right = document.createElement("div");
    right.className = "composer-toolbar-right";
    for (const [id, parent] of [
      ["attach-btn", left],
      ["command-btn", left],
      ["session-usage", right],
      ["token-usage", right],
      ["model-dropdown", right],
      ["thinking-btn", right],
      ["mic-btn", right],
      ["send-btn", right],
    ]) {
      const el = document.createElement("button");
      el.id = id;
      parent.appendChild(el);
    }
    toolbar.append(left, right);
    card.appendChild(toolbar);
    document.body.appendChild(card);

    widths = { ...BASE };
    // Model label shrinks at its own level; hidden controls report zero, which
    // is what display:none does to offsetWidth in a real layout.
    const hiddenBy = {
      "session-usage": "composer-fit--hide-usage",
      "command-btn": "composer-fit--hide-toolbox",
      "mic-btn": "composer-fit--hide-mic",
    };
    for (const el of card.querySelectorAll("button")) {
      const id = el.id;
      Object.defineProperty(el, "offsetWidth", {
        configurable: true,
        get: () => {
          const hideClass = hiddenBy[id];
          if (hideClass && card.classList.contains(hideClass)) return 0;
          if (id === "model-dropdown" && card.classList.contains("composer-fit--shrink-model")) {
            return 116;
          }
          if (id === "thinking-btn" && card.classList.contains("composer-fit--hide-think-prefix")) {
            return 30; // the "思考"/"Think" prefix word drops out
          }
          return widths[id] ?? 0;
        },
      });
    }
  }

  function setAvailable(px) {
    Object.defineProperty(toolbar, "clientWidth", { configurable: true, get: () => px });
  }

  beforeEach(buildRow);

  it("hides only the aggregate cluster when that alone is enough", () => {
    setAvailable(400); // full row is 464; dropping the 120px cluster fits.
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(1);
    expect(card.classList.contains("composer-fit--hide-usage")).toBe(true);
    expect(card.classList.contains("composer-fit--hide-toolbox")).toBe(false);
    fit.destroy();
  });

  it("raises through the levels as the column keeps narrowing", () => {
    // 464 total: dropping the cluster (344) and the toolbox (310) is still too
    // wide for 300, so the mic goes as well (282).
    setAvailable(300);
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(3);
    expect(card.classList.contains("composer-fit--hide-usage")).toBe(true);
    expect(card.classList.contains("composer-fit--hide-toolbox")).toBe(true);
    expect(card.classList.contains("composer-fit--hide-mic")).toBe(true);
    expect(card.classList.contains("composer-fit--shrink-model")).toBe(false);
    fit.destroy();
  });

  it("reaches the tightest level only when even shrinking is not enough", () => {
    setAvailable(200); // 268 after the model shrinks; the thinking prefix must go.
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(COMPOSER_FIT_MAX_LEVEL);
    expect(card.classList.contains("composer-fit--shrink-model")).toBe(true);
    expect(card.classList.contains("composer-fit--hide-think-prefix")).toBe(true);
    fit.destroy();
  });

  it("releases the levels again when the column grows back", () => {
    // Regression: a scrollWidth-based probe reported 0 at best, so the row
    // ratcheted to the tightest level and stayed there after widening.
    setAvailable(300);
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(3);

    setAvailable(600);
    fit.sync();
    expect(fit.level).toBe(0);
    expect(card.className).toBe("");
    fit.destroy();
  });

  it("leaves every control visible when the row fits", () => {
    setAvailable(600);
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(0);
    expect(card.className).toBe("");
    fit.destroy();
  });

  it("does not pin a level from a zero-width measurement", () => {
    setAvailable(0);
    const fit = setupComposerFit({ card, toolbar, view: window });
    expect(fit.level).toBe(0);
    fit.destroy();
  });

  it("is inert without a card or toolbar", () => {
    expect(setupComposerFit({ card: null, toolbar: null }).level).toBe(0);
  });
});
