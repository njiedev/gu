import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { which } from "../src/which";
import { VERSION } from "../src/version";

// The npm package is a single Node bundle; prove it works without Bun.
const root = resolve(import.meta.dir, "..");
const node = which("node");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gu-npm-")));
const home = join(scratch, "home");
const bundle = join(root, "dist", "cli.js");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("package.json and the CLI agree on the version", () => {
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(VERSION);
});

test.skipIf(!node)("the Node bundle installs a tool and serves it over MCP", async () => {
  const build = Bun.spawnSync([process.execPath, "scripts/build-npm.ts"], { cwd: root, stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const env = { PATH: process.env.PATH ?? "", HOME: scratch, GU_HOME: home, GU_NO_REGISTER: "1" };
  const version = Bun.spawnSync([node!, bundle, "--version"], { env });
  expect(version.stdout.toString()).toBe(`${VERSION}\n`);
  const install = Bun.spawnSync([node!, bundle, "install", join(root, "tests/fixtures/tools/node-echo")], { env, stdin: "ignore" });
  expect(install.stderr.toString()).toBe("");
  expect(install.exitCode).toBe(0);
  const client = new Client({ name: "gu-npm-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: node!, args: [bundle, "serve"], env, cwd: scratch }));
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["node-echo__echo"]);
    const result = await client.callTool({ name: "node-echo__echo", arguments: { text: "from node" } });
    expect(result.content).toEqual([{ type: "text", text: "from node\n\n[exit code 0]" }]);
  } finally { await client.close(); }
}, 60_000);
