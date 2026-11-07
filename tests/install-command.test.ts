import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, parseGithubSpec } from "../src/commands/install";

const fixture = (name: string) => join(import.meta.dir, "fixtures", "tools", name);
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "gu-install-cmd-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("parses GitHub addresses with optional scheme, .git and @ref", () => {
  expect(parseGithubSpec("github.com/njiedev/tools")).toEqual({ url: "https://github.com/njiedev/tools.git", label: "github.com/njiedev/tools", ref: undefined });
  expect(parseGithubSpec("https://github.com/njiedev/tools.git@v1.2")).toEqual({ url: "https://github.com/njiedev/tools.git", label: "github.com/njiedev/tools@v1.2", ref: "v1.2" });
  expect(parseGithubSpec("github.com/a/b@feature/x")?.ref).toBe("feature/x");
  for (const bad of ["github.com/a", "github.com/a/b/c", "github.com/a/..", "github.com/a/b@--upload-pack=x", "./tools", "gitlab.com/a/b"]) expect(parseGithubSpec(bad)).toBeUndefined();
});

// Stands in for git: a "repository" with two cards in nested folders.
const fakeClone = async (_url: string, dir: string) => {
  mkdirSync(join(dir, "tools"), { recursive: true });
  cpSync(fixture("node-echo"), join(dir, "tools", "node-echo"), { recursive: true });
  cpSync(fixture("py-echo"), join(dir, "py-echo"), { recursive: true });
  return undefined;
};

test("a GitHub install shows what will run, and installs nothing when declined", async () => {
  const logs: string[] = [];
  const questions: string[] = [];
  const code = await installCommand(["github.com/someone/tools"], { guHome: home, clone: fakeClone, log: s => logs.push(s), error: s => logs.push(s), confirm: async q => { questions.push(q); return false; }, register: async () => { throw new Error("must not register"); } });
  expect(code).toBe(1);
  const shown = logs.join("\n");
  expect(shown).toContain("has 2 tools");
  expect(shown).toContain("Test command: node echo.js hello-gu");
  expect(shown).toContain("Agent tool echo: node echo.js");
  expect(questions[0]).toContain("trust this repository");
  expect(existsSync(join(home, "tools"))).toBe(false);
});

test("--yes installs every card in the repository and then connects the agents", async () => {
  let registered = 0;
  const code = await installCommand(["github.com/someone/tools@main", "--yes"], { guHome: home, clone: fakeClone, log: () => {}, error: () => {}, register: async () => { registered++; } });
  expect(code).toBe(0);
  expect(existsSync(join(home, "tools", "node-echo", "1", ".gu-installed"))).toBe(true);
  expect(existsSync(join(home, "tools", "py-echo", "1", ".gu-installed"))).toBe(true);
  expect(registered).toBe(1);
}, 60_000);

test("clone failures and repositories without cards are explained", async () => {
  const errors: string[] = [];
  expect(await installCommand(["github.com/a/b", "--yes"], { guHome: home, clone: async () => "Could not clone: not found", log: () => {}, error: s => errors.push(s) })).toBe(1);
  expect(await installCommand(["github.com/a/b", "--yes"], { guHome: home, clone: async (_u, dir) => { mkdirSync(dir); return undefined; }, log: () => {}, error: s => errors.push(s) })).toBe(1);
  expect(await installCommand(["github.com/a", "--yes"], { guHome: home, log: () => {}, error: s => errors.push(s) })).toBe(1);
  expect(errors[0]).toContain("not found");
  expect(errors[1]).toContain("has no gu.yaml cards");
  expect(errors[2]).toContain("Not a repository address");
});
