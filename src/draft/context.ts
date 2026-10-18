import { renderContext } from "./prompt";
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_CONTEXT_BYTES = 150_000;
export const MAX_FILE_BYTES = 40_000;

export interface RepoContext {
  root: string;
  fileList: string[];
  files: { path: string; content: string }[];
  totalFiles: number;
}

const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);
const marker = "\n[gu: file truncated]";
const entryNames = new Set(["__main__.py", "main.py", "cli.py", "app.py", "index.js", "index.ts"]);
const dependencyNames = new Set(["pyproject.toml", "setup.py", "setup.cfg", "package.json", "Cargo.toml", "go.mod", "Dockerfile", "Makefile"]);

function allowed(root: string, path: string): boolean {
  const rel = relative(root, path);
  const parts = rel.split(sep);
  return !isAbsolute(rel) && parts[0] !== ".." && !parts.slice(0, -1).some(p => ignored.has(p));
}

export function readRepoFile(root: string, relPath: string, maxBytes = MAX_FILE_BYTES): { ok: true; content: string } | { ok: false; error: string } {
  let fd: number | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("The byte limit must be a non-negative integer.");
    maxBytes = Math.min(maxBytes, MAX_FILE_BYTES);
    const base = resolve(root);
    const path = resolve(base, relPath);
    if (!allowed(base, path)) throw new Error("The path is outside the repository or in an ignored directory.");
    const realBase = realpathSync(base);
    const realPath = realpathSync(path);
    if (!allowed(realBase, realPath)) throw new Error("The path resolves outside the repository or into an ignored directory.");
    if (!statSync(realPath).isFile()) throw new Error("The path is not a regular file.");
    fd = openSync(realPath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("The path is not a regular file.");
    // Inspect the full binary probe even when the caller requests a tiny excerpt.
    const probe = Buffer.alloc(Math.min(8192, stat.size));
    const probeSize = readSync(fd, probe, 0, probe.length, 0);
    if (probe.subarray(0, probeSize).includes(0)) throw new Error("Binary files cannot be read as repository context.");
    let truncated = stat.size > maxBytes;
    if (truncated && maxBytes < Buffer.byteLength(marker)) throw new Error("The byte limit is too small for the truncation marker.");
    const size = Math.min(stat.size, truncated ? maxBytes - Buffer.byteLength(marker) : maxBytes);
    const buffer = Buffer.alloc(size);
    let bytes = 0;
    while (bytes < size) {
      const count = readSync(fd, buffer, bytes, size - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    // Streaming decoding leaves an incomplete final UTF-8 character out of an excerpt.
    let content = new TextDecoder().decode(buffer.subarray(0, bytes), { stream: truncated });
    // Invalid source encodings may expand to replacement characters; keep the byte cap exact.
    if (Buffer.byteLength(content) > maxBytes) truncated = true;
    if (truncated && maxBytes < Buffer.byteLength(marker)) throw new Error("The byte limit is too small for the truncation marker.");
    const contentLimit = truncated ? maxBytes - Buffer.byteLength(marker) : maxBytes;
    if (Buffer.byteLength(content) > contentLimit) {
      let used = 0;
      let bounded = "";
      for (const char of content) {
        const width = Buffer.byteLength(char);
        if (used + width > contentLimit) break;
        bounded += char;
        used += width;
      }
      content = bounded;
    }
    return { ok: true, content: content + (truncated ? marker : "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not read the repository file." };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function collectContext(root: string, opts: { maxBytes?: number } = {}): RepoContext {
  let maxBytes = opts.maxBytes ?? MAX_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("The byte limit must be a non-negative integer.");
  maxBytes = Math.min(maxBytes, MAX_CONTEXT_BYTES);
  const base = resolve(root);
  const paths: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) walk(path);
      else if (entry.isFile()) paths.push(path);
      // Do not follow symlinks: they can escape the repo, alias ignored dirs, or cycle.
    }
  }
  walk("");
  paths.sort();
  const binTargets = new Set<string>();
  for (const path of paths.filter(p => basename(p) === "package.json")) {
    const result = readRepoFile(base, path);
    if (!result.ok) continue;
    try {
      const pkg = JSON.parse(result.content);
      const bin = pkg?.bin;
      const targets = typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin) : [];
      for (const target of targets) {
        if (typeof target !== "string") continue;
        const absolute = resolve(base, path, "..", target);
        if (allowed(base, absolute)) binTargets.add(relative(base, absolute));
      }
    } catch { /* An invalid or truncated package file still remains dependency context. */ }
  }
  function priority(path: string): number {
    const name = basename(path);
    if (name.startsWith("README")) return 0;
    if (dependencyNames.has(name) || /^requirements.*\.txt$/.test(name) || /^docker-compose.*\.yml$/.test(name)) return 1;
    if (entryNames.has(name) || path.split(sep).at(-2) === "bin" || binTargets.has(path)) return 2;
    return 3;
  }
  const candidates = paths.filter(p => priority(p) < 3).sort((a, b) =>
    priority(a) - priority(b) || a.split(sep).length - b.split(sep).length || (a < b ? -1 : a > b ? 1 : 0));
  // Reserve a bounded part of the context for the JSON-escaped listing.
  const fileList: string[] = [];
  let listingBytes = 0;
  for (const path of paths) {
    const bytes = Buffer.byteLength(JSON.stringify(path)) + 2;
    if ((fileList.length >= 1999 && paths.length > 2000) || listingBytes + bytes > 50_000 - 64) break;
    fileList.push(path);
    listingBytes += bytes;
  }
  let listedCount = fileList.length;
  if (fileList.length < paths.length) fileList.push(`… ${paths.length - fileList.length} more`);
  const context: RepoContext = { root: base, fileList, files: [], totalFiles: paths.length };
  let renderedBytes = Buffer.byteLength(renderContext(context));
  while (listedCount > 0 && renderedBytes > maxBytes) {
    listedCount--;
    context.fileList = [...paths.slice(0, listedCount), `… ${paths.length - listedCount} more`];
    renderedBytes = Buffer.byteLength(renderContext(context));
  }
  for (const path of candidates) {
    // Measure the actual headers, separators and updated supplied-file count.
    const withEmptyFile = { ...context, files: [...context.files, { path, content: "" }] };
    const overhead = Buffer.byteLength(renderContext(withEmptyFile)) - renderedBytes;
    const remaining = maxBytes - renderedBytes - overhead;
    if (remaining <= 0) break;
    const result = readRepoFile(base, path, Math.min(MAX_FILE_BYTES, remaining));
    if (!result.ok) continue;
    context.files.push({ path, content: result.content });
    renderedBytes += overhead + Buffer.byteLength(result.content);
  }
  return context;
}
