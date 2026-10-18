import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "gu-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("gu --version prints the version", async () => {
  const p = Bun.spawnSync(["bun", "src/cli.ts", "--version"], { timeout: 10_000, env: { ...process.env, GU_HOME: home } });
  expect(p.stdout.toString().trim()).toBe("0.1.0");
  expect(p.exitCode).toBe(0);
});

test("unknown command prints usage and exits 1", async () => {
  const p = Bun.spawnSync(["bun", "src/cli.ts", "nope"], { timeout: 10_000, env: { ...process.env, GU_HOME: home } });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain("Usage: gu");
});
