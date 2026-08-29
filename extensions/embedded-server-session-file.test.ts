import { describe, expect, it } from "vitest";
import { decodeSessionRouteSegments } from "./embedded-server.ts";

// ABOUTME: Guards the /api/sessions/:dirName/:file route against path traversal.
// ABOUTME: The regex matches raw (still-encoded) path segments, so decoding must
// ABOUTME: happen afterwards and each decoded segment must stay a single path
// ABOUTME: component or the joined path could escape SESSIONS_DIR.

describe("decodeSessionRouteSegments", () => {
  it("decodes normal encoded segments", () => {
    expect(decodeSessionRouteSegments("My%20Docs", "session.jsonl")).toEqual({
      dirName: "My Docs",
      file: "session.jsonl",
    });
  });

  it("decodes unicode segments", () => {
    expect(decodeSessionRouteSegments("%E4%B8%AD%E6%96%87", "%E4%BC%9A.jsonl")).toEqual({
      dirName: "中文",
      file: "会.jsonl",
    });
  });

  it("rejects parent traversal in dirName", () => {
    expect(decodeSessionRouteSegments("..", "file.jsonl")).toBeNull();
    expect(decodeSessionRouteSegments("%2E%2E", "file.jsonl")).toBeNull();
    expect(decodeSessionRouteSegments("..%2F..%2Fagent", "file.jsonl")).toBeNull();
  });

  it("rejects parent traversal in file", () => {
    expect(decodeSessionRouteSegments("dir", "..")).toBeNull();
    expect(decodeSessionRouteSegments("dir", "..%2Fsecret.jsonl")).toBeNull();
  });

  it("rejects encoded separators inside segments", () => {
    expect(decodeSessionRouteSegments("a%2Fb", "file.jsonl")).toBeNull();
    expect(decodeSessionRouteSegments("a%5Cb", "file.jsonl")).toBeNull();
    expect(decodeSessionRouteSegments("dir", "a%2Fb")).toBeNull();
  });

  it("rejects malformed percent-encoding", () => {
    expect(decodeSessionRouteSegments("%ZZ", "file.jsonl")).toBeNull();
    expect(decodeSessionRouteSegments("dir", "%")).toBeNull();
  });
});
