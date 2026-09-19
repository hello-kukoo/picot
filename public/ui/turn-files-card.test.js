// ABOUTME: Turn files card — frozen git badges/stats, collapse behavior,
// ABOUTME: deleted/unavailable rows, stats-unavailable marker, and its mount slot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { mountTurnFilesCard, renderTurnFilesCard } from "./turn-files-card.js";

const styleCss = readFileSync(join(process.cwd(), "public/style.css"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const WRITES = [
  { filePath: "src/app.js" },
  { filePath: "docs/new-guide.md" },
  { filePath: "public/ui/card.js" },
  { filePath: "old/gone.js" },
  { filePath: "elsewhere/outside.ts" },
];

function statsMap() {
  return new Map([
    ["src/app.js", { status: "modified", additions: 12, deletions: 3, additionsCapped: false }],
    [
      "docs/new-guide.md",
      { status: "untracked", additions: 247, deletions: 0, additionsCapped: false },
    ],
    ["public/ui/card.js", { status: "clean", additions: 0, deletions: 0, additionsCapped: false }],
    ["old/gone.js", { status: "deleted", additions: 0, deletions: 0, additionsCapped: false }],
    [
      "elsewhere/outside.ts",
      { status: "unavailable", additions: 0, deletions: 0, additionsCapped: false },
    ],
  ]);
}

describe("renderTurnFilesCard", () => {
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

  const mount = (options) => {
    const card = renderTurnFilesCard(options);
    document.getElementById("m").appendChild(card);
    return card;
  };

  test("collapsed by default; toggle expands and updates aria", () => {
    const card = mount({ writes: WRITES, statsByPath: statsMap() });
    const toggle = card.querySelector(".turn-files-toggle");

    expect(card.classList.contains("expanded")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The header counts rendered rows: the deleted file is not listed.
    expect(card.querySelectorAll(".turn-files-row")).toHaveLength(4);
    expect(card.querySelector(".turn-files-label").textContent).toContain("4");
    // The caliber note rides on the toggle title, not in the visible label.
    expect(toggle.title).toContain("HEAD");

    toggle.click();
    expect(card.classList.contains("expanded")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("rows carry badges and frozen stats; clean and unavailable rows align", () => {
    const card = mount({ writes: WRITES, statsByPath: statsMap() });
    const rows = [...card.querySelectorAll(".turn-files-row")];

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.dataset.path)).toEqual([
      "src/app.js",
      "docs/new-guide.md",
      "public/ui/card.js",
      "elsewhere/outside.ts",
    ]);

    expect(rows[0].querySelector(".turn-files-badge--modified").textContent).toBe("Modified");
    expect(rows[0].querySelector(".turn-files-stat--add").textContent).toBe("+12");
    expect(rows[0].querySelector(".turn-files-stat--del").textContent).toBe("-3");
    expect(rows[0].getAttribute("aria-label")).toContain("Modified");
    expect(rows[0].getAttribute("aria-label")).toContain("+12");

    // Untracked: whole-file line count as additions, no deletions span.
    expect(rows[1].querySelector(".turn-files-badge--untracked").textContent).toBe("Untracked");
    expect(rows[1].querySelector(".turn-files-stat--add").textContent).toBe("+247");
    expect(rows[1].querySelector(".turn-files-stat--del")).toBeNull();

    // Clean (committed since) and unavailable (outside the workspace) both
    // render as plain rows with the hidden spacer keeping the columns aligned.
    for (const row of [rows[2], rows[3]]) {
      expect(row.querySelector(".turn-files-badge--none")).not.toBeNull();
      expect(row.querySelector(".turn-files-stats")).toBeNull();
    }
  });

  test("capped untracked additions render as a lower bound", () => {
    const statsByPath = new Map([
      [
        "docs/new-guide.md",
        { status: "untracked", additions: 50000, deletions: 0, additionsCapped: true },
      ],
    ]);
    const card = mount({ writes: WRITES, statsByPath });
    const row = card.querySelector('.turn-files-row[data-path="docs/new-guide.md"]');

    expect(row.querySelector(".turn-files-stat--add").textContent).toBe("+≥50000");
    expect(row.getAttribute("aria-label")).toContain("+≥50000");
  });

  test("stats failure marks the header; history stays silent", () => {
    const failed = mount({ writes: WRITES, statsByPath: null, statsUnavailable: true });
    const note = failed.querySelector(".turn-files-note");
    expect(note).not.toBeNull();
    // The marker is readable while the card is collapsed.
    expect(failed.classList.contains("expanded")).toBe(false);
    expect(note.textContent).toContain("Stats unavailable");
    // With no stats there is nothing to filter: every write renders.
    expect(failed.querySelectorAll(".turn-files-row")).toHaveLength(WRITES.length);

    const history = mount({ writes: WRITES, statsByPath: null, history: true });
    expect(history.querySelector(".turn-files-note")).toBeNull();
    expect(history.querySelector(".turn-files-toggle").title).toContain("history");
  });

  test("all-deleted writes render nothing", () => {
    const statsByPath = new Map([
      ["src/app.js", { status: "deleted", additions: 0, deletions: 0, additionsCapped: false }],
    ]);
    expect(renderTurnFilesCard({ writes: [{ filePath: "src/app.js" }], statsByPath })).toBeNull();
  });

  test("empty and degenerate writes render nothing", () => {
    expect(renderTurnFilesCard({ writes: [] })).toBeNull();
    expect(renderTurnFilesCard({ writes: [{ filePath: "  " }] })).toBeNull();
    expect(renderTurnFilesCard({})).toBeNull();
  });

  test("mounts between the answer and its copy/timestamp toolbar", () => {
    const message = document.createElement("div");
    message.className = "message assistant";
    const content = document.createElement("div");
    content.className = "message-content";
    const actions = document.createElement("div");
    actions.className = "message-actions";
    message.append(content, actions);
    document.getElementById("m").appendChild(message);

    mountTurnFilesCard(message, renderTurnFilesCard({ writes: WRITES, statsByPath: statsMap() }));

    expect([...message.children].map((el) => el.className)).toEqual([
      "message-content",
      "turn-files-card",
      "message-actions",
    ]);
  });

  test("falls back to after the message when it carries no toolbar", () => {
    const message = document.createElement("div");
    message.className = "message assistant";
    const content = document.createElement("div");
    content.className = "message-content";
    message.appendChild(content);
    document.getElementById("m").appendChild(message);

    const card = renderTurnFilesCard({ writes: WRITES, statsByPath: statsMap() });
    mountTurnFilesCard(message, card);

    expect(message.nextElementSibling).toBe(card);
  });

  test("mounting nothing is a no-op", () => {
    const message = document.createElement("div");
    document.getElementById("m").appendChild(message);
    mountTurnFilesCard(message, null);
    expect(message.children).toHaveLength(0);
    expect(message.nextElementSibling).toBeNull();
  });

  test("expanded body scrolls instead of stretching the transcript", () => {
    const body = ruleBody(".turn-files-card.expanded .turn-files-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toMatch(/max-height:\s*\d+px/);
  });
});
