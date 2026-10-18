import { existsSync, writeFileSync, cpSync, mkdtempSync, renameSync, lstatSync, readlinkSync, readdirSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseManifest } from "../manifest/schema";
import { INSTALLED_MARKER, type LoadedTool } from "../manifest/discover";
import { guHome, toolsDir } from "../paths";
import { runCommand, toolEnv } from "../core/run";
import { runSmokeTest, type SmokeResult } from "../smoke";
import { checkPlatform } from "./platform";

type InstallResult = { ok: true; loaded: LoadedTool; smoke: SmokeResult } |
  { ok: false; stage: "manifest" | "platform" | "deps" | "smoke"; message: string };
// Resolve existing ancestors too, since a new destination may be under a symlink
// (for example macOS /var -> /private/var).
function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function installTool(srcDir: string, opts: { guHome?: string; dependencyTimeoutSec?: number; log?: (s: string) => void } = {}): Promise<InstallResult> {
  let parsed;
  try { parsed = parseManifest(readFileSync(join(srcDir, "gu.yaml"), "utf8")); }
  catch (error) { return { ok: false, stage: "manifest", message: `Could not read the tool's gu.yaml: ${message(error)}` }; }
  if (!parsed.ok) return { ok: false, stage: "manifest", message: `The tool's gu.yaml is invalid: ${parsed.errors.join("; ")}` };
  const manifest = parsed.manifest;
  const platform = checkPlatform(manifest);
  if (!platform.ok) return { ok: false, stage: "platform", message: `${manifest.name} can't run on this computer: ${platform.reasons.join("; ")}.${platform.installHints.length ? ` Try: ${platform.installHints.join("; ")}.` : ""}` };
  if (manifest.install?.node) {
    const declared = manifest.install.node;
    const requiredMajor = /^v?(\d+)(?:\.|$)/.exec(declared)?.[1];
    const hint = process.platform === "darwin" ? `brew install node@${declared}` : "https://nodejs.org";
    const found = await runCommand(["node", "--version"], { cwd: srcDir, timeoutSec: 10 });
    const version = found.stdout.trim().replace(/^v/, "");
    const availableMajor = /^(\d+)(?:\.|$)/.exec(version)?.[1];
    if (!requiredMajor || !availableMajor || found.exitCode !== 0 || found.timedOut || Number(availableMajor) < Number(requiredMajor)) {
      return { ok: false, stage: "platform", message: `${manifest.name} needs Node ${declared} or newer; this computer has ${availableMajor ? version : "no Node available"}. Try: ${hint}. Checked after ${(found.durationMs / 1000).toFixed(2)} seconds.` };
    }
  }
  const dir = resolve(toolsDir(opts.guHome ?? guHome()), manifest.name, String(manifest.version));
  let stage: "deps" | "smoke" = "deps";
  let installing = false;
  let previousDir: string | undefined;
  let published: InstallResult;
  try {
    const source = realpathSync(srcDir);
    const inside = (parent: string, child: string) => {
      const rel = relative(parent, child);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    const root = resolve(toolsDir(opts.guHome ?? guHome()));
    const destination = canonicalPath(dir);
    if (!inside(canonicalPath(root), destination)) throw new Error("The install folder must stay inside the tool store.");
    for (const path of [root, dirname(dir), dir]) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error(`Cannot install through a symbolic link: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (inside(source, destination) || inside(destination, source)) throw new Error("The source folder and install folder must not contain one another.");
    const excluded = new Set([".git", "node_modules", ".venv", "__pycache__"]);
    function checkLinks(folder: string) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const path = join(folder, entry.name);
        if (entry.isSymbolicLink()) {
          const target = readlinkSync(path);
          if (isAbsolute(target) || !inside(source, canonicalPath(resolve(folder, target)))) {
            throw new Error(`Cannot install symbolic link outside the source folder: ${path}`);
          }
        } else if (entry.isDirectory()) checkLinks(path);
      }
    }
    checkLinks(source);
    mkdirSync(dirname(dir), { recursive: true });
    if (existsSync(dir) && existsSync(join(dir, INSTALLED_MARKER))) {
      const previous = mkdtempSync(join(dirname(dir), `.previous-${manifest.version}-`));
      rmSync(previous, { recursive: true });
      renameSync(dir, previous);
      previousDir = previous;
    }
    installing = true;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    cpSync(source, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: path => path === source || (!excluded.has(basename(path)) && path !== join(source, INSTALLED_MARKER)) });
    const loaded = { manifest, dir };
    async function dependency(argv: string[]) {
      opts.log?.(`Running ${argv.join(" ")}.`);
      const run = await runCommand(argv, { cwd: dir, env: { ...toolEnv(loaded), npm_config_update_notifier: "false" }, timeoutSec: opts.dependencyTimeoutSec ?? 300 });
      if (run.timedOut || run.exitCode !== 0) throw new Error(`${argv[0]} ${run.timedOut ? "exceeded its time limit" : "could not set up the tool"} after ${(run.durationMs / 1000).toFixed(2)} seconds. ${run.stderr.trim() || run.stdout.trim()}`);
    }
    if (manifest.install?.python) {
      await dependency(["uv", "venv", "--python", manifest.install.python, ".venv"]);
      if (manifest.install.pip) await dependency(["uv", "pip", "install", "--python", join(".venv", "bin", "python"), ...(manifest.install.pip === "." ? ["."] : ["-r", manifest.install.pip])]);
    }
    if (manifest.install?.npm) await dependency(["npm", "install", "--prefer-offline", "--no-audit", "--no-fund"]);
    stage = "smoke";
    const smoke = await runSmokeTest(loaded);
    if (!smoke.passed) throw new Error(`Test failed after ${(smoke.run.durationMs / 1000).toFixed(2)} seconds. ` + smoke.checks.filter(check => !check.passed).map(check => check.detail).join(" ") + (smoke.run.stderr ? ` ${smoke.run.stderr.trim()}` : ""));
    writeFileSync(join(dir, INSTALLED_MARKER), new Date().toISOString() + "\n");
    published = { ok: true, loaded, smoke };
  } catch (error) {
    let cleanup = "";
    if (installing) {
      try { rmSync(dir, { recursive: true, force: true }); }
      catch (error) { cleanup = ` Could not remove the failed install: ${message(error)}`; }
    }
    if (previousDir) {
      try { renameSync(previousDir, dir); }
      catch (error) { cleanup += ` Could not restore the previous install: ${message(error)}`; }
    }
    return { ok: false, stage, message: `${manifest.name} ${stage === "smoke" ? "failed its test" : "could not be installed"}: ${message(error)}${cleanup}` };
  }
  // The new install is verified and published; nothing after this point may undo it.
  if (previousDir) {
    try { rmSync(previousDir, { recursive: true, force: true }); }
    catch (error) {
      try { opts.log?.(`Installed, but could not remove the old copy at ${previousDir}: ${message(error)}`); } catch {}
    }
  }
  return published;
}
