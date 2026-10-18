import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runCommand, toolEnv } from "../src/core/run";
import { ManifestSchema } from "../src/manifest/schema";

const fx = (name: string) => join(import.meta.dir, "fixtures", "scripts", name);
const marker = "\n[gu: output truncated]";
let cwd: string;
let previousHome: string | undefined;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "gu-run-"));
  previousHome = process.env.GU_HOME;
  process.env.GU_HOME = cwd;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = previousHome;
  rmSync(cwd, { recursive: true, force: true });
});

test("stdin is closed so input() fails fast", async () => {
  const r = await runCommand(["python3", fx("asks.py")], { cwd, timeoutSec: 30 });
  expect(r.durationMs).toBeLessThan(5000);
  expect(r.exitCode).not.toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stderr).toContain("EOFError");
});

test("timeout kills the process and its sleeping child", async () => {
  const r = await runCommand(["python3", fx("sleeps.py")], { cwd, timeoutSec: 1 });
  const pid = Number(r.stdout.trim());
  try {
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(5000);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // Allow the OS to reap the orphan after the process group has been killed.
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await Bun.sleep(10);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("metacharacters pass through literally", async () => {
  const r = await runCommand(["python3", fx("echo_args.py"), "a b; rm -rf / $(whoami)"], { cwd, timeoutSec: 10 });
  expect(JSON.parse(r.stdout)).toEqual(["a b; rm -rf / $(whoami)"]);
  expect(r.exitCode).toBe(0);
  expect(r.truncated).toBe(false);
});

for (const cap of [0, 1000, 100_000]) {
  test(`huge output drains both pipes with a ${cap}-byte cap`, async () => {
    const r = await runCommand(["python3", fx("loud.py")], {
      cwd, timeoutSec: 10, ...(cap === 100_000 ? {} : { maxOutputBytes: cap }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.stdout).toBe("x".repeat(cap) + marker);
    expect(r.stderr).toBe("y".repeat(cap) + marker);
  });
}

test("missing command resolves instead of throwing", async () => {
  const r = await runCommand(["definitely-not-a-cmd"], { cwd, timeoutSec: 5 });
  expect(r.exitCode).toBeNull();
  expect(r.stderr).toMatch(/not found|ENOENT/);
  expect(r.timedOut).toBe(false);
});

test("synchronous spawn errors resolve instead of throwing", async () => {
  const r = await runCommand([], { cwd, timeoutSec: 5 });
  expect(r.exitCode).toBeNull();
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("captures exit status, cwd, and supplied environment", async () => {
  const r = await runCommand(["python3", "-c", 'import os,sys; print(os.getcwd()); print(os.environ["GU_RUN_TEST"], file=sys.stderr); sys.exit(7)'], {
    cwd, timeoutSec: 5, env: { ...process.env, GU_RUN_TEST: "value" } as Record<string, string>,
  });
  expect(r.stdout.trim()).toBe(realpathSync(cwd));
  expect(r.stderr).toBe("value\n");
  expect(r.exitCode).toBe(7);
  expect(r.timedOut).toBe(false);
});

test("output exactly at the cap is not truncated", async () => {
  const r = await runCommand(["python3", "-c", 'import sys; sys.stdout.write("abcd")'], { cwd, timeoutSec: 5, maxOutputBytes: 4 });
  expect(r.stdout).toBe("abcd");
  expect(r.stderr).toBe("");
  expect(r.truncated).toBe(false);
});

test("toolEnv prefixes existing local bins and preserves the host environment", () => {
  const loaded = { dir: cwd, manifest: ManifestSchema.parse({
    name: "example", version: 1, description: "Example", use_when: "Testing", platforms: ["macos", "linux"],
    tools: [{ name: "example", run: "python3" }], test: { run: "python3", expect: { exit_code: 0 } },
  }) };
  const originalPath = process.env.PATH;
  expect(toolEnv(loaded).PATH ?? "").toBe(originalPath ?? "");
  const pythonBin = join(cwd, ".venv", "bin");
  const nodeBin = join(cwd, "node_modules", ".bin");
  mkdirSync(nodeBin, { recursive: true });
  expect(toolEnv(loaded).PATH).toBe([nodeBin, ...(originalPath ? [originalPath] : [])].join(delimiter));
  mkdirSync(pythonBin, { recursive: true });
  const env = toolEnv(loaded);
  expect(env.PATH).toBe([pythonBin, nodeBin, ...(originalPath ? [originalPath] : [])].join(delimiter));
  expect(env.GU_HOME).toBe(cwd);
  expect(process.env.PATH).toBe(originalPath);
});
