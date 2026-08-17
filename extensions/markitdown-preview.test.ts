import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  bridgeConversionCancellation,
  type ConversionRequest,
  createMarkItDownPreviewService,
  INPUT_BYTE_CAP,
  MARKITDOWN_ARGS,
  MAX_CONCURRENCY,
  serializeConversionOutcome,
} from "./markitdown-preview.ts";

type ServiceOptions = NonNullable<Parameters<typeof createMarkItDownPreviewService>[0]> & {
  child?: ReturnType<typeof childWithOutput>;
};

function availableService(options: ServiceOptions = {}) {
  const { child, spawn: providedSpawn, resolveExecutable: _resolve, ...serviceOptions } = options;
  const spawn =
    providedSpawn ??
    (vi.fn((_command: string, args: string[]) => {
      // CLI candidate (markitdown) — fail so probe falls through to python3.
      // Tests using this helper exercise the python-module conversion path.
      if (_command === "markitdown") return childWithOutput("", 1);
      if (args.includes("--help")) return childWithOutput("--extension -x\n");
      if (args.includes("-m") && args.includes("markitdown"))
        return child ?? childWithOutput("# ok\n");
      if (args.some((arg) => arg.includes("sys.version_info")))
        return childWithOutput("3 11 0\n/usr/bin/python3\n");
      if (args.some((arg) => arg.includes("sys.executable")))
        return childWithOutput("/usr/bin/python3\n");
      return childWithOutput("ok\n");
    }) as never);
  return createMarkItDownPreviewService({
    platform: "darwin",
    ...serviceOptions,
    spawn,
    resolveExecutable: async () => "/usr/bin/python3",
  });
}

function childWithOutput(stdout = "", code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 123;
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

describe("MarkItDown preview service", () => {
  test("serializes stable browser-safe outcome fields", () => {
    expect(serializeConversionOutcome({ status: "ready", markdown: "# Report" })).toEqual({
      previewStatus: "ready",
      content: "# Report",
      editable: false,
      renderAs: "markdown",
    });
    expect(
      serializeConversionOutcome({
        status: "dependencyUnavailable",
        reason: "pythonTooOld",
        pythonVersion: "3.9.7",
        displayCommand: "python",
      }),
    ).toEqual({
      previewStatus: "dependencyUnavailable",
      dependencyReason: "pythonTooOld",
      pythonVersion: "3.9.7",
      displayCommand: "python",
      editable: false,
    });
    expect(serializeConversionOutcome({ status: "conversionFailed", cause: "timedOut" })).toEqual({
      previewStatus: "conversionFailed",
      editable: false,
    });
  });

  test("exports fixed resource limits and stdin-only arguments", () => {
    expect(INPUT_BYTE_CAP).toBe(32 * 1024 * 1024);
    expect(MAX_CONCURRENCY).toBe(2);
    expect(MARKITDOWN_ARGS("docx")).toEqual(["-m", "markitdown", "-x", ".docx"]);
    expect(MARKITDOWN_ARGS("docx", "cli")).toEqual(["-x", ".docx"]);
    expect(MARKITDOWN_ARGS("docx")).not.toContain(expect.stringMatching(/workspace|report/));
  });

  test("probes POSIX candidates in order and reports old Python", async () => {
    const spawn = vi.fn(() => childWithOutput());
    const service = createMarkItDownPreviewService({
      platform: "darwin",
      spawn: spawn as never,
    });
    await expect(service.probe()).resolves.toEqual({
      status: "unavailable",
      reason: "pythonMissing",
    });
    const calls = spawn.mock.calls as Array<readonly unknown[]>;
    // markitdown CLI is probed first, then python3 / python.
    expect(calls.slice(0, 3).map((call) => call[0])).toEqual(["markitdown", "python3", "python"]);
  });

  test("uses a sanitized PATH only while discovering the interpreter", async () => {
    const spawn = vi.fn((_command: string, args: string[]) => {
      // CLI candidate fails so probe falls through to python3.
      if (_command === "markitdown") return childWithOutput("", 1);
      if (args.includes("--help")) return childWithOutput("--extension -x\n");
      if (args.includes("-m") && args.includes("markitdown")) return childWithOutput("# ok\n");
      if (args.some((arg) => arg.includes("sys.version_info")))
        return childWithOutput("3 11 0\n/usr/bin/python3\n");
      if (args.some((arg) => arg.includes("sys.executable")))
        return childWithOutput("/usr/bin/python3\n");
      return childWithOutput("ok\n");
    });
    const service = createMarkItDownPreviewService({
      platform: "darwin",
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:\u0000ignored:/usr/bin",
        PYTHONPATH: "/untrusted/pythonpath",
        HTTPS_PROXY: "https://proxy.invalid",
      },
      spawn: spawn as never,
      resolveExecutable: async () => "/usr/bin/python3",
    });
    const fd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    try {
      await expect(
        service.convertFromDescriptor({
          fd,
          size: 0,
          suffix: "docx",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ status: "ready" });
    } finally {
      fs.closeSync(fd);
    }

    const calls = spawn.mock.calls as unknown as Array<
      [_: string, args: string[], options: { env: NodeJS.ProcessEnv }]
    >;
    const discoveryCalls = calls.filter(([, args]) => !args.includes("markitdown"));
    expect(discoveryCalls).not.toHaveLength(0);
    for (const [, , options] of discoveryCalls) {
      expect(options.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
      expect(options.env.PYTHONPATH).toBeUndefined();
      expect(options.env.HTTPS_PROXY).toBeUndefined();
    }
    const conversion = calls.find(([, args]) => args.includes("-x"));
    expect(conversion?.[2].env.PATH).toBeUndefined();
    expect(conversion?.[2].env.PYTHONPATH).toBeUndefined();
    expect(conversion?.[2].env.HTTPS_PROXY).toBeUndefined();
  });

  test("bridges Node aborted, Bun signal, and response close cancellation", () => {
    const requestListeners = new Map();
    const responseListeners = new Map();
    const requestSignal = new AbortController();
    const request = {
      signal: requestSignal.signal,
      on: vi.fn((event, listener) => requestListeners.set(event, listener)),
      removeListener: vi.fn((event) => requestListeners.delete(event)),
    };
    const response = {
      writableEnded: false,
      on: vi.fn((event, listener) => responseListeners.set(event, listener)),
      removeListener: vi.fn((event) => responseListeners.delete(event)),
    };
    const cancellation = bridgeConversionCancellation(request, response);
    requestListeners.get("aborted")();
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.cleanup();
    expect(request.removeListener).toHaveBeenCalledWith("aborted", expect.any(Function));
    expect(response.removeListener).toHaveBeenCalledWith("close", expect.any(Function));

    const bunRequest = { signal: new AbortController().signal };
    const bun = bridgeConversionCancellation(bunRequest, {});
    bunRequest.signal.dispatchEvent(new Event("abort"));
    expect(bun.signal.aborted).toBe(true);

    const closeRequest = { signal: new AbortController().signal };
    const closeResponse = {
      writableEnded: false,
      on: vi.fn((_event, listener) => listener()),
    };
    const closed = bridgeConversionCancellation(closeRequest, closeResponse);
    expect(closed.signal.aborted).toBe(true);
    const completedResponse = { writableEnded: true, on: vi.fn() };
    const completed = bridgeConversionCancellation(closeRequest, completedResponse);
    expect(completed.signal.aborted).toBe(false);
  });

  test("converts descriptor input and releases its slot exactly once", async () => {
    const fixture = path.join(os.tmpdir(), `picot-markitdown-${Date.now()}.bin`);
    fs.writeFileSync(fixture, "source bytes");
    const fd = fs.openSync(fixture, fs.constants.O_RDONLY);
    try {
      const service = availableService();
      await expect(
        service.convertFromDescriptor({
          fd,
          size: 12,
          suffix: "docx",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ status: "ready", markdown: "# ok\n" });
      const third = service.convertFromDescriptor({
        fd,
        size: 12,
        suffix: "docx",
        signal: new AbortController().signal,
      });
      await expect(third).resolves.toMatchObject({ status: "ready" });
    } finally {
      fs.closeSync(fd);
      fs.rmSync(fixture, { force: true });
    }
  });

  test("terminates on stdout and stderr caps", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const child = childWithOutput();
      const fd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
      const service = availableService({ child });
      const promise = service.convertFromDescriptor({
        fd,
        size: 0,
        suffix: "docx",
        signal: new AbortController().signal,
      });
      if (stream === "stdout") child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
      else child.stderr.write(Buffer.alloc(256 * 1024 + 1));
      await new Promise((resolve) => setImmediate(resolve));
      child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));
      child.stderr.emit("data", Buffer.alloc(256 * 1024 + 1));
      child.emit("close", 1);
      await expect(promise).resolves.toMatchObject({ status: "conversionFailed" });
      expect(child.kill).toHaveBeenCalled();
      try {
        fs.fstatSync(fd);
        fs.closeSync(fd);
      } catch (error) {
        if (error?.code !== "EBADF") throw error;
      }
    }
  });

  test("terminates on abort, timeout, spawn error, and Windows taskkill", async () => {
    const abortChild = childWithOutput();
    const abortController = new AbortController();
    const abortService = availableService({ child: abortChild });
    const abortFd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    const aborted = abortService.convertFromDescriptor({
      fd: abortFd,
      size: 0,
      suffix: "docx",
      signal: abortController.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    abortController.abort();
    abortChild.emit("close", null);
    try {
      fs.fstatSync(abortFd);
      fs.closeSync(abortFd);
    } catch (error) {
      if (error?.code !== "EBADF") throw error;
    }
    await expect(aborted).resolves.toEqual({ status: "conversionFailed", cause: "aborted" });

    const timer = Object.assign(
      vi.fn((callback: () => void) => {
        callback();
        return 1 as never;
      }),
      { __promisify__: vi.fn() },
    ) as unknown as typeof globalThis.setTimeout;
    const timedChild = childWithOutput();
    const timed = availableService({ child: timedChild, setTimeout: timer });
    const timedFd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    const timedPromise = timed.convertFromDescriptor({
      fd: timedFd,
      size: 0,
      suffix: "docx",
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    timedChild.emit("close", null);
    try {
      fs.fstatSync(timedFd);
      fs.closeSync(timedFd);
    } catch (error) {
      if (error?.code !== "EBADF") throw error;
    }
    await expect(timedPromise).resolves.toMatchObject({ status: "conversionFailed" });

    const spawnError = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const failed = createMarkItDownPreviewService({
      platform: "darwin",
      spawn: spawnError as never,
      resolveExecutable: async () => "/usr/bin/python3",
    });
    await expect(
      failed.convertFromDescriptor({
        fd: 42,
        size: 0,
        suffix: "docx",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "dependencyUnavailable" });

    const winSpawn = vi.fn((_command: string, args: string[]) => {
      // CLI candidate fails so probe falls through to py -3.
      if (_command === "markitdown") return childWithOutput("", 1);
      if (args.includes("--help")) return childWithOutput("--extension -x\n");
      if (args.includes("-m") && args.includes("markitdown")) return winChild;
      if (args.some((arg) => arg.includes("sys.version_info")))
        return childWithOutput("3 11 0\nC:\\Python\\python.exe\n");
      if (args.some((arg) => arg.includes("sys.executable")))
        return childWithOutput("C:\\Python\\python.exe\n");
      return childWithOutput("ok\n");
    });
    const winChild = childWithOutput();
    const winService = availableService({
      platform: "win32",
      spawn: winSpawn as never,
      child: winChild,
    });
    const winController = new AbortController();
    const winFd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    const winPromise = winService.convertFromDescriptor({
      fd: winFd,
      size: 0,
      suffix: "docx",
      signal: winController.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    winController.abort();
    winChild.emit("close", null);
    await winPromise;
    try {
      fs.closeSync(winFd);
    } catch (error) {
      if (error?.code !== "EBADF") throw error;
    }
    expect(
      winSpawn.mock.calls.some(
        ([command, args]) => String(command).endsWith("taskkill.exe") && args.includes("/t"),
      ),
    ).toBe(true);
  });

  test("discovers markitdown CLI (uv tool / pipx) without python module", async () => {
    // Simulates `uv tool install markitdown` / `pipx install markitdown`:
    // the `markitdown` command is on PATH and `--help` works, but `python3
    // -m markitdown` fails (module not importable in system python).
    const spawn = vi.fn((_command: string, args: string[]) => {
      if (_command === "markitdown" && args.includes("--help"))
        return childWithOutput("--extension -x\n");
      // python3 probes should not be reached because CLI candidate succeeds first.
      return childWithOutput("", 1);
    });
    const service = createMarkItDownPreviewService({
      platform: "darwin",
      spawn: spawn as never,
    });
    await expect(service.probe()).resolves.toMatchObject({
      status: "available",
      executable: "markitdown",
      mode: "cli",
    });

    // Conversion uses `markitdown -x .docx` (no `-m markitdown`).
    const conversionSpawn = vi.fn((_command: string, args: string[]) => {
      if (args.includes("--help")) return childWithOutput("--extension -x\n");
      return childWithOutput("# converted\n");
    });
    const convertService = createMarkItDownPreviewService({
      platform: "darwin",
      spawn: conversionSpawn as never,
      resolveExecutable: async () => "/usr/bin/python3",
    });
    const fd = fs.openSync("/dev/null", fs.constants.O_RDONLY);
    try {
      await convertService.convertFromDescriptor({
        fd,
        size: 0,
        suffix: "docx",
        signal: new AbortController().signal,
      });
    } finally {
      fs.closeSync(fd);
    }
    const conversionCall = conversionSpawn.mock.calls.find(
      ([command, args]) => command === "markitdown" && args.includes("-x"),
    );
    expect(conversionCall).toBeDefined();
    expect(conversionCall?.[1]).not.toContain("-m");
  });

  test("returns dependency reason without spawning a conversion", async () => {
    const service = createMarkItDownPreviewService({
      platform: "darwin",
      spawn: (() => {
        throw new Error("conversion must not spawn");
      }) as never,
      resolveExecutable: async () => null,
    });

    const request: ConversionRequest = {
      fd: 42,
      size: 0,
      suffix: "docx",
      signal: new AbortController().signal,
    };
    await expect(service.convertFromDescriptor(request)).resolves.toEqual({
      status: "dependencyUnavailable",
      reason: "pythonMissing",
    });
  });
});
