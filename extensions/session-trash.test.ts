// ABOUTME: Tests for trash-first session file removal, mirroring Pi TUI semantics.
// ABOUTME: Covers trash success, trash-missing fallback to unlink, and double failure.
import { describe, expect, test, vi } from "vitest";
import { buildTrashArgs, removeSessionFileTrashFirst } from "./session-trash.js";

function makeDeps({
  trashResult = null,
  fileExists = () => true,
  unlinkImpl = async () => {},
}: {
  trashResult?: { status: number | null; error?: Error; stderr?: string } | null;
  fileExists?: (p: string) => boolean;
  unlinkImpl?: (p: string) => Promise<void>;
} = {}) {
  return {
    spawnTrash: vi.fn(() =>
      trashResult === null
        ? { status: null, error: new Error("spawn trash ENOENT") }
        : { status: trashResult.status, error: trashResult.error, stderr: trashResult.stderr },
    ),
    exists: vi.fn(fileExists),
    unlink: vi.fn(unlinkImpl),
  };
}

describe("removeSessionFileTrashFirst", () => {
  test("moves the file to trash when the trash CLI succeeds", async () => {
    const deps = makeDeps({ trashResult: { status: 0 } });
    const result = await removeSessionFileTrashFirst("/s/a.jsonl", deps);
    expect(result).toEqual({ ok: true, method: "trash" });
    expect(deps.spawnTrash).toHaveBeenCalledWith("/s/a.jsonl");
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  test("treats trash as successful when the file is already gone afterwards", async () => {
    const deps = makeDeps({
      trashResult: { status: 1, stderr: "trash: something odd" },
      fileExists: () => false,
    });
    const result = await removeSessionFileTrashFirst("/s/a.jsonl", deps);
    expect(result).toEqual({ ok: true, method: "trash" });
    expect(deps.unlink).not.toHaveBeenCalled();
  });

  test("falls back to permanent unlink when trash is unavailable", async () => {
    const deps = makeDeps({ trashResult: null });
    const result = await removeSessionFileTrashFirst("/s/a.jsonl", deps);
    expect(result).toEqual({ ok: true, method: "unlink" });
    expect(deps.unlink).toHaveBeenCalledWith("/s/a.jsonl");
  });

  test("reports failure with the trash error hint when both trash and unlink fail", async () => {
    const deps = makeDeps({
      trashResult: { status: 1, stderr: "trash: permission denied" },
      unlinkImpl: async () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    const result = await removeSessionFileTrashFirst("/s/a.jsonl", deps);
    expect(result.ok).toBe(false);
    expect(result.method).toBe("unlink");
    expect(result.error).toContain("EPERM: operation not permitted");
    expect(result.error).toContain("trash: permission denied");
  });

  test("buildTrashArgs passes a leading-dash path after --", () => {
    expect(buildTrashArgs("-weird.jsonl")).toEqual(["--", "-weird.jsonl"]);
    expect(buildTrashArgs("/s/ok.jsonl")).toEqual(["/s/ok.jsonl"]);
  });
});
