// ABOUTME: Tests for the shared session-row DOM builder.
// ABOUTME: Covers action visibility, disabled delete, state classes, and XSS-safe titles.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { JSDOM } from "jsdom";
import { buildSessionItem, formatSessionTime } from "./build-session-item.js";

function fakeIcon(kind) {
  const span = document.createElement("span");
  span.dataset.icon = kind;
  return span;
}

function makeSession(overrides = {}) {
  return { filePath: "/sessions/a.jsonl", name: "Hello world", ...overrides };
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
});

describe("formatSessionTime", () => {
  const now = Date.now();
  const at = (msAgo) => new Date(now - msAgo).toISOString();

  test("maps elapsed time to the right label branch", () => {
    expect(formatSessionTime(at(0))).toBe("sidebar.justNow");
    expect(formatSessionTime(at(30 * 1000))).toBe("sidebar.justNow");
    expect(formatSessionTime(at(5 * 60 * 1000))).toBe("sidebar.minutesAgo");
    expect(formatSessionTime(at(2 * 3600 * 1000))).toBe("sidebar.hoursAgo");
    expect(formatSessionTime(at(24 * 3600 * 1000))).toBe("sidebar.yesterday");
  });

  test("falls back to a localized date for older sessions", () => {
    const weekday = formatSessionTime(at(3 * 86400000));
    expect(weekday).toBeTruthy();
    expect(weekday).not.toBe("");
    expect(weekday).not.toMatch(/^sidebar\./);
    const monthDay = formatSessionTime(at(30 * 86400000));
    expect(monthDay).toBeTruthy();
    expect(monthDay).not.toBe("");
    expect(monthDay).not.toMatch(/^sidebar\./);
  });

  test("returns empty for an invalid timestamp", () => {
    expect(formatSessionTime("not-a-date")).toBe("");
    expect(formatSessionTime(undefined)).toBe("");
  });
});

describe("buildSessionItem action visibility", () => {
  test("normal row exposes delete but not pin", () => {
    const item = buildSessionItem({
      session: makeSession(),
      showDeleteButton: true,
      createIcon: fakeIcon,
    });
    expect(item.querySelector(".session-pin-btn")).toBeNull();
    expect(item.querySelector(".session-delete-btn")).toBeTruthy();
  });

  test("focus options expose neither pin nor delete", () => {
    const item = buildSessionItem({
      session: makeSession(),
      showPinButton: false,
      showDeleteButton: false,
      createIcon: fakeIcon,
    });
    expect(item.querySelector(".session-pin-btn")).toBeNull();
    expect(item.querySelector(".session-delete-btn")).toBeNull();
  });

  test("delete options expose only delete", () => {
    const item = buildSessionItem({
      session: makeSession(),
      showPinButton: false,
      showDeleteButton: true,
      createIcon: fakeIcon,
    });
    expect(item.querySelector(".session-pin-btn")).toBeNull();
    const del = item.querySelector(".session-delete-btn");
    expect(del).toBeTruthy();
    expect(del.querySelector("[data-icon='trash-2']")).toBeTruthy();
  });
});

describe("buildSessionItem state and safety", () => {
  test("active/unread/streaming flags map to classes", () => {
    const item = buildSessionItem({
      session: makeSession(),
      isActive: true,
      isUnread: true,
      isStreaming: true,
      createIcon: fakeIcon,
    });
    expect(item.classList.contains("active")).toBe(true);
    expect(item.classList.contains("unread")).toBe(true);
    expect(item.classList.contains("streaming")).toBe(true);
  });

  test("title is rendered via textContent, never as HTML", () => {
    const item = buildSessionItem({
      session: makeSession({ name: "<img src=x onerror=alert(1)>" }),
      createIcon: fakeIcon,
    });
    const title = item.querySelector(".session-title");
    expect(title.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(title.querySelector("img")).toBeNull();
  });

  test("disabled delete button keeps reason and does not fire delete", () => {
    const onDelete = vi.fn();
    const item = buildSessionItem({
      session: makeSession(),
      showDeleteButton: true,
      deletionBlockedReason: "sidebar.deleteDisabledActive",
      onDelete,
      createIcon: fakeIcon,
    });
    const del = item.querySelector(".session-delete-btn");
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("sidebar.deleteDisabledActive");
    del.click();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("buildSessionItem callbacks", () => {
  test("row click fires onSelect with session and project", () => {
    const onSelect = vi.fn();
    const project = { path: "/work" };
    const session = makeSession();
    const item = buildSessionItem({ session, project, onSelect, createIcon: fakeIcon });
    item.click();
    expect(onSelect).toHaveBeenCalledWith(session, project);
  });
});
