import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedTool } from "./manifest/discover";
import { runCommand, toolEnv, type RunResult } from "./core/run";
import { anchorCommand, splitCommand } from "./core/tools";

export interface SmokeResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  run: RunResult;
}

export async function runSmokeTest(loaded: LoadedTool, home?: string): Promise<SmokeResult> {
  const { expect, run: command } = loaded.manifest.test;
  // Run where an agent would: an empty folder outside the tool. A tool that
  // only works from its own folder fails here instead of in front of the agent.
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), `gu-test-${loaded.manifest.name}-`)));
  function matchingFiles() {
    const files = new Map<string, { mtimeMs: number; ctimeMs: number; size: number }>();
    if (expect.file_exists !== undefined) {
      // Output lands in the working folder, or next to an input under .gu/test/.
      for (const base of [workdir, loaded.dir]) {
        for (const path of new Bun.Glob(expect.file_exists).scanSync({ cwd: base, onlyFiles: true, dot: true })) {
          try {
            const stat = statSync(join(base, path));
            if (stat.isFile()) files.set(join(base, path), stat);
          } catch { /* A disappearing match is not proof of output. */ }
        }
      }
    }
    return files;
  }
  const before = matchingFiles();
  const started = Date.now();
  let run: RunResult;
  try {
    run = await runCommand(anchorCommand(splitCommand(command), loaded.dir), { cwd: workdir, env: toolEnv(loaded, home), timeoutSec: 300 });
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true });
    throw error;
  }
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
  rmSync(workdir, { recursive: true, force: true });
  return { passed: checks.every(check => check.passed), checks, run };
}
