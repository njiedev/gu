import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const skipped = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build"]);

/** Folders under root (root itself is ".") that contain a gu.yaml card. */
export function findCards(root: string): string[] {
  const folders: string[] = [];
  function visit(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.some(entry => entry.name === "gu.yaml" && entry.isFile())) folders.push(relative(root, dir) || ".");
    for (const entry of entries) if (entry.isDirectory() && !skipped.has(entry.name)) visit(join(dir, entry.name));
  }
  visit(root);
  return folders;
}
