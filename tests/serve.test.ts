import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installTool } from "../src/install/install";
import { INSTALLED_MARKER } from "../src/manifest/discover";
import { ensureRegistered, isRegistered, register, selfCommand } from "../src/commands/register";
import type { RunResult } from "../src/core/run";

const home = realpathSync(mkdtempSync(join(tmpdir(), "gu-serve-")));
const caller = join(home, "project");
const cli = resolve(import.meta.dir, "../src/cli.ts");
const client = new Client({ name: "gu-test", version: "1" });
let diagnostics = "";
let installed: string;

beforeAll(async () => {
  mkdirSync(caller);
  const result = await installTool(join(import.meta.dir, "fixtures/tools/py-echo"), { guHome: home });
  if (!result.ok) throw new Error(result.message);
  installed = result.loaded.dir;
  // A marker makes it observable that invalid calls never execute the program.
  writeFileSync(join(installed, "echo.py"), 'import sys\nfrom pathlib import Path\nPath(__file__).with_name("ran").write_text("yes")\nprint(sys.argv[1])\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "serve"], env: { GU_HOME: home }, cwd: caller, stderr: "pipe" });
  transport.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  await client.connect(transport);
}, 30_000);

afterAll(async () => { await client.close(); rmSync(home, { recursive: true, force: true }); });

test("lists installed tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map(t => t.name)).toContain("py-echo__echo");
  expect(tools[0].inputSchema.required).toEqual(["text"]);
});

test("calls a tool and returns its output", async () => {
  const result = await client.callTool({ name: "py-echo__echo", arguments: { text: "hi there" } });
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: "text", text: "hi there\n\n[exit code 0]" }]);
});

test("bad arguments return an error without running", async () => {
  rmSync(join(installed, "ran"), { force: true });
  const result = await client.callTool({ name: "py-echo__echo", arguments: {} });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "Missing required argument: text" }]);
  expect(existsSync(join(installed, "ran"))).toBe(false);
});

test("serve skips a broken manifest and logs only to stderr", async () => {
  const broken = join(home, "tools", "broken", "1");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, INSTALLED_MARKER), "verified");
  writeFileSync(join(broken, "gu.yaml"), "name: [");
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(["py-echo__echo"]);
  // The two pipes are independent; wait briefly for the diagnostic stream.
  for (let i = 0; i < 20 && !diagnostics.includes("broken"); i++) await Bun.sleep(10);
  expect(diagnostics).toContain("broken");
});

function addProbe(name: string, body: string, timeout = 5, args = "{}") {
  const dir = join(home, "tools", name, "1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INSTALLED_MARKER), "verified");
  writeFileSync(join(dir, "gu.yaml"), `name: ${name}\nversion: 1\ndescription: Probe\nuse_when: Testing\nplatforms: [macos, linux]\ntools:\n  - name: probe\n    run: '${process.execPath} probe.js'\n    timeout: ${timeout}\n    args: ${args}\ntest:\n  run: 'true'\n  expect: {exit_code: 0}\n`);
  writeFileSync(join(dir, "probe.js"), body);
  return dir;
}

test("rediscovers tools on calls and resolves paths from the caller project", async () => {
  const dir = addProbe("fresh", "console.log(process.cwd()); console.log(process.argv[2]);", 5, "{file: {type: path, positional: true}}");
  const result = await client.callTool({ name: "fresh__probe", arguments: { file: "input.txt" } });
  expect(result.isError).toBe(false);
  expect(result.content).toEqual([{ type: "text", text: `${caller}\n${join(caller, "input.txt")}\n\n[exit code 0]` }]);
  expect((await client.listTools()).tools.map(t => t.name)).toContain("fresh__probe");
});

test("formats stderr and nonzero exits", async () => {
  addProbe("fails", 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;');
  const result = await client.callTool({ name: "fails__probe" });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "out\n--- stderr ---\nerr\n[exit code 7]" }]);
});

test("uses the manifest timeout", async () => {
  addProbe("slow", 'setTimeout(() => {}, 10000);', 1);
  const result = await client.callTool({ name: "slow__probe" });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "\n[timed out after 1s]" }]);
});

test("unknown tools return a useful error", async () => {
  const result = await client.callTool({ name: "missing__tool" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("missing__tool");
});

const success: RunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };

test("selfCommand points to the absolute development entry point", () => {
  expect(selfCommand()).toEqual([process.execPath, cli]);
});

const quietLogs = { log: () => {}, error: () => {} };

test("register removes and re-adds gu in every installed agent, then records it", async () => {
  const calls: string[][] = [];
  const regHome = mkdtempSync(join(tmpdir(), "gu-reg-"));
  const opts = { ...quietLogs, guHome: regHome, which: (cmd: string) => `/bin/${cmd}`, run: async (argv: string[]) => { calls.push(argv); return success; } };
  expect(await register(opts)).toBe(0);
  expect(calls).toEqual([
    ["claude", "plugin", "list", "--json"],
    ["claude", "mcp", "remove", "--scope", "user", "gu"],
    ["claude", "mcp", "add", "--scope", "user", "gu", "--", ...selfCommand(), "serve"],
    ["codex", "mcp", "remove", "gu"],
    ["codex", "mcp", "add", "gu", "--", ...selfCommand(), "serve"],
  ]);
  expect(await isRegistered(opts)).toBe(true);
  // A gu that moved is stale and gets registered again.
  writeFileSync(join(regHome, "registered.json"), JSON.stringify({ command: ["/old/gu"], clients: ["claude", "codex"] }));
  expect(await isRegistered(opts)).toBe(false);
  // A newly installed agent also makes the registration incomplete.
  writeFileSync(join(regHome, "registered.json"), JSON.stringify({ command: selfCommand(), clients: ["claude"] }));
  expect(await isRegistered(opts)).toBe(false);
  rmSync(regHome, { recursive: true, force: true });
});

test("register prints the commands when no agent is installed without running anything", async () => {
  const logs: string[] = [];
  let ran = false;
  expect(await register({ ...quietLogs, log: s => logs.push(s), which: () => null, run: async () => { ran = true; return success; } })).toBe(0);
  expect(ran).toBe(false);
  expect(logs.join("\n")).toContain("claude mcp add --scope user gu --");
  expect(logs.join("\n")).toContain("codex mcp add gu --");
  expect(logs.join("\n")).toContain(cli);
});

test("register reports a failing agent but still registers the others", async () => {
  const errors: string[] = [];
  const regHome = mkdtempSync(join(tmpdir(), "gu-reg-"));
  const run = async (argv: string[]) => argv[0] === "claude" && argv[2] === "add" ? { ...success, exitCode: 2, stderr: "registration failed" } : success;
  expect(await register({ log: () => {}, error: s => errors.push(s), guHome: regHome, which: cmd => `/bin/${cmd}`, run })).toBe(2);
  expect(errors.join("\n")).toContain("registration failed");
  expect(JSON.parse(readFileSync(join(regHome, "registered.json"), "utf8")).clients).toEqual(["codex"]);
  rmSync(regHome, { recursive: true, force: true });
});

test("after an install, agents are connected right away but a person is asked first", async () => {
  const saved = process.env.GU_NO_REGISTER;
  delete process.env.GU_NO_REGISTER;
  try {
    for (const [interactive, answer, expected] of [[false, false, 5], [true, false, 0], [true, true, 5]] as const) {
      const regHome = mkdtempSync(join(tmpdir(), "gu-reg-"));
      const calls: string[][] = [];
      await ensureRegistered({ ...quietLogs, guHome: regHome, interactive, ask: async () => answer, which: cmd => `/bin/${cmd}`, run: async argv => { calls.push(argv); return success; } });
      expect(calls.length).toBe(expected);
      rmSync(regHome, { recursive: true, force: true });
    }
  } finally { if (saved !== undefined) process.env.GU_NO_REGISTER = saved; }
});

for (const stop of ["SIGTERM", "SIGINT", "stdin end"] as const) test(`I8 server ${stop} kills active tool grandchildren`, async () => {
  const name = `lifecycle-${stop.toLowerCase().replace(" ", "-")}`;
  const dir = addProbe(name, `const {spawn} = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"}); fs.writeFileSync(require("node:path").join(process.env.GU_TOOL_DIR, "pids"), JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`, 60);
  const child = Bun.spawn([process.execPath, cli, "serve"], { env: { ...process.env, GU_HOME: home }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  let pids: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: `${name}__probe`, arguments: {} } },
    ]) child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.flush();
    for (let i = 0; i < 150 && !existsSync(join(dir, "pids")); i++) await Bun.sleep(10);
    expect(existsSync(join(dir, "pids"))).toBe(true);
    pids = JSON.parse(readFileSync(join(dir, "pids"), "utf8"));
    expect(alive(pids[1])).toBe(true);
    if (stop === "stdin end") child.stdin.end(); else child.kill(stop);
    for (let i = 0; i < 200 && (alive(pids[1]) || child.exitCode === null); i++) await Bun.sleep(10);
    expect(alive(pids[1])).toBe(false);
    expect(child.exitCode).not.toBeNull();
  } finally {
    if (pids[0]) try { process.kill(-pids[0], "SIGKILL"); } catch {}
    child.kill("SIGKILL"); await child.exited;
  }
}, 5000);

test("reports files the tool wrote in the caller's folder and attaches images", async () => {
  // A 1x1 PNG, written where the agent is working.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  addProbe("writer", `require("node:fs").writeFileSync("out.png", Buffer.from(${JSON.stringify(png)}, "base64")); console.log("wrote out.png");`);
  const result = await client.callTool({ name: "writer__probe" });
  expect(result.isError).toBe(false);
  const content = result.content as any[];
  expect(content[0].text).toBe(`wrote out.png\n\n[exit code 0]\n[gu: files written in ${caller}: out.png]`);
  expect(content[1]).toEqual({ type: "image", data: png, mimeType: "image/png" });
  expect(existsSync(join(caller, "out.png"))).toBe(true);
  rmSync(join(caller, "out.png"));
});

test("tells a connected agent when a tool is installed, so it appears without a new session", async () => {
  const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const watchHome = realpathSync(mkdtempSync(join(tmpdir(), "gu-watch-")));
  const watcher = new Client({ name: "gu-watch-test", version: "1" });
  let changed = 0;
  watcher.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
  await watcher.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve"], env: { GU_HOME: watchHome, GU_POLL_MS: "100" }, cwd: caller, stderr: "pipe" }));
  try {
    expect((await watcher.listTools()).tools).toEqual([]);
    const result = await installTool(join(import.meta.dir, "fixtures/tools/node-echo"), { guHome: watchHome });
    expect(result.ok).toBe(true);
    for (let i = 0; i < 100 && !changed; i++) await Bun.sleep(20);
    expect(changed).toBe(1);
    expect((await watcher.listTools()).tools.map(tool => tool.name)).toEqual(["node-echo__echo"]);
  } finally {
    await watcher.close();
    rmSync(watchHome, { recursive: true, force: true });
  }
}, 30_000);

test("with the gu plugin installed, Claude Code is not given a second gu entry", async () => {
  const regHome = mkdtempSync(join(tmpdir(), "gu-reg-"));
  const calls: string[][] = [];
  let pluginInstalled = true;
  const plugins = () => JSON.stringify(pluginInstalled ? [{ id: "gu@gu", enabled: true, mcpServers: { gu: { command: "npx", env: { GU_PLUGIN: "1" } } } }] : []);
  const opts = { ...quietLogs, guHome: regHome, which: (cmd: string) => `/bin/${cmd}`, run: async (argv: string[]) => {
    calls.push(argv);
    return argv[1] === "plugin" ? { ...success, stdout: plugins() } : success;
  } };
  expect(await register(opts)).toBe(0);
  // The old user-scope entry is removed and not re-added; Codex is still registered.
  expect(calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "gu"]);
  expect(calls.some(argv => argv[0] === "claude" && argv[2] === "add")).toBe(false);
  expect(calls.some(argv => argv[0] === "codex" && argv[2] === "add")).toBe(true);
  expect(await isRegistered(opts)).toBe(true);
  // Uninstalling the plugin makes gu register Claude Code directly again.
  pluginInstalled = false;
  expect(await isRegistered(opts)).toBe(false);
  rmSync(regHome, { recursive: true, force: true });
});

test("a gu run through npx registers the npx command, not npx's temporary cache", async () => {
  const { registrationCommand } = await import("../src/commands/register");
  const { VERSION } = await import("../src/version");
  expect(registrationCommand(["/usr/bin/node", "/home/me/.npm/_npx/abc/node_modules/@njiedev/gu/dist/cli.js"])).toEqual(["npx", "-y", `@njiedev/gu@${VERSION}`]);
  expect(registrationCommand(["/usr/local/bin/gu"])).toEqual(["/usr/local/bin/gu"]);
});
