// ABOUTME: Converts approved workspace documents through an optional local MarkItDown process.
// ABOUTME: Bounds stdin/stdout/stderr, elapsed time, concurrency, and cancellation without exposing paths.

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import type { ConvertibleSuffix } from "./file-routes.ts";

export const INPUT_BYTE_CAP = 32 * 1024 * 1024;
export const OUTPUT_BYTE_CAP = 2 * 1024 * 1024;
export const STDERR_BYTE_CAP = 256 * 1024;
export const TIMEOUT_MS = 20_000;
export const MAX_CONCURRENCY = 2;
export const POSIX_KILL_GRACE_MS = 500;

/**
 * Args passed to the resolved executable during conversion. In python-module
 * mode the executable is a python interpreter, so args start with
 * `-m markitdown`. In cli mode the executable IS the markitdown launcher
 * (installed via `uv tool install` / `pipx install`), so only `-x .suffix`
 * is passed.
 */
export const MARKITDOWN_ARGS = (
  suffix: ConvertibleSuffix,
  mode: "python-module" | "cli" = "python-module",
): string[] => (mode === "cli" ? ["-x", `.${suffix}`] : ["-m", "markitdown", "-x", `.${suffix}`]);

export type DependencyReason =
  | "pythonMissing"
  | "pythonTooOld"
  | "markitdownMissing"
  | "markitdownIncompatible";

export type ConversionFailure =
  | "inputTooLarge"
  | "capacityUnavailable"
  | "timedOut"
  | "aborted"
  | "stdoutTooLarge"
  | "stderrTooLarge"
  | "processFailed"
  | "emptyOutput";

export type ConversionOutcome =
  | { status: "ready"; markdown: string }
  | {
      status: "dependencyUnavailable";
      reason: DependencyReason;
      pythonVersion?: string;
      displayCommand?: string;
    }
  | { status: "conversionFailed"; cause: ConversionFailure };

export type ConversionRequest = {
  fd: number;
  size: number;
  suffix: ConvertibleSuffix;
  signal: AbortSignal;
};

export function serializeConversionOutcome(outcome: ConversionOutcome): Record<string, unknown> {
  if (outcome.status === "ready") {
    return {
      previewStatus: "ready",
      content: outcome.markdown,
      editable: false,
      renderAs: "markdown",
    };
  }
  if (outcome.status === "dependencyUnavailable") {
    return {
      previewStatus: "dependencyUnavailable",
      dependencyReason: outcome.reason,
      ...(outcome.pythonVersion ? { pythonVersion: outcome.pythonVersion } : {}),
      ...(outcome.displayCommand ? { displayCommand: outcome.displayCommand } : {}),
      editable: false,
    };
  }
  return { previewStatus: "conversionFailed", editable: false };
}

type DependencyProbe =
  | {
      status: "available";
      executable: string;
      launcherArgs: string[];
      displayCommand: string;
      pythonVersion: string;
      mode: "python-module" | "cli";
    }
  | {
      status: "unavailable";
      reason: DependencyReason;
      pythonVersion?: string;
      displayCommand?: string;
    };

type SpawnLike = typeof nodeSpawn;
type ResolveExecutable = (candidate: string, launcherArgs: string[]) => Promise<string | null>;
type ServiceDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  resolveExecutable?: ResolveExecutable;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

type Child = ChildProcessWithoutNullStreams | ChildProcess;

type RequestCancellationLike = {
  signal?: AbortSignal;
  on?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

type ResponseCancellationLike = {
  writableEnded?: boolean;
  on?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

export function bridgeConversionCancellation(
  request: RequestCancellationLike,
  response: ResponseCancellationLike,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const requestSignal = request.signal;
  const responseClose = () => {
    if (!response.writableEnded) abort();
  };
  requestSignal?.addEventListener("abort", abort, { once: true });
  request.on?.("aborted", abort);
  response.on?.("close", responseClose);
  return {
    signal: controller.signal,
    cleanup() {
      requestSignal?.removeEventListener("abort", abort);
      request.removeListener?.("aborted", abort);
      response.removeListener?.("close", responseClose);
    },
  };
}

const VERSION_SCRIPT =
  "import sys; print(sys.version_info[0], sys.version_info[1], sys.version_info[2]); print(sys.executable)";
const CAPABILITY_SCRIPT =
  "import importlib.util; from markitdown import MarkItDown, StreamInfo; print('ok')";
const MINIMAL_PROBE_OPTIONS = (env: NodeJS.ProcessEnv) => ({
  shell: false,
  env,
  stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
});

function parseVersion(output: string): { version: string; major: number; minor: number } | null {
  const match = output.match(/(\d+)\s+(\d+)\s+(\d+)/);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "LANG",
    "LC_ALL",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function discoveryEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env = minimalEnvironment(source);
  const pathKey = platform === "win32" ? "Path" : "PATH";
  const separator = platform === "win32" ? ";" : ":";
  const candidate = source[pathKey] ?? source.PATH;
  if (candidate) {
    const sanitized = candidate
      .split(separator)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.includes("\0"))
      .join(separator)
      .slice(0, 4096);
    if (sanitized) env[pathKey] = sanitized;
  }
  if (platform === "win32" && source.PATHEXT) env.PATHEXT = source.PATHEXT.slice(0, 4096);
  return env;
}

function runChild(
  spawn: SpawnLike,
  command: string,
  args: string[],
  options: ReturnType<typeof MINIMAL_PROBE_OPTIONS>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: Child;
    try {
      child = spawn(command, args, options) as Child;
    } catch {
      resolve({ code: null, stdout, stderr });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, stdout, stderr });
      }
    });
    child.once("close", (code: number | null) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}

type Candidate = {
  command: string;
  launcherArgs: string[];
  displayCommand: string;
  /**
   * `cli` candidates ARE the markitdown launcher itself (installed via
   * `uv tool install` / `pipx install`). `python-module` candidates are
   * Python interpreters that may have markitdown importable as a module.
   */
  mode: "python-module" | "cli";
};

function candidateList(platform: NodeJS.Platform): Candidate[] {
  const cliCandidates: Candidate[] = [
    { command: "markitdown", launcherArgs: [], displayCommand: "markitdown", mode: "cli" },
  ];
  if (platform === "win32") {
    return [
      ...cliCandidates,
      { command: "py", launcherArgs: ["-3"], displayCommand: "py -3", mode: "python-module" },
      {
        command: "python.exe",
        launcherArgs: [],
        displayCommand: "python.exe",
        mode: "python-module",
      },
    ];
  }
  return [
    ...cliCandidates,
    { command: "python3", launcherArgs: [], displayCommand: "python3", mode: "python-module" },
    { command: "python", launcherArgs: [], displayCommand: "python", mode: "python-module" },
  ];
}

export function createMarkItDownPreviewService(dependencies: ServiceDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const sourceEnv = dependencies.env ?? process.env;
  const env = minimalEnvironment(sourceEnv);
  const probeEnv = discoveryEnvironment(sourceEnv, platform);
  const setTimer = dependencies.setTimeout ?? globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let probePromise: Promise<DependencyProbe> | null = null;
  let activeConversions = 0;
  const activeChildren = new Set<Child>();

  const defaultResolveExecutable: ResolveExecutable = async (candidate, launcherArgs) => {
    const result = await runChild(
      spawn,
      candidate,
      [...launcherArgs, "-c", "import sys; print(sys.executable)"],
      MINIMAL_PROBE_OPTIONS(probeEnv),
    );
    const executable = result.stdout.trim().split("\n").at(-1)?.trim();
    return result.code === 0 && executable && path.isAbsolute(executable) ? executable : null;
  };
  const resolveExecutable = dependencies.resolveExecutable ?? defaultResolveExecutable;

  async function probe(): Promise<DependencyProbe> {
    if (probePromise) return probePromise;
    probePromise = (async () => {
      let oldVersion: string | undefined;
      let oldVersionCommand: string | undefined;
      let missingPackageVersion: string | undefined;
      let missingPackageCommand: string | undefined;
      let incompatibleVersion: string | undefined;
      let incompatibleCommand: string | undefined;
      for (const candidate of candidateList(platform)) {
        if (candidate.mode === "cli") {
          // CLI candidates (installed via `uv tool install` / `pipx install`)
          // are standalone launchers. Probe by checking `--help` for the
          // `-x/--extension` flag; no python version check needed.
          const help = await runChild(
            spawn,
            candidate.command,
            ["--help"],
            MINIMAL_PROBE_OPTIONS(probeEnv),
          );
          if (help.code === 0 && /(--extension|-x)/.test(help.stdout)) {
            return {
              status: "available",
              executable: candidate.command,
              launcherArgs: [],
              displayCommand: candidate.displayCommand,
              pythonVersion: "cli",
              mode: "cli",
            };
          }
          // CLI not found / incompatible — fall through to python-module candidates.
          continue;
        }

        const versionResult = await runChild(
          spawn,
          candidate.command,
          [...candidate.launcherArgs, "-c", VERSION_SCRIPT],
          MINIMAL_PROBE_OPTIONS(probeEnv),
        );
        if (versionResult.code === null || versionResult.code !== 0) continue;
        const parsed = parseVersion(versionResult.stdout);
        if (!parsed) continue;
        if (parsed.major < 3 || (parsed.major === 3 && parsed.minor < 10)) {
          oldVersion ??= parsed.version;
          oldVersionCommand ??= candidate.displayCommand;
          continue;
        }

        const capability = await runChild(
          spawn,
          candidate.command,
          [...candidate.launcherArgs, "-c", CAPABILITY_SCRIPT],
          MINIMAL_PROBE_OPTIONS(probeEnv),
        );
        if (capability.code !== 0) {
          if (/No module named ['"]?markitdown/i.test(capability.stderr + capability.stdout)) {
            missingPackageVersion ??= parsed.version;
            missingPackageCommand ??= candidate.displayCommand;
          } else {
            incompatibleVersion ??= parsed.version;
            incompatibleCommand ??= candidate.displayCommand;
          }
          continue;
        }
        const help = await runChild(
          spawn,
          candidate.command,
          [...candidate.launcherArgs, "-m", "markitdown", "--help"],
          MINIMAL_PROBE_OPTIONS(probeEnv),
        );
        if (help.code !== 0 || !/(--extension|-x)/.test(help.stdout)) {
          incompatibleVersion ??= parsed.version;
          incompatibleCommand ??= candidate.displayCommand;
          continue;
        }
        const executable = await resolveExecutable(candidate.command, candidate.launcherArgs);
        if (!executable) {
          incompatibleVersion ??= parsed.version;
          incompatibleCommand ??= candidate.displayCommand;
          continue;
        }
        return {
          status: "available",
          executable,
          // The launcher is used only for discovery. Conversion runs the
          // resolved absolute interpreter directly, so `py -3` is not passed
          // as an invalid flag to python.exe.
          launcherArgs: [],
          displayCommand: candidate.displayCommand,
          pythonVersion: parsed.version,
          mode: "python-module",
        };
      }
      if (oldVersion && !missingPackageVersion && !incompatibleVersion) {
        return {
          status: "unavailable",
          reason: "pythonTooOld",
          pythonVersion: oldVersion,
          ...(oldVersionCommand ? { displayCommand: oldVersionCommand } : {}),
        };
      }
      if (missingPackageVersion)
        return {
          status: "unavailable",
          reason: "markitdownMissing",
          ...(missingPackageCommand ? { displayCommand: missingPackageCommand } : {}),
        };
      if (incompatibleVersion)
        return {
          status: "unavailable",
          reason: "markitdownIncompatible",
          ...(incompatibleCommand ? { displayCommand: incompatibleCommand } : {}),
        };
      if (oldVersion)
        return {
          status: "unavailable",
          reason: "pythonTooOld",
          pythonVersion: oldVersion,
          ...(oldVersionCommand ? { displayCommand: oldVersionCommand } : {}),
        };
      return { status: "unavailable", reason: "pythonMissing" };
    })();
    return probePromise;
  }

  function terminate(child: Child): void {
    if (platform === "win32") {
      const root = sourceEnv.SystemRoot || "C:\\Windows";
      const taskkill = path.win32.join(root, "System32", "taskkill.exe");
      try {
        spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
          shell: false,
          env,
          stdio: "ignore",
          windowsHide: true,
        } as never);
      } catch {
        child.kill?.();
      }
      return;
    }
    try {
      child.kill?.("SIGTERM");
    } catch {
      // The close event still finalizes the request if the process already exited.
    }
  }

  async function convertFromDescriptor(request: ConversionRequest): Promise<ConversionOutcome> {
    const dependency = await probe();
    if (dependency.status === "unavailable")
      return {
        status: "dependencyUnavailable",
        reason: dependency.reason,
        ...(dependency.pythonVersion ? { pythonVersion: dependency.pythonVersion } : {}),
        ...(dependency.displayCommand ? { displayCommand: dependency.displayCommand } : {}),
      };
    if (request.size > INPUT_BYTE_CAP)
      return { status: "conversionFailed", cause: "inputTooLarge" };
    if (activeConversions >= MAX_CONCURRENCY)
      return { status: "conversionFailed", cause: "capacityUnavailable" };
    if (request.signal.aborted) return { status: "conversionFailed", cause: "aborted" };
    activeConversions += 1;

    let child: Child | null = null;
    let finalized = false;
    let killTimer: ReturnType<typeof setTimer> | null = null;
    let failure: ConversionFailure | null = null;
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let inputBytes = 0;
    let beginTermination: (cause: ConversionFailure) => void;
    const abortHandler = () => beginTermination("aborted");

    try {
      child = spawn(
        dependency.executable,
        [...dependency.launcherArgs, ...MARKITDOWN_ARGS(request.suffix, dependency.mode)],
        {
          shell: false,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: platform === "win32",
        } as never,
      ) as Child;
      activeChildren.add(child);
      request.signal.addEventListener("abort", abortHandler, { once: true });

      beginTermination = (cause: ConversionFailure) => {
        if (!failure) failure = cause;
        if (!child) return;
        terminate(child);
        if (platform !== "win32") {
          killTimer = setTimer(() => {
            if (!finalized) {
              try {
                child?.kill?.("SIGKILL");
              } catch {
                // Finalization remains driven by close/error.
              }
            }
          }, POSIX_KILL_GRACE_MS);
        }
      };

      const timeout = setTimer(() => beginTermination("timedOut"), TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (stdout.length + buffer.length > OUTPUT_BYTE_CAP) {
          beginTermination("stdoutTooLarge");
          return;
        }
        stdout = Buffer.concat([stdout, buffer]);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        stderrBytes += buffer.length;
        if (stderrBytes > STDERR_BYTE_CAP) beginTermination("stderrTooLarge");
      });

      const input = fs.createReadStream(null, {
        fd: request.fd,
        autoClose: false,
        start: 0,
      });
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          inputBytes += chunk.length;
          if (inputBytes > INPUT_BYTE_CAP) {
            beginTermination("inputTooLarge");
            callback();
            input.destroy();
            return;
          }
          callback(null, chunk);
        },
      });
      input.on("error", () => beginTermination("processFailed"));
      child.stdin?.on("error", () => beginTermination("processFailed"));
      input.pipe(counter).pipe(child.stdin as NodeJS.WritableStream);

      return await new Promise<ConversionOutcome>((resolve) => {
        const finish = (cause?: ConversionFailure) => {
          if (finalized) return;
          finalized = true;
          clearTimer(timeout);
          if (killTimer) clearTimer(killTimer);
          request.signal.removeEventListener("abort", abortHandler);
          input.destroy();
          counter.destroy();
          activeChildren.delete(child as Child);
          activeConversions -= 1;
          if (cause || failure) {
            resolve({ status: "conversionFailed", cause: cause ?? (failure as ConversionFailure) });
            return;
          }
          const markdown = stdout.toString("utf8");
          if (!markdown.trim()) resolve({ status: "conversionFailed", cause: "emptyOutput" });
          else resolve({ status: "ready", markdown });
        };
        child?.once("error", () => finish(failure ?? "processFailed"));
        child?.once("close", (code: number | null) =>
          finish(failure ?? (code === 0 ? undefined : "processFailed")),
        );
        if (request.signal.aborted) abortHandler();
      });
    } catch {
      activeChildren.delete(child as Child);
      activeConversions -= 1;
      request.signal.removeEventListener("abort", abortHandler);
      return { status: "conversionFailed", cause: failure ?? "processFailed" };
    }
  }

  return {
    probe,
    convertFromDescriptor,
    async dispose() {
      for (const child of activeChildren) terminate(child);
      activeChildren.clear();
      probePromise = null;
    },
  };
}
