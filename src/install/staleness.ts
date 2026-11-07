import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INSTALLED_MARKER } from "../manifest/discover";

export interface InstallInfo { installedAt: number; source?: string; origin?: string }

/** The marker records when and from where a copy was installed. Old markers hold only a date. */
export function readInstallInfo(dir: string): InstallInfo | undefined {
  try {
    const text = readFileSync(join(dir, INSTALLED_MARKER), "utf8").trim();
    if (text.startsWith("{")) {
      const info = JSON.parse(text);
      return { installedAt: Date.parse(info.installedAt), source: info.source, origin: info.origin };
    }
    const installedAt = Date.parse(text);
    return Number.isNaN(installedAt) ? undefined : { installedAt };
  } catch { return undefined; }
}

const skipped = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".gu"]);

/** Newest modification time among the source's files, or undefined if it is gone. Bounded for huge trees. */
export function newestChange(root: string, limit = 5000): number | undefined {
  let newest = 0;
  let seen = 0;
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (seen >= limit) return;
      if (skipped.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        seen++;
        try { newest = Math.max(newest, statSync(path).mtimeMs); } catch { /* Raced with a delete. */ }
      }
    }
  }
  try { if (!statSync(root).isDirectory()) return undefined; visit(root); }
  catch { return undefined; }
  return newest;
}

/** A sentence telling the owner their installed copy lags behind their source, if it does. */
export function staleNote(dir: string): string | undefined {
  const info = readInstallInfo(dir);
  if (!info?.source) return undefined;
  const newest = newestChange(info.source);
  if (newest === undefined || newest <= info.installedAt) return undefined;
  return `the source at ${info.source} changed after this copy was installed; run gu install ${info.source} to update it`;
}
