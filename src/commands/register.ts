import { resolve } from "node:path";
import { runCommand, type RunResult } from "../core/run";

export function selfCommand(): string[] {
  // Bun's compiled modules live in its virtual filesystem.
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, "../cli.ts")];
}

function shellQuote(arg: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

export async function register(opts: {
  which?: (cmd: string) => string | null;
  run?: (argv: string[]) => Promise<RunResult>;
} = {}): Promise<number> {
  const argv = ["claude", "mcp", "add", "--scope", "user", "gu", "--", ...selfCommand(), "serve"];
  if (!(opts.which ?? Bun.which)("claude")) {
    console.log(`Claude Code was not found on PATH. Run this command after installing it:\n${argv.map(shellQuote).join(" ")}`);
    return 0;
  }
  const run = opts.run ?? (argv => runCommand(argv, { cwd: process.cwd(), timeoutSec: 120 }));
  const result = await run(argv);
  if (result.stdout) console.log(result.stdout.trimEnd());
  if (result.stderr) console.error(result.stderr.trimEnd());
  if (result.timedOut || result.exitCode !== 0) {
    console.error(result.timedOut ? "Registration timed out." : "Could not register gu with Claude Code.");
    return result.exitCode || 1;
  }
  console.log("Registered gu with Claude Code.");
  return 0;
}
