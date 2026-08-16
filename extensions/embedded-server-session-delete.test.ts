// ABOUTME: Tests for the delete-batch deletion planner.
// ABOUTME: Verifies live-instance rejection, containment validation, and unlink failures.
import { describe, expect, test, vi } from "vitest";
import { applySessionDeletions } from "./embedded-server.js";
import { removeSessionFileTrashFirst } from "./session-trash.js";

const SESSIONS_DIR = "/sessions";

describe("applySessionDeletions", () => {
  test("rejects a path held by a running instance without unlinking", async () => {
    const unlink = vi.fn(async () => {});
    const result = await applySessionDeletions([`${SESSIONS_DIR}/live.jsonl`], {
      sessionsDir: SESSIONS_DIR,
      runningInstances: [{ sessionFile: `${SESSIONS_DIR}/live.jsonl` }],
      removeFile: unlink,
    });
    expect(result.running).toEqual([`${SESSIONS_DIR}/live.jsonl`]);
    expect(result.deleted).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });

  test("deletes a non-live valid session and notifies onRemoved", async () => {
    const unlink = vi.fn(async () => {});
    const onRemoved = vi.fn();
    const result = await applySessionDeletions([`${SESSIONS_DIR}/old.jsonl`], {
      sessionsDir: SESSIONS_DIR,
      runningInstances: [],
      removeFile: unlink,
      onRemoved,
    });
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.running).toEqual([]);
    expect(unlink).toHaveBeenCalledWith(`${SESSIONS_DIR}/old.jsonl`);
    expect(onRemoved).toHaveBeenCalledWith(`${SESSIONS_DIR}/old.jsonl`);
  });

  test("pushes invalid or outside-tree paths to errors and skips unlink", async () => {
    const unlink = vi.fn(async () => {});
    const result = await applySessionDeletions(
      [`${SESSIONS_DIR}/a.txt`, "/etc/passwd", `${SESSIONS_DIR}/ok.jsonl`],
      { sessionsDir: SESSIONS_DIR, runningInstances: [], removeFile: unlink },
    );
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([`${SESSIONS_DIR}/a.txt`, "/etc/passwd"]);
  });

  test("records unlink failures in errors", async () => {
    const unlink = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const result = await applySessionDeletions([`${SESSIONS_DIR}/gone.jsonl`], {
      sessionsDir: SESSIONS_DIR,
      runningInstances: [],
      removeFile: unlink,
    });
    expect(result.deleted).toBe(0);
    expect(result.errors).toEqual([`${SESSIONS_DIR}/gone.jsonl`]);
  });

  test("rejects non-array input", async () => {
    const unlink = vi.fn(async () => {});
    await expect(
      applySessionDeletions("nope", {
        sessionsDir: SESSIONS_DIR,
        runningInstances: [],
        removeFile: unlink,
      }),
    ).rejects.toThrow();
  });

  test("removeSessionFileTrashFirst fits the removeFile contract", async () => {
    // The route binds `removeFile: removeSessionFileTrashFirst` and wraps it so
    // a failed removal rejects (counted in `errors`); a successful one resolves.
    await expect(
      removeSessionFileTrashFirst(`${SESSIONS_DIR}/a.jsonl`, {
        spawnTrash: () => ({ status: 0 }),
        exists: () => true,
        unlink: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      removeSessionFileTrashFirst(`${SESSIONS_DIR}/b.jsonl`, {
        spawnTrash: () => ({ status: 1, stderr: "trash: denied" }),
        exists: () => true,
        unlink: async () => {
          throw new Error("EPERM");
        },
      }),
    ).resolves.toMatchObject({ ok: false, method: "unlink" });
  });
});
