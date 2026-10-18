import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "../core/run";
import { fixtureArgv } from "./fixture-command";
import type { DraftResult } from "./drafter";

// Check the root and every component without following even dangling links.
function refuseSymlinks(root: string, target: string): void {
  let current = root;
  const paths = [root];
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  for (const path of paths) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Cannot write files or run fixture commands through a symbolic link: ${path}`);
  }
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function contained(parent: string, path: string): string {
  const target = resolve(parent, path);
  if (!inside(parent, target)) {
    throw new Error(`Path must stay inside ${parent}: ${path}`);
  }
  refuseSymlinks(parent, target);
  return target;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Write an approved draft. Callers must obtain confirmation before calling. */
export async function writeDraft(repoRoot: string, r: DraftResult): Promise<{
  written: string[]; fixtureErrors: { folder: string; path: string; message: string }[];
}> {
  const root = resolve(repoRoot);
  const written: string[] = [];
  const fixtureErrors: { folder: string; path: string; message: string }[] = [];
  for (const tool of r.tools) {
    const folder = contained(root, tool.folder);
    const path = contained(folder, "gu.yaml");
    mkdirSync(contained(folder, join(".gu", "test")), { recursive: true });
    writeFileSync(path, tool.yamlText);
    written.push(path);
  }
  for (const fixture of r.fixtures) {
    try {
      const folder = contained(root, fixture.folder);
      const testDir = contained(folder, join(".gu", "test"));
      const path = contained(testDir, relative(testDir, resolve(folder, fixture.path)));
      if (path === testDir) throw new Error("A fixture path must name a file inside .gu/test/.");
      mkdirSync(dirname(path), { recursive: true });
      if (fixture.content !== undefined) {
        writeFileSync(path, fixture.content);
        written.push(path);
      }
      if (fixture.command !== undefined) {
        const run = await runCommand(fixtureArgv(fixture.command), { cwd: folder, timeoutSec: 60 });
        if (run.timedOut || run.exitCode !== 0) {
          throw new Error(`Fixture command ${run.timedOut ? "took longer than 60 seconds" : `failed with exit code ${run.exitCode}`}.${run.stderr.trim() ? ` ${run.stderr.trim()}` : ""}`);
        }
      }
    } catch (error) {
      fixtureErrors.push({ folder: fixture.folder, path: join(fixture.folder, fixture.path), message: message(error) });
    }
  }
  return { written, fixtureErrors };
}
