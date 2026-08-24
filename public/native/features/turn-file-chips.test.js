// ABOUTME: Tests per-turn written-file chips rendering and click routing.
// ABOUTME: Chips are pure DOM builders; app.js owns collection and mounting.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import englishMessages from "../../locales/en.json";
import { renderTurnFileChips } from "./turn-file-chips.js";

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
  );
  await initI18n();
});

describe("turn file chips", () => {
  it("renders nothing when the turn wrote no files", () => {
    expect(renderTurnFileChips([])).toBeNull();
    expect(renderTurnFileChips(null)).toBeNull();
    expect(renderTurnFileChips([{ filePath: "  " }])).toBeNull();
  });

  it("renders one labeled chip per written file", () => {
    const row = renderTurnFileChips([
      { filePath: "/ws/index.html" },
      { filePath: "/ws/src/app.js" },
    ]);
    expect(row.className).toBe("turn-file-chips");
    expect(row.querySelector(".turn-file-chips-label").textContent).toContain("2");
    const chips = [...row.querySelectorAll(".turn-file-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["index.html", "app.js"]);
    expect(chips[0].dataset.path).toBe("/ws/index.html");
    expect(chips[0].title).toBe("/ws/index.html");
    expect(chips[0].getAttribute("aria-label")).toContain("index.html");
  });

  it("keeps insertion order and does not deduplicate at render time", () => {
    const row = renderTurnFileChips([{ filePath: "/ws/a.js" }, { filePath: "/ws/a.js" }]);
    expect([...row.querySelectorAll(".turn-file-chip")]).toHaveLength(2);
  });
});
