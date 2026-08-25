// ABOUTME: Verifies workspace-only Pin persistence and cross-window synchronization.
// ABOUTME: Session Pins are intentionally absent from this contract.
import { CookieJar, JSDOM } from "jsdom";
import { afterEach, describe, expect, test } from "vitest";
import {
  PINNED_ITEMS_COOKIE,
  pinWorkspace,
  readPinnedItems,
  reconcileWorkspaceId,
  resetPinnedItemsSync,
  samePinnedState,
  unpinWorkspace,
  writePinnedItems,
} from "./pinned-items.js";

function documentAt(port, cookieJar = new CookieJar()) {
  return new JSDOM("<!doctype html>", {
    cookieJar,
    url: `http://localhost:${port}`,
  }).window.document;
}

afterEach(() => resetPinnedItemsSync());

describe("workspace Pins", () => {
  test("normalizes workspace records and drops session data", () => {
    const doc = documentAt(3001);
    expect(
      writePinnedItems(
        {
          workspaces: [
            { id: "history:alpha", path: "/work/alpha" },
            { id: "history:alpha", path: "/work/duplicate" },
            { id: "invalid", path: "/work/invalid" },
          ],
          sessions: ["/work/session.jsonl"],
        },
        doc,
      ),
    ).toEqual({
      workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
    });
    expect(readPinnedItems(doc)).toEqual({
      workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
    });
  });

  test("pins and unpins workspaces", () => {
    const doc = documentAt(3001);
    pinWorkspace("history:alpha", "/work/alpha", doc);
    pinWorkspace("path:/work/beta", "/work/beta", doc);
    expect(readPinnedItems(doc).workspaces.map((item) => item.id)).toEqual([
      "path:/work/beta",
      "history:alpha",
    ]);
    unpinWorkspace("history:alpha", doc);
    expect(readPinnedItems(doc).workspaces).toEqual([
      { id: "path:/work/beta", path: "/work/beta" },
    ]);
  });

  test("reconciles provisional workspace identity", () => {
    const doc = documentAt(3001);
    pinWorkspace("path:/work/alpha", "/work/alpha", doc);
    reconcileWorkspaceId("path:/work/alpha", "history:alpha", doc);
    expect(readPinnedItems(doc).workspaces).toEqual([{ id: "history:alpha", path: "/work/alpha" }]);
  });

  test("reads legacy session cookie data without rendering it", () => {
    const doc = documentAt(3001);
    doc.cookie = `${PINNED_ITEMS_COOKIE}=${encodeURIComponent(
      JSON.stringify({
        workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
        sessions: ["/old/session.jsonl"],
      }),
    )}; Path=/`;
    expect(readPinnedItems(doc)).toEqual({
      workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
    });
  });

  test("compares workspace order and ignores removed session fields", () => {
    expect(
      samePinnedState(
        { workspaces: [{ id: "history:a", path: "/a" }], sessions: ["/a.jsonl"] },
        { workspaces: [{ id: "history:a", path: "/a" }] },
      ),
    ).toBe(true);
    expect(
      samePinnedState(
        { workspaces: [{ id: "history:a", path: "/a" }] },
        { workspaces: [{ id: "history:b", path: "/b" }] },
      ),
    ).toBe(false);
  });
});
