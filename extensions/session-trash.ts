// ABOUTME: Removes a Pi session file via the `trash` CLI first (recoverable),
// ABOUTME: falling back to permanent unlink — the same policy as Pi TUI's deleteSessionFile.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

export type TrashRemovalResult = {
  ok: boolean;
  method: "trash" | "unlink";
  error?: string;
};

export type TrashRemovalDeps = {
  /** Runs the `trash` CLI; returns a SpawnSyncReturns-like status envelope. */
  spawnTrash: (sessionPath: string) => {
    status: number | null;
    error?: Error;
    stderr?: string;
  };
  exists: (sessionPath: string) => boolean;
  unlink: (sessionPath: string) => Promise<void>;
};

/**
 * Builds the argument vector for the `trash` CLI. A leading dash is passed
 * after `--` so a path like "-weird.jsonl" is not parsed as an option.
 */
export function buildTrashArgs(sessionPath: string): string[] {
  return sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
}

function buildDefaultDeps(): TrashRemovalDeps {
  return {
    spawnTrash: (sessionPath) =>
      spawnSync("trash", buildTrashArgs(sessionPath), { encoding: "utf-8" }),
    exists: (sessionPath) => existsSync(sessionPath),
    unlink: (sessionPath) => unlink(sessionPath),
  };
}

export async function removeSessionFileTrashFirst(
  sessionPath: string,
  deps: TrashRemovalDeps = buildDefaultDeps(),
): Promise<TrashRemovalResult> {
  const trashResult = deps.spawnTrash(sessionPath);
  const getTrashErrorHint = () => {
    const parts: string[] = [];
    if (trashResult.error) {
      parts.push(trashResult.error.message);
    }
    const stderr = trashResult.stderr?.trim();
    if (stderr) {
      parts.push(stderr.split("\n")[0] ?? stderr);
    }
    if (parts.length === 0) return null;
    return `trash: ${parts.join(" · ").slice(0, 200)}`;
  };

  // If trash reports success, or the file is gone afterwards, treat it as
  // successful — covers hosts where `trash` is absent (status null + ENOENT
  // error still leaves the file in place, so we only trust status 0 or the
  // file's disappearance).
  if (trashResult.status === 0 || !deps.exists(sessionPath)) {
    return { ok: true, method: "trash" };
  }

  try {
    await deps.unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err: unknown) {
    const unlinkError = err instanceof Error ? err.message : String(err);
    const trashErrorHint = getTrashErrorHint();
    const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
    return { ok: false, method: "unlink", error };
  }
}
