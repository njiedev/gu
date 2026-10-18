import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gu-binary-")));
const home = join(scratch, "empty-home");
const binary = join(scratch, "gu");
const cli = resolve(import.meta.dir, "../src/cli.ts");
const env = { ...process.env, GU_HOME: home };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Register real skips with a diagnostic if this host cannot compile Bun binaries.
let buildFailure: string | undefined;
try {
  const build = Bun.spawnSync([process.execPath, "build", "--compile", cli, "--outfile", binary], {
    cwd: scratch, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  if (build.exitCode !== 0) buildFailure = `exit ${build.exitCode}: ${build.stderr.toString()}${build.stdout.toString()}`;
} catch (error) {
  buildFailure = String(error);
}
if (buildFailure) console.warn(`Skipping compiled binary checks: build failed: ${buildFailure}`);

test("source status reports an empty home exactly", () => {
  const result = Bun.spawnSync([process.execPath, cli, "status"], { timeout: 10_000, env });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe("No tools installed yet.\n");
});

test.skipIf(Boolean(buildFailure))("compiled binary reports its version and empty status", () => {
  for (const [command, output] of [["--version", "0.1.0\n"], ["status", "No tools installed yet.\n"]] as const) {
    const result = Bun.spawnSync([binary, command], { timeout: 10_000, env: { GU_HOME: home, PATH: "" }, cwd: scratch });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(output);
  }
});

test.skipIf(Boolean(buildFailure))("compiled serve lists no tools in an empty home", async () => {
  const client = new Client({ name: "gu-binary-test", version: "1" });
  const transport = new StdioClientTransport({
    command: binary, args: ["serve"], cwd: scratch,
    env: { GU_HOME: home, PATH: "" }, stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toEqual([]);
  } finally {
    await client.close();
  }
  expect(diagnostics).toBe("");
}, 15_000);


test.skipIf(Boolean(buildFailure))("compiled register prints only the executable as selfCommand", () => {
  const child = Bun.spawnSync([binary, "register"], { timeout: 10_000, cwd: scratch, env: { PATH: "", GU_HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  expect(child.stdout.toString()).toContain(`claude mcp add --scope user gu -- ${binary} serve`);
  expect(child.stdout.toString()).not.toContain("cli.ts");
});
