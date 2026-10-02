// ABOUTME: Explicit, isolated evidence probe for installed pi-subagents versus embedded Pi RPC.
// ABOUTME: Never writes outside its temporary fixture or claims unobservable slash results.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const installed = join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const version = JSON.parse(await readFile(join(repo, "scripts/pi-version.json"), "utf8")).version;
const binary = join(repo, "src-tauri/resources/pi", process.platform === "win32" ? "pi.exe" : "pi");
const report = {
  version,
  cwd: "isolated workspace/nested",
  sources: [],
  discoveredNames: [],
  differences: [],
  verified: false,
  verdict: "disk-candidates-only",
};
let temp;
let child;
try {
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  await readFile(join(installed, "src/agents/agents.js"));
  await readFile(join(installed, "src/agents/agent-selection.js"));
  report.sources.push(`installed pi-subagents ${pkg.version}`);
  if (pkg.version !== "0.73.1") throw Error("installed extension version differs from 0.73.1");
  temp = await mkdtemp(join(tmpdir(), "picot-subagents-spike-"));
  const home = join(temp, "home");
  const agent = join(home, ".pi/agent");
  const workspace = join(temp, "workspace");
  const nested = join(workspace, "nested");
  for (const dir of [
    join(agent, "agents"),
    join(workspace, ".pi/agents"),
    join(nested, ".pi"),
    join(agent, "npm/node_modules/fixture/agents"),
  ])
    await mkdir(dir, { recursive: true });
  const definition = (name) =>
    `---\nname: ${name}\ndescription: isolated parity fixture\n---\nFixture only.\n`;
  await writeFile(join(agent, "agents/shared.md"), definition("shared"));
  await writeFile(join(workspace, ".pi/agents/shared.md"), definition("shared"));
  await writeFile(join(agent, "npm/node_modules/fixture/agents/pkg.md"), definition("pkg"));
  await writeFile(
    join(agent, "npm/node_modules/fixture/package.json"),
    JSON.stringify({ name: "fixture", "pi-subagents": { agents: ["agents"] } }),
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ packages: [{ source: "npm:fixture", enabled: false }] }),
  );
  await writeFile(
    join(nested, ".pi/settings.json"),
    JSON.stringify({ subagents: { projectRootResolution: "git-root" } }),
  );
  await mkdir(join(workspace, ".git"));
  report.sources.push("temporary global/project agents, disabled package, nested .pi, git root");
  child = Bun.spawn(
    [binary, "--mode", "rpc", "--no-session", "--extension", join(installed, "index.js")],
    {
      cwd: nested,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agent,
        XDG_CONFIG_HOME: join(temp, "config"),
        XDG_CACHE_HOME: join(temp, "cache"),
        XDG_DATA_HOME: join(temp, "data"),
        TMPDIR: temp,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const observed = [];
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          observed.push(JSON.parse(line));
        } catch {
          /* non-protocol output is not evidence */
        }
      }
    }
  })();
  for (const command of ["get_commands", "/subagents-models", "/run shared"]) {
    const id = command;
    child.stdin.write(
      `${JSON.stringify({ id, type: id === "get_commands" ? id : "prompt", ...(id === "get_commands" ? {} : { message: command }) })}\n`,
    );
  }
  await Promise.race([new Promise((done) => setTimeout(done, 2500)), child.exited]);
  child.kill();
  child.stdin.end();
  await child.exited;
  await reader;
  const commandResponse = observed.find((frame) => frame.id === "get_commands");
  const commands = commandResponse?.data?.commands ?? [];
  if (!commandResponse?.success)
    report.differences.push("embedded Pi get_commands did not return success");
  for (const name of ["/run shared", "/subagents-models"]) {
    const result = observed.find((frame) => frame.id === name);
    report.sources.push(`${name}: RPC ${result?.success === true ? "accepted" : "not confirmed"}`);
  }
  const registered = ["run", "subagents-models"].filter((name) =>
    commands.some((command) => command.name === name),
  );
  report.discoveredNames = registered;
  report.differences.push(
    registered.length === 2
      ? "commands registered, but RPC slash prompts do not expose a structured both-scope winner/alias/runtime-registry snapshot"
      : "slash commands not confirmed in isolated embedded Pi",
  );
  report.differences.push(
    "package disable/filter, nested projectRoot and same-name winner not observable through RPC command results",
  );
  report.differences.push("runtime-registered agents cannot be enumerated through host RPC");
} catch (error) {
  report.differences.push(`probe unavailable: ${error.code ?? error.message}`);
} finally {
  if (child) {
    child.kill();
    await child.exited;
  }
  if (temp) await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
