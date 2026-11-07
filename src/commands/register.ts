import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runCommand, type RunResult } from "../core/run";
import { guHome } from "../paths";
import { which } from "../which";

export function selfCommand(): string[] {
  const here = fileURLToPath(import.meta.url);
  // Bun's compiled modules live in its virtual filesystem.
  if (here.startsWith("/$bunfs/") || here.includes("~BUN")) return [process.execPath];
  // From source (src/commands) or from the npm bundle (dist/cli.js).
  const entry = here.endsWith(".ts") ? resolve(dirname(here), "../cli.ts") : resolve(dirname(here), "cli.js");
  return [process.execPath, entry];
}

function shellQuote(arg: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

interface Client {
  name: string;
  program: string;
  remove: string[];
  add: (command: string[]) => string[];
}

export const CLIENTS: Client[] = [
  {
    name: "Claude Code", program: "claude",
    remove: ["claude", "mcp", "remove", "--scope", "user", "gu"],
    add: command => ["claude", "mcp", "add", "--scope", "user", "gu", "--", ...command, "serve"],
  },
  {
    name: "Codex", program: "codex",
    remove: ["codex", "mcp", "remove", "gu"],
    add: command => ["codex", "mcp", "add", "gu", "--", ...command, "serve"],
  },
];

interface Registration { command: string[]; clients: string[] }
const registrationFile = (home: string) => join(home, "registered.json");

function readRegistration(home: string): Registration | undefined {
  try { return JSON.parse(readFileSync(registrationFile(home), "utf8")); }
  catch { return undefined; }
}

type Opts = {
  which?: (cmd: string) => string | null;
  run?: (argv: string[]) => Promise<RunResult>;
  guHome?: string;
  log?: (s: string) => void;
  error?: (s: string) => void;
};

/**
 * Connect gu to every installed agent. Re-adding replaces an older entry, so
 * this also fixes a registration that points at a gu that moved.
 */
export async function register(opts: Opts = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;
  const find = opts.which ?? which;
  const run = opts.run ?? (argv => runCommand(argv, { cwd: process.cwd(), timeoutSec: 120 }));
  const command = selfCommand();
  const present = CLIENTS.filter(client => find(client.program));
  if (command.some(part => /[\\/]_npx[\\/]/.test(part))) {
    error("Warning: gu is running from npx's temporary cache, which npm may delete. Install it for good with npm install -g @njiedev/gu, then run gu register.");
  }
  if (!present.length) {
    log(`Neither Claude Code nor Codex was found on PATH. After installing one, run gu register, or run one of these:\n${CLIENTS.map(client => client.add(command).map(shellQuote).join(" ")).join("\n")}\nAny other MCP client can launch: ${[...command, "serve"].map(shellQuote).join(" ")}`);
    return 0;
  }
  const registered: string[] = [];
  let failure = 0;
  for (const client of present) {
    await run(client.remove); // Absent entries fail harmlessly.
    const result = await run(client.add(command));
    if (result.stdout) log(result.stdout.trimEnd());
    if (result.stderr) error(result.stderr.trimEnd());
    if (result.timedOut || result.exitCode !== 0) {
      error(result.timedOut ? `Registering with ${client.name} timed out.` : `Could not register gu with ${client.name}.`);
      failure ||= result.exitCode || 1;
      continue;
    }
    registered.push(client.program);
    log(`Registered gu with ${client.name}.`);
  }
  if (registered.length) {
    const home = opts.guHome ?? guHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(registrationFile(home), JSON.stringify({ command, clients: registered } satisfies Registration, null, 2) + "\n");
  }
  return failure;
}

/** True when every installed agent already points at this gu. */
export function isRegistered(opts: Pick<Opts, "which" | "guHome"> = {}): boolean {
  const saved = readRegistration(opts.guHome ?? guHome());
  if (!saved || JSON.stringify(saved.command) !== JSON.stringify(selfCommand())) return false;
  const find = opts.which ?? which;
  return CLIENTS.every(client => !find(client.program) || saved.clients.includes(client.program));
}

function askYes(question: string): Promise<boolean> {
  return new Promise(done => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.once("close", () => done(false));
    input.question(question, answer => { done(!/^(n|no)$/i.test(answer.trim())); input.close(); });
  });
}

/**
 * Called after a tool installs. An agent running gu has no terminal and is
 * connected right away; a person in a terminal is asked first.
 */
export async function ensureRegistered(opts: Opts & { interactive?: boolean; ask?: (q: string) => Promise<boolean> } = {}): Promise<void> {
  if (process.env.GU_NO_REGISTER || isRegistered(opts)) return;
  const log = opts.log ?? console.log;
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && !await (opts.ask ?? askYes)("Connect gu to your agents (Claude Code, Codex) now? (Y/n) ")) {
    log("Skipped. Run `gu register` when you want your agents to see these tools.");
    return;
  }
  await register(opts);
}
