import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Glob pattern to a regular expression: ** spans folders, * and ? stay within one. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; source += "(?:.*/)?"; }
      else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const skipped = new Set([".git", "node_modules", ".venv", "__pycache__"]);

/** Files under cwd (relative, / separated) matching the pattern, hidden files included. */
export function globFiles(pattern: string, cwd: string, limit = 20_000): string[] {
  const matcher = globToRegExp(pattern.replace(/^\.\//, ""));
  const matches: string[] = [];
  let seen = 0;
  function visit(dir: string, prefix: string) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > limit) return;
      const rel = prefix + entry.name;
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) visit(join(dir, entry.name), `${rel}/`); }
      else if (entry.isFile() && matcher.test(rel)) matches.push(rel);
    }
  }
  visit(cwd, "");
  return matches;
}
