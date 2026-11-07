import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runCommand } from "../core/run";
import { installTool } from "../install/install";
import { findCards } from "../manifest/find";
import { parseManifest, type Manifest } from "../manifest/schema";
import { which } from "../which";
import { ensureRegistered } from "./register";

const USAGE = "Usage: gu install <folder | github.com/<owner>/<repo>[@branch|tag|commit]> [--yes]";

/** github.com/owner/repo, optionally with https://, .git and @ref. */
export function parseGithubSpec(spec: string): { url: string; label: string; ref?: string } | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:@([^\s@]+))?$/.exec(spec);
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  const [, owner, repo, ref] = match;
  if (ref?.startsWith("-")) return undefined; // Never let a ref become a git option.
  return { url: `https://github.com/${owner}/${repo}.git`, label: `github.com/${owner}/${repo}${ref ? `@${ref}` : ""}`, ref };
}

/** Everything a card will make this computer run, so the owner can decide. */
export function describeCard(folder: string, manifest: Manifest): string {
  const lines = [`${manifest.name} (version ${manifest.version}, folder ${folder}): ${manifest.description}`];
  if (manifest.install?.python) lines.push(`  Sets up Python ${manifest.install.python} with uv${manifest.install.pip ? `, then installs ${manifest.install.pip === "." ? "the package itself" : manifest.install.pip} with pip` : ""}`);
  if (manifest.install?.npm) lines.push("  Runs npm install");
  if (manifest.requires.system.length) lines.push(`  Needs on PATH: ${manifest.requires.system.join(", ")}`);
  if (manifest.env.length) lines.push(`  Asks for: ${manifest.env.map(env => env.name).join(", ")}`);
  lines.push(`  Test command: ${manifest.test.run}`);
  for (const tool of manifest.tools) lines.push(`  Agent tool ${tool.name}: ${tool.run}`);
  return lines.join("\n");
}

function confirm(question: string): Promise<boolean> {
  return new Promise(done => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.once("close", () => done(false));
    input.question(question, answer => { done(/^(y|yes)$/i.test(answer.trim())); input.close(); });
  });
}

type Opts = { log?: (s: string) => void; error?: (s: string) => void; confirm?: (q: string) => Promise<boolean>; guHome?: string; register?: () => Promise<void>; clone?: (url: string, dir: string, ref?: string) => Promise<string | undefined> };

async function gitClone(url: string, dir: string, ref?: string): Promise<string | undefined> {
  if (!which("git")) return "gu install github.com/… needs git. Install git, then try again.";
  const clone = await runCommand(["git", "clone", "--quiet", "--filter=blob:none", "--", url, dir], { cwd: tmpdir(), timeoutSec: 300, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string> });
  if (clone.timedOut || clone.exitCode !== 0) return `Could not clone ${url}: ${clone.timedOut ? "it took longer than 5 minutes" : clone.stderr.trim() || `git exited with ${clone.exitCode}`}`;
  if (ref) {
    const checkout = await runCommand(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", ref, "--"], { cwd: dir, timeoutSec: 120 });
    if (checkout.timedOut || checkout.exitCode !== 0) return `Could not check out ${ref}: ${checkout.stderr.trim() || `git exited with ${checkout.exitCode}`}`;
  }
  return undefined;
}

export async function installCommand(args: string[], opts: Opts = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;
  const yes = args.includes("--yes");
  const targets = args.filter(arg => arg !== "--yes");
  if (targets.length !== 1 || targets[0].startsWith("-")) { error(USAGE); return 1; }
  const register = opts.register ?? (() => ensureRegistered({ log }));
  const github = parseGithubSpec(targets[0]);
  if (!github) {
    if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//.test(targets[0])) { error(`Not a repository address: ${targets[0]}\n${USAGE}`); return 1; }
    const result = await installTool(targets[0], { guHome: opts.guHome, log });
    if (!result.ok) { error(result.message); return 1; }
    log(`Installed ${result.loaded.manifest.name} (version ${result.loaded.manifest.version}). It passed its test.`);
    await register();
    return 0;
  }

  const scratch = mkdtempSync(join(tmpdir(), "gu-clone-"));
  const checkout = join(scratch, "repo");
  try {
    log(`Cloning ${github.label}.`);
    const cloneError = await (opts.clone ?? gitClone)(github.url, checkout, github.ref);
    if (cloneError) { error(cloneError); return 1; }
    const cards: { folder: string; manifest: Manifest }[] = [];
    let invalid = 0;
    for (const folder of findCards(checkout)) {
      const parsed = parseManifest(readFileSync(join(checkout, folder, "gu.yaml"), "utf8"));
      if (parsed.ok) cards.push({ folder, manifest: parsed.manifest });
      else { invalid++; error(`Skipping ${folder}: its gu.yaml is invalid: ${parsed.errors.join("; ")}`); }
    }
    if (!cards.length) { error(`${github.label} has no gu.yaml cards${invalid ? " that gu can read" : ""}. Its owner can add them with gu publish.`); return 1; }
    log([
      `${github.label} has ${cards.length} tool${cards.length > 1 ? "s" : ""}. Installing runs these commands on this computer with your permissions:`,
      ...cards.map(card => describeCard(card.folder, card.manifest)),
    ].join("\n"));
    if (!yes && !await (opts.confirm ?? confirm)("Only continue if you trust this repository. Install? (y/N) ")) {
      log("Cancelled. Nothing was installed.");
      return 1;
    }
    let failed = invalid;
    let installed = 0;
    for (const card of cards) {
      const result = await installTool(join(checkout, card.folder), { guHome: opts.guHome, log, origin: `${github.label}${card.folder === "." ? "" : ` (${card.folder})`}` });
      if (result.ok) { installed++; log(`Installed ${card.manifest.name}. It passed its test.`); }
      else { failed++; error(result.message); }
    }
    if (installed) await register();
    return failed ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
