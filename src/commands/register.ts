import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runCommand, type RunResult } from "../core/run";
import { guHome } from "../paths";
import { which } from "../which";
import { VERSION } from "../version";

export function selfCommand(): string[] {
  const here = fileURLToPath(import.meta.url);
  // Bun's compiled modules live in its virtual filesystem.
  if (here.startsWith("/$bunfs/") || here.includes("~BUN")) return [process.execPath];
  // From source (src/commands) or from the npm bundle (dist/cli.js).
  const entry = here.endsWith(".ts") ? resolve(dirname(here), "../cli.ts") : resolve(dirname(here), "cli.js");
  return [process.execPath, entry];
}

/**
 * The command agents should launch. A gu run through npx lives in a cache npm
 * may delete, so register the npx command itself instead of that path.
 */
export function registrationCommand(self = selfCommand()): string[] {
  return self.some(part => /[\\/]_npx[\\/]/.test(part)) ? ["npx", "-y", `@njiedev/gu@${VERSION}`] : self;
}

/** Whether Claude Code already runs gu through the gu plugin. */
export async function claudePluginActive(run: (argv: string[]) => Promise<RunResult>, find: (cmd: string) => string | null): Promise<boolean> {
  if (!find("claude")) return false;
  const listed = await run(["claude", "plugin", "list", "--json"]);
  if (listed.timedOut || listed.exitCode !== 0) return false;
  try {
    const plugins = JSON.parse(listed.stdout) as { enabled?: boolean; mcpServers?: Record<string, { env?: Record<string, string> }> }[];
    return plugins.some(plugin => plugin.enabled !== false && Object.values(plugin.mcpServers ?? {}).some(server => server.env?.GU_PLUGIN === "1"));
  } catch { return false; }
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

interface Registration { command: string[]; clients: string[]; claudePlugin?: boolean }
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
  const command = registrationCommand();
  const present = CLIENTS.filter(client => find(client.program));
  if (!present.length) {
    log(`Neither Claude Code nor Codex was found on PATH. After installing one, run gu register, or run one of these:\n${CLIENTS.map(client => client.add(command).map(shellQuote).join(" ")).join("\n")}\nAny other MCP client can launch: ${[...command, "serve"].map(shellQuote).join(" ")}`);
    return 0;
  }
  const registered: string[] = [];
  let failure = 0;
  const viaPlugin = await claudePluginActive(run, find);
  for (const client of present) {
    await run(client.remove); // Absent entries fail harmlessly.
    if (client.program === "claude" && viaPlugin) {
      // A second gu entry would show Claude every tool twice.
      log("Claude Code gets gu from the gu plugin, so gu did not add a separate entry.");
      continue;
    }
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
  if (registered.length) log("Start a new session in your agent to use gu's tools: agents load MCP servers when a session starts.");
  if (registered.length || viaPlugin) {
    const home = opts.guHome ?? guHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(registrationFile(home), JSON.stringify({ command, clients: registered, claudePlugin: viaPlugin } satisfies Registration, null, 2) + "\n");
  }
  return failure;
}

/** True when every installed agent already reaches this gu, exactly once. */
export async function isRegistered(opts: Pick<Opts, "which" | "guHome" | "run"> = {}): Promise<boolean> {
  const saved = readRegistration(opts.guHome ?? guHome());
  if (!saved || JSON.stringify(saved.command) !== JSON.stringify(registrationCommand())) return false;
  const find = opts.which ?? which;
  const run = opts.run ?? (argv => runCommand(argv, { cwd: process.cwd(), timeoutSec: 30 }));
  // The plugin may have been installed or removed since gu last registered.
  if (find("claude") && await claudePluginActive(run, find) !== Boolean(saved.claudePlugin)) return false;
  return CLIENTS.every(client => !find(client.program) || saved.clients.includes(client.program) || (client.program === "claude" && saved.claudePlugin));
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
  if (process.env.GU_NO_REGISTER) return;
  const log = opts.log ?? console.log;
  if (await isRegistered(opts)) {
    log("Agents already connected to gu see new and updated tools in their current session.");
    return;
  }
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && !await (opts.ask ?? askYes)("Connect gu to your agents (Claude Code, Codex) now? (Y/n) ")) {
    log("Skipped. Run `gu register` when you want your agents to see these tools.");
    return;
  }
  await register(opts);
}
