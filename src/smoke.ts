import { statSync } from "node:fs";
import { join } from "node:path";
import type { LoadedTool } from "./manifest/discover";
import { runCommand, toolEnv, type RunResult } from "./core/run";
import { splitCommand } from "./core/tools";

export interface SmokeResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  run: RunResult;
}

export async function runSmokeTest(loaded: LoadedTool): Promise<SmokeResult> {
  const { expect, run: command } = loaded.manifest.test;
  function matchingFiles() {
    const files = new Map<string, { mtimeMs: number; ctimeMs: number; size: number }>();
    if (expect.file_exists !== undefined) {
      for (const path of new Bun.Glob(expect.file_exists).scanSync({ cwd: loaded.dir, onlyFiles: true, dot: true })) {
        try {
          const stat = statSync(join(loaded.dir, path));
          if (stat.isFile()) files.set(path, stat);
        } catch { /* A disappearing match is not proof of output. */ }
      }
    }
    return files;
  }
  const before = matchingFiles();
  const started = Date.now();
  const run = await runCommand(splitCommand(command), { cwd: loaded.dir, env: toolEnv(loaded), timeoutSec: 300 });
  const checks: SmokeResult["checks"] = [{
    name: "exit_code", passed: !run.timedOut && run.exitCode === expect.exit_code,
    detail: run.timedOut ? "The test took longer than 300 seconds." : `Expected exit code ${expect.exit_code}; got ${run.exitCode ?? "a process that could not run"}.`,
  }];
  if (expect.stdout_contains !== undefined) checks.push({
    name: "stdout_contains", passed: run.stdout.includes(expect.stdout_contains),
    detail: `Expected output to contain ${JSON.stringify(expect.stdout_contains)}.`,
  });
  if (expect.file_exists !== undefined) {
    // Allow coarse filesystem timestamps, but never accept an untouched old match.
    const fresh = [...matchingFiles()].some(([path, stat]) => {
      const old = before.get(path);
      const changed = !old || old.mtimeMs !== stat.mtimeMs || old.ctimeMs !== stat.ctimeMs || old.size !== stat.size;
      return changed && stat.mtimeMs >= started - 1000;
    });
    checks.push({ name: "file_exists", passed: fresh, detail: `Expected a newly written file matching ${expect.file_exists}.` });
  }
  return { passed: checks.every(check => check.passed), checks, run };
}
