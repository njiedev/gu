import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { LoadedTool } from "../manifest/discover";

const activeProcessGroups = new Set<number>();

export function killAllActive(): void {
  for (const pid of activeProcessGroups) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(`Could not stop tool process group ${pid}: ${String(error)}`);
    }
    activeProcessGroups.delete(pid);
  }
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export function runCommand(argv: string[], opts: {
  cwd: string;
  timeoutSec: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}): Promise<RunResult> {
  const started = performance.now();
  return new Promise(resolve => {
    const cap = opts.maxOutputBytes ?? 100_000;
    const capture = () => {
      const chunks: Buffer[] = [];
      let length = 0;
      let truncated = false;
      return {
        append(chunk: Buffer) {
          const remaining = Math.max(0, cap - length);
          if (chunk.length > remaining) truncated = true;
          if (remaining > 0) {
            // Copy the retained bytes so a tiny slice cannot retain a large chunk.
            const kept = Buffer.from(chunk.subarray(0, remaining));
            chunks.push(kept);
            length += kept.length;
          }
          // Always drain data, even once this stream reaches the cap.
        },
        text: () => Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[gu: output truncated]" : ""),
        truncated: () => truncated,
      };
    };
    const stdout = capture();
    const stderr = capture();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let spawnFailed = false;
    let groupPid: number | undefined;
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      if (groupPid !== undefined) activeProcessGroups.delete(groupPid);
      resolve({
        exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut,
        truncated: stdout.truncated() || stderr.truncated(),
        durationMs: performance.now() - started,
      });
    };
    const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
    try {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      groupPid = child.pid;
      if (groupPid !== undefined) activeProcessGroups.add(groupPid);
      child.stdout.on("data", chunk => stdout.append(chunk));
      child.stderr.on("data", chunk => stderr.append(chunk));
      child.on("error", error => {
        spawnFailed = true;
        stderr.append(Buffer.from(error.message));
      });
      child.on("close", code => finish(spawnFailed ? null : code));
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            // The group may have exited just before the timeout fired.
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              stderr.append(Buffer.from(errorMessage(error)));
            }
          }
        }
      }, opts.timeoutSec * 1000);
    } catch (error) {
      stderr.append(Buffer.from(errorMessage(error)));
      finish(null);
    }
  });
}

export function toolEnv(loaded: LoadedTool): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const bins = [join(loaded.dir, ".venv", "bin"), join(loaded.dir, "node_modules", ".bin")]
    .filter(path => existsSync(path));
  if (bins.length) env.PATH = [...bins, ...(env.PATH ? [env.PATH] : [])].join(delimiter);
  return env;
}
