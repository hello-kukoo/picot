// ABOUTME: Stores large pasted composer payloads in a workspace-local Pi scratch directory.
// ABOUTME: Enforces containment, symlink checks, restrictive permissions, and collision-safe names.

import * as fs from "node:fs";
import * as path from "node:path";

const GITIGNORE_CONTENT = "*\n!.gitignore\n";
const FILE_PREFIX = "paste-";
const FILE_SUFFIX = ".txt";

export const PASTE_OFFLOAD_MAX_BYTES = 2 * 1024 * 1024;

type PasteOffloadResult = {
  absolutePath: string;
  relativePath: string;
};

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function timestampPart(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("Workspace root is not a directory");
  return fs.realpathSync.native(resolved);
}

function ensureDirectoryComponent(directory: string): void {
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error("Paste directory must not contain symlinks");
    }
    if (!fs.statSync(directory).isDirectory()) throw new Error("Paste path is not a directory");
    return;
  }
  fs.mkdirSync(directory);
}

function ensureContainedDirectory(root: string, directory: string): string {
  const realDirectory = fs.realpathSync.native(directory);
  if (!isPathWithinRoot(root, realDirectory))
    throw new Error("Paste directory is outside workspace");
  if (!fs.statSync(realDirectory).isDirectory()) throw new Error("Paste path is not a directory");
  return realDirectory;
}

export function writePasteOffloadFile(
  workspaceRoot: string,
  content: string,
  now = new Date(),
): PasteOffloadResult {
  if (typeof content !== "string") throw new Error("Paste content must be text");
  if (Buffer.byteLength(content, "utf8") > PASTE_OFFLOAD_MAX_BYTES) {
    throw new Error("Paste content is too large");
  }

  const root = canonicalWorkspaceRoot(workspaceRoot);
  const piDirectory = path.join(root, ".pi");
  ensureDirectoryComponent(piDirectory);
  const directory = path.join(piDirectory, "tmp");
  ensureDirectoryComponent(directory);
  const realDirectory = ensureContainedDirectory(root, directory);

  const ignorePath = path.join(realDirectory, ".gitignore");
  if (fs.existsSync(ignorePath)) {
    if (fs.lstatSync(ignorePath).isSymbolicLink()) {
      throw new Error("Paste ignore file must not be a symlink");
    }
  } else {
    fs.writeFileSync(ignorePath, GITIGNORE_CONTENT, { encoding: "utf8", mode: 0o600 });
  }

  const baseName = `${FILE_PREFIX}${timestampPart(now)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const absolutePath = path.join(realDirectory, `${baseName}${suffix}${FILE_SUFFIX}`);
    if (!isPathWithinRoot(root, absolutePath)) throw new Error("Paste file is outside workspace");
    try {
      const fd = fs.openSync(absolutePath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, content, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }

  throw new Error("Could not allocate a unique paste file");
}
