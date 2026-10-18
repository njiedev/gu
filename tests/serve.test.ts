import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installTool } from "../src/install/install";
import { INSTALLED_MARKER } from "../src/manifest/discover";
import { register, selfCommand } from "../src/commands/register";
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
  writeFileSync(join(installed, "echo.py"), 'import sys\nfrom pathlib import Path\nPath("ran").write_text("yes")\nprint(sys.argv[1])\n');
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
  expect(result.content).toEqual([{ type: "text", text: `${dir}\n${join(caller, "input.txt")}\n\n[exit code 0]` }]);
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

test("register runs the exact Claude argv when installed", async () => {
  const calls: string[][] = [];
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await register({ which: cmd => cmd === "claude" ? "/bin/claude" : null, run: async argv => { calls.push(argv); return success; } })).toBe(0);
    expect(calls).toEqual([["claude", "mcp", "add", "--scope", "user", "gu", "--", ...selfCommand(), "serve"]]);
  } finally { output.mockRestore(); }
});

test("register prints the command when Claude is absent without running it", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  let ran = false;
  try {
    expect(await register({ which: () => null, run: async () => { ran = true; return success; } })).toBe(0);
    expect(ran).toBe(false);
    expect(output.mock.calls.flat().join("\n")).toContain("claude mcp add --scope user gu --");
    expect(output.mock.calls.flat().join("\n")).toContain(cli);
  } finally { output.mockRestore(); }
});

test("register propagates command failure", async () => {
  const output = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await register({ which: () => "/bin/claude", run: async () => ({ ...success, exitCode: 2, stderr: "registration failed" }) })).toBe(2);
    expect(output.mock.calls.flat().join("\n")).toContain("registration failed");
  } finally { output.mockRestore(); }
});

for (const stop of ["SIGTERM", "SIGINT", "stdin end"] as const) test(`I8 server ${stop} kills active tool grandchildren`, async () => {
  const name = `lifecycle-${stop.toLowerCase().replace(" ", "-")}`;
  const dir = addProbe(name, `const {spawn} = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"}); fs.writeFileSync("pids", JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`, 60);
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
