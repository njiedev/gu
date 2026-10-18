import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderContext } from "../src/draft/prompt";
import { collectContext, MAX_CONTEXT_BYTES, MAX_FILE_BYTES, readRepoFile } from "../src/draft/context";

const messy = join(import.meta.dir, "fixtures", "repos", "messy");
const temp = mkdtempSync(join(tmpdir(), "gu-context-"));
const oldHome = process.env.GU_HOME;
process.env.GU_HOME = join(temp, "home");
function put(root: string, path: string, content: string | Buffer) {
  const dest = join(root, path);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, content);
}
beforeAll(() => {
  put(messy, "assets/big.bin", Buffer.alloc(200 * 1024));
  put(messy, "node_modules/x/index.js", "generated junk");
});
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
  rmSync(join(messy, "assets"), { recursive: true, force: true });
  rmSync(join(messy, "node_modules"), { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = oldHome;
});
test("sends README, deps and entry points, not junk", () => {
  const c = collectContext(messy);
  expect(c.files.map(f => f.path)).toEqual(["README.md", "requirements.txt", "src/tool/cli.py"]);
  expect(c.fileList.some(p => p.startsWith("node_modules"))).toBe(false);
  expect(c.fileList).toContain("assets/big.bin");
  expect(c.totalFiles).toBe(55);
  expect(c.root).toBe(messy);
});
test("respects the byte budget including truncation markers and UTF-8", () => {
  const root = join(temp, "budget");
  put(root, "README.md", "😀".repeat(50000));
  put(root, "main.py", "print('hello')");
  for (const maxBytes of [0, 1, 20, 21, 22, 23, 500, 150000]) {
    const c = collectContext(root, { maxBytes });
    expect(c.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)).toBeLessThanOrEqual(maxBytes);
    expect(c.files.some(f => f.content.includes("�"))).toBe(false);
  }
  expect(collectContext(root).files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)).toBeLessThanOrEqual(150000);
});
test("readRepoFile refuses escapes, ignored directories, symlinks and binaries", () => {
  const root = join(temp, "safe");
  put(root, "README.md", "safe");
  put(temp, "outside.txt", "secret");
  symlinkSync(join(temp, "outside.txt"), join(root, "link.txt"));
  for (const dir of [".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]) {
    put(root, `${dir}/main.py`, "hidden");
    expect(readRepoFile(root, `${dir}/main.py`).ok).toBe(false);
  }
  symlinkSync(join(root, "node_modules"), join(root, "alias"));
  for (const path of ["../../etc/passwd", join(temp, "outside.txt"), "link.txt", "alias/main.py", "missing", "."]) {
    expect(readRepoFile(root, path).ok).toBe(false);
  }
  expect(readRepoFile(messy, "assets/big.bin").ok).toBe(false);
  expect(collectContext(root).files.map(f => f.path)).toEqual(["README.md"]);
});
test("reads text, detects NUL within first 8 KB, and truncates at default 40,000 bytes", () => {
  const root = join(temp, "read");
  put(root, "text.txt", "a".repeat(50000));
  const result = readRepoFile(root, "text.txt");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(Buffer.byteLength(result.content)).toBe(40000);
    expect(result.content.endsWith("\n[gu: file truncated]")).toBe(true);
  }
  expect(readRepoFile(root, "text.txt", 1).ok).toBe(false);
  put(root, "binary.txt", "a".repeat(8191) + "\0");
  expect(readRepoFile(root, "binary.txt", 100).ok).toBe(false);
  put(root, "late.txt", "a".repeat(8192) + "\0");
  expect(readRepoFile(root, "late.txt").ok).toBe(true);
});
test("prioritizes categories then depth, including package bin targets", () => {
  const root = join(temp, "priority");
  for (const path of ["README", "nested/README.md", "requirements-dev.txt", "pyproject.toml", "setup.py", "setup.cfg", "Cargo.toml", "go.mod", "Dockerfile", "docker-compose.dev.yml", "Makefile", "main.py", "src/cli.py", "bin/custom", "scripts/start.js", "docs/random.md"]) put(root, path, path);
  put(root, "package.json", JSON.stringify({ bin: { tool: "scripts/start.js" } }));
  const sent = collectContext(root).files.map(f => f.path);
  expect(sent.slice(0, 2)).toEqual(["README", "nested/README.md"]);
  expect(sent.indexOf("package.json")).toBeLessThan(sent.indexOf("main.py"));
  expect(sent.indexOf("main.py")).toBeLessThan(sent.indexOf("src/cli.py"));
  expect(sent).toContain("scripts/start.js");
  expect(sent).toContain("bin/custom");
  expect(sent).not.toContain("docs/random.md");
  put(root, "package.json", JSON.stringify({ bin: "scripts/start.js" }));
  expect(collectContext(root).files.map(f => f.path)).toContain("scripts/start.js");
  put(root, "package.json", "malformed");
  expect(() => collectContext(root)).not.toThrow();
});
test("sorts and caps the listing without limiting total count or priority selection", () => {
  const root = join(temp, "large");
  for (let n = 0; n < 2005; n++) put(root, `docs/${String(n).padStart(4, "0")}.md`, "doc");
  put(root, "z/cli.py", "entry");
  const c = collectContext(root);
  expect(c.totalFiles).toBe(2006);
  expect(c.fileList).toHaveLength(2000);
  expect(c.fileList.at(-1)).toBe("… 7 more");
  expect(c.fileList.slice(0, -1)).toEqual([...c.fileList.slice(0, -1)].sort());
  expect(c.files.map(f => f.path)).toEqual(["z/cli.py"]);
});
test("marks truncation when invalid UTF-8 expands beyond the byte budget", () => {
  const root = join(temp, "encoding");
  put(root, "text.txt", Buffer.alloc(30, 255));
  const result = readRepoFile(root, "text.txt", 40);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(40);
    expect(result.content.endsWith("\n[gu: file truncated]")).toBe(true);
  }
  put(root, "plain.txt", "hello 😀\n");
  expect(readRepoFile(root, "plain.txt")).toEqual({ ok: true, content: "hello 😀\n" });
});

test("clamps oversized readRepoFile limits while preserving smaller limits", () => {
  expect(MAX_FILE_BYTES).toBe(40000);
  const root = join(temp, "read-cap");
  put(root, "text.txt", "a".repeat(80000));
  for (const [requested, expected] of [[60000, 40000], [500, 500]]) {
    const result = readRepoFile(root, "text.txt", requested);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.byteLength(result.content)).toBe(expected);
      expect(result.content.endsWith("\n[gu: file truncated]")).toBe(true);
    }
  }
});
test("clamps oversized collectContext budgets while preserving smaller limits", () => {
  expect(MAX_CONTEXT_BYTES).toBe(150000);
  const root = join(temp, "collection-cap");
  for (let n = 0; n < 5; n++) put(root, `README-${n}.md`, "a".repeat(80000));
  for (const [requested, expected] of [[200000, 150000], [500, 500]]) {
    const context = collectContext(root, { maxBytes: requested });
    expect(context.files.reduce((n, file) => n + Buffer.byteLength(file.content), 0)).toBeLessThanOrEqual(expected);
    expect(Buffer.byteLength(renderContext(context))).toBeLessThanOrEqual(expected);
    for (const file of context.files) {
      expect(Buffer.byteLength(file.content)).toBeLessThanOrEqual(40000);
      expect(file.content.endsWith("\n[gu: file truncated]")).toBe(true);
    }
  }
});
