// ABOUTME: Verifies workspace-local storage for composer paste offloads.
// ABOUTME: Covers containment, self-ignore creation, deterministic names, and collision handling.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PASTE_OFFLOAD_MAX_BYTES, writePasteOffloadFile } from "./paste-offload.ts";

const temporaryRoots: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picot-paste-offload-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("writePasteOffloadFile", () => {
  it("writes into .pi/tmp and creates a self-ignoring directory", () => {
    const root = makeWorkspace();
    const result = writePasteOffloadFile(root, "hello\nworld", new Date(2026, 7, 21, 14, 32, 5));

    expect(result.relativePath).toBe(".pi/tmp/paste-20260821-143205.txt");
    expect(fs.readFileSync(result.absolutePath, "utf8")).toBe("hello\nworld");
    expect(fs.readFileSync(path.join(root, ".pi/tmp/.gitignore"), "utf8")).toBe("*\n!.gitignore\n");
  });

  it("does not overwrite an existing paste created in the same second", () => {
    const root = makeWorkspace();
    const now = new Date(2026, 7, 21, 14, 32, 5);
    const first = writePasteOffloadFile(root, "first", now);
    const second = writePasteOffloadFile(root, "second", now);

    expect(first.relativePath).toBe(".pi/tmp/paste-20260821-143205.txt");
    expect(second.relativePath).toBe(".pi/tmp/paste-20260821-143205-1.txt");
    expect(fs.readFileSync(first.absolutePath, "utf8")).toBe("first");
    expect(fs.readFileSync(second.absolutePath, "utf8")).toBe("second");
  });

  it("preserves an existing regular self-ignore file", () => {
    const root = makeWorkspace();
    const directory = path.join(root, ".pi/tmp");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ".gitignore"), "custom\n", "utf8");

    writePasteOffloadFile(root, "content");

    expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("rejects content larger than the host limit", () => {
    const root = makeWorkspace();

    expect(() => writePasteOffloadFile(root, "x".repeat(PASTE_OFFLOAD_MAX_BYTES + 1))).toThrow(
      "Paste content is too large",
    );
  });
});
