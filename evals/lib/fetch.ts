import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EvalCase } from "./types";

async function git(args: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function ensureClone(c: EvalCase, cacheDir: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) throw new Error(`Invalid case id: ${c.id}`);
  if (c.commit !== null && !/^[a-f0-9]{40}$/i.test(c.commit)) throw new Error("Case commit must be a full Git SHA or null.");
  const cache = resolve(cacheDir);
  const clone = join(cache, c.id);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(clone)) await git(["clone", "--", c.repo, clone]);
  const normalize = (url: string) => url.replace(/\/$/, "").replace(/\.git$/, "");
  if (normalize(await git(["remote", "get-url", "origin"], clone)) !== normalize(c.repo)) throw new Error(`Cached origin does not match ${c.repo}.`);
  if (await git(["status", "--porcelain", "--untracked-files=all"], clone)) throw new Error(`Cached clone ${c.id} has local changes; refusing to overwrite them.`);
  if (c.commit !== null) {
    try { await git(["cat-file", "-e", `${c.commit}^{commit}`], clone); }
    catch { await git(["fetch", "origin", c.commit], clone); }
    await git(["checkout", "--detach", c.commit], clone);
  } else {
    const sha = await git(["rev-parse", "HEAD"], clone);
    // cacheDir and cases are siblings, also allowing isolated local-Git tests.
    const path = join(dirname(cache), "cases", `${c.id}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")) as EvalCase;
    if (saved.id !== c.id || saved.repo !== c.repo || saved.commit !== null) throw new Error(`Case ${c.id} changed while pinning.`);
    writeFileSync(path, JSON.stringify({ ...saved, commit: sha }, null, 2) + "\n");
    c.commit = sha;
    await git(["checkout", "--detach", sha], clone);
  }
  return clone;
}
