#!/usr/bin/env node

// ABOUTME: Runs isolated Gate C extension precedence/trust/collision evidence fixtures.
// ABOUTME: Uses only the pinned embedded Pi binary and never mutates production paths.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PI = join(
  ROOT,
  "src-tauri",
  "resources",
  "pi",
  process.platform === "win32" ? "pi.exe" : "pi",
);
const STATUS = {
  pass: "PASS",
  fail: "FAIL",
  unobservable: "UNOBSERVABLE",
};

function run(binary, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(binary, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), 8000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, error: error.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });
}

async function extension(path, label, marker, command = false) {
  const commandCode = command
    ? `\n  pi.registerCommand("gate-c-collision", { description: "${label}", handler: async () => {} });\n`
    : "";
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});\nexport default function (pi) {${commandCode}}\n`,
  );
}

function result(id, status, details) {
  return { id, status, ...details };
}

async function runRpc(binary, args, options) {
  const child = spawn(binary, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const frames = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          frames.push(JSON.parse(line));
        } catch (error) {
          frames.push({ type: "invalid_json", error: String(error), line });
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const response = new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => rejectResponse(new Error("RPC get_commands timeout")), 8000);
    const poll = setInterval(() => {
      const frame = frames.find(
        (item) => item.type === "response" && item.command === "get_commands",
      );
      if (frame) {
        clearTimeout(timer);
        clearInterval(poll);
        resolveResponse(frame);
      }
    }, 25);
  });
  child.stdin.write(`${JSON.stringify({ id: "gate-c-commands", type: "get_commands" })}\n`);
  const frame = await response;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.on("close", resolveExit));
  return { frame, stdout, stderr };
}

async function main() {
  if (!existsSync(PI)) {
    throw new Error(`pinned embedded Pi not found: ${PI}`);
  }
  const root = await mkdtemp(join(tmpdir(), "picot-gate-c-"));
  const marker = join(root, "load-order.log");
  const rawCwd = join(root, "project");
  const rawAgentDir = join(root, "agent");
  await mkdir(join(rawCwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(rawAgentDir, "extensions"), { recursive: true });
  const cwd = realpathSync(rawCwd);
  const agentDir = realpathSync(rawAgentDir);

  const projectExt = join(cwd, ".pi", "extensions", "project.js");
  const globalExt = join(agentDir, "extensions", "global.js");
  const explicitA = join(root, "explicit-a.js");
  const explicitB = join(root, "explicit-b.js");
  const collisionA = join(root, "collision-a.js");
  const collisionB = join(root, "collision-b.js");
  await extension(projectExt, "project", marker);
  await extension(globalExt, "global", marker);
  await extension(explicitA, "explicit-a", marker);
  await extension(explicitB, "explicit-b", marker);
  await extension(collisionA, "collision-a", marker, true);
  await extension(collisionB, "collision-b", marker, true);

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  const base = { cwd, env };
  const report = [];
  try {
    const precedence = await run(
      PI,
      [
        "--no-session",
        "--approve",
        "--print",
        "gate-c",
        "--extension",
        explicitA,
        "--extension",
        explicitB,
      ],
      base,
    );
    const order = existsSync(marker)
      ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const expected = ["explicit-a", "explicit-b", "project", "global"];
    report.push(
      result(
        "C-12-precedence",
        order.join(",") === expected.join(",") ? STATUS.pass : STATUS.fail,
        {
          expectedOrder: expected,
          observedOrder: order,
          exitCode: precedence.code,
          stderr: precedence.stderr.slice(-2000),
        },
      ),
    );

    const trustMarker = join(root, "trust-load.log");
    await extension(projectExt, "project-trust", trustMarker);
    await writeFile(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ defaultProjectTrust: "never" })}\n`,
    );
    const untrusted = await run(PI, ["--no-session", "--print", "gate-c-trust"], base);
    const untrustedObserved = existsSync(trustMarker) ? readFileSync(trustMarker, "utf8") : "";
    await writeFile(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ defaultProjectTrust: "always" })}\n`,
    );
    const trusted = await run(PI, ["--no-session", "--print", "gate-c-trust"], base);
    const trustedObserved = existsSync(trustMarker) ? readFileSync(trustMarker, "utf8") : "";
    report.push(
      result(
        "C-12-trust",
        !untrustedObserved && trustedObserved.includes("project-trust") ? STATUS.pass : STATUS.fail,
        {
          expected:
            "project extension absent with defaultProjectTrust=never and present with defaultProjectTrust=always",
          untrustedObserved: Boolean(untrustedObserved),
          trustedObserved: Boolean(trustedObserved),
          untrustedExitCode: untrusted.code,
          trustedExitCode: trusted.code,
        },
      ),
    );

    const collision = await runRpc(
      PI,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-tools",
        "--extension",
        collisionA,
        "--extension",
        collisionB,
      ],
      base,
    );
    const commandNames = collision.frame?.data?.commands?.map((item) => item.name) ?? [];
    const collisionNames = commandNames.filter((name) => name.startsWith("gate-c-collision"));
    const hasCollisionSurface = collisionNames.length >= 2;
    report.push(
      result("C-12-collision", hasCollisionSurface ? STATUS.pass : STATUS.unobservable, {
        expected: "same-name command retained with load-order diagnostic/suffix",
        observedCommands: collisionNames,
        rpcResponse: collision.frame,
        output: `${collision.stdout}\n${collision.stderr}`.slice(-3000),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const canClose = report.every((item) => item.status === STATUS.pass);
  const output = {
    evidenceStatus: canClose ? "EXECUTED_PASS" : "EXECUTED_INCOMPLETE",
    binary: PI,
    version: "0.84.2",
    cases: report,
    gateC12: {
      canClose,
      blocker: canClose ? null : "One or more runtime fixtures did not produce PASS evidence.",
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!canClose) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`[gate-c-parity-smoke] ${error.message}\n`);
  process.exitCode = 1;
});
