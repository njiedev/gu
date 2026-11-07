import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

type Snapshot = Map<string, { mtimeMs: number; size: number }>;

const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_IMAGES = 3;
const MAX_LISTED = 20;

/** Top-level files of the caller's folder; cheap enough for every call. */
export function snapshot(dir: string): Snapshot {
  const files: Snapshot = new Map();
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(join(dir, entry.name));
        files.set(entry.name, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { /* Gone between listing and stat. */ }
    }
  } catch { /* An unreadable folder just means nothing to report. */ }
  return files;
}

export function changedFiles(dir: string, before: Snapshot): string[] {
  const changed: string[] = [];
  for (const [name, stat] of snapshot(dir)) {
    const old = before.get(name);
    if (!old || old.mtimeMs !== stat.mtimeMs || old.size !== stat.size) changed.push(join(dir, name));
  }
  return changed.sort();
}

/** Image paths a tool printed on stdout, resolved against the caller's folder. */
export function mentionedImages(stdout: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const match of stdout.matchAll(/(?:^|[\s"'`(=:])([^\s"'`()]+\.(?:png|jpe?g|gif|webp))\b/gim)) {
    const path = isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]);
    try { if (statSync(path).isFile()) found.add(path); } catch { /* Not a real file. */ }
  }
  return [...found];
}

export type OutputContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** A note naming files the call wrote, plus the images among them for the agent to see. */
export function describeOutputs(cwd: string, written: string[], mentioned: string[]): { note: string; images: OutputContent[] } {
  const show = (path: string) => {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  };
  const note = written.length
    ? `\n[gu: files written in ${cwd}: ${written.slice(0, MAX_LISTED).map(show).join(", ")}${written.length > MAX_LISTED ? `, and ${written.length - MAX_LISTED} more` : ""}]`
    : "";
  const images: OutputContent[] = [];
  for (const path of [...new Set([...written, ...mentioned])]) {
    const mimeType = imageTypes[extname(path).toLowerCase()];
    if (!mimeType || images.length >= MAX_IMAGES) continue;
    try {
      if (statSync(path).size > MAX_IMAGE_BYTES) continue;
      images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType });
    } catch { /* Unreadable images are still listed in the note. */ }
  }
  return { note, images };
}
