import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publish, publishCommand } from "../src/commands/publish";
import { writeDraft } from "../src/draft/write";
import { DraftError, type DraftResult } from "../src/draft/drafter";
import { parseManifest } from "../src/manifest/schema";
let temp: string, repo: string, guHome: string, oldHome: string | undefined;
const yamlText = readFileSync(join(import.meta.dir, "fixtures/tools/py-echo/gu.yaml"), "utf8");
const parsed = parseManifest(yamlText);
if (!parsed.ok) throw new Error(parsed.errors.join());
const manifest = parsed.manifest;
const result = (): DraftResult => ({ tools: [{ folder: ".", manifest, yamlText }], fixtures: [{ folder: ".", path: ".gu/test/input.txt", content: "hello" }], unsupported: [], filesSent: 2, totalFiles: 3, rounds: 1, modelId: "stub", usage: { inputTokens: 0, outputTokens: 0 } });
const stub = async () => result();
const quiet = () => {};
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "gu-publish-")); repo = join(temp, "repo"); guHome = join(temp, "home");
  oldHome = process.env.GU_HOME; process.env.GU_HOME = guHome;
  cpSync(join(import.meta.dir, "fixtures/tools/py-echo"), repo, { recursive: true }); rmSync(join(repo, "gu.yaml"));
});
afterEach(() => { rmSync(temp, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.GU_HOME; else process.env.GU_HOME = oldHome; });
test("declining writes nothing and runs no fixture command", async () => {
  const drafted = result(); drafted.fixtures.push({ folder: ".", path: ".gu/test/command.txt", command: `node -e 'require("fs").writeFileSync("marker", "ran")'` });
  const r = await publish(repo, { draftFn: async () => drafted, confirm: async summary => {
    expect(summary).toContain("py-echo"); expect(summary).toContain("Echo a string"); expect(summary).toContain("python3 echo.py");
    expect(summary).toContain(drafted.fixtures[1]!.command!); expect(summary).toContain("AI looked at 2 of 3 files");
    expect(existsSync(join(repo, "gu.yaml"))).toBe(false); return false;
  }, guHome, log: quiet });
  expect(existsSync(join(repo, "gu.yaml"))).toBe(false); expect(existsSync(join(repo, ".gu"))).toBe(false); expect(existsSync(join(repo, "marker"))).toBe(false); expect(r.installed).toEqual([]);
});
test("accepting writes gu.yaml + fixtures and installs", async () => {
  const logs: string[] = [];
  const r = await publish(repo, { draftFn: stub, confirm: async () => true, guHome, log: s => logs.push(s) });
  expect(readFileSync(join(repo, "gu.yaml"), "utf8")).toBe(yamlText);
  expect(readFileSync(join(repo, ".gu/test/input.txt"), "utf8")).toBe("hello");
  expect(r.installed).toEqual(["py-echo"]); expect(r.failed).toEqual([]);
  expect(existsSync(join(guHome, "tools/py-echo/1/.gu/test/input.txt"))).toBe(true);
  expect(logs.join("\n")).toContain("Next: run `gu register` once so your agents can see these tools.");
}, 120000);
test("existing nested gu.yaml is installed after confirmation without drafting and skips generated folders", async () => {
  const nested = join(repo, "nested"); cpSync(join(import.meta.dir, "fixtures/tools/py-echo"), nested, { recursive: true }); writeFileSync(join(nested, "gu.yaml"), yamlText);
  for (const dir of [".git", "node_modules", ".venv", "__pycache__", "dist", "build"]) { mkdirSync(join(repo, dir)); writeFileSync(join(repo, dir, "gu.yaml"), "invalid"); }
  const r = await publish(repo, { draftFn: async () => { throw new Error("should not draft"); }, confirm: async () => true, guHome, log: quiet });
  expect(r.installed).toEqual(["py-echo"]); expect(r.failed).toEqual([]);
}, 120000);
test("unsupported folders are reported, not installed; redraft bypasses existing manifests", async () => {
  writeFileSync(join(repo, "gu.yaml"), yamlText);
  const drafted = result(); drafted.tools = []; drafted.fixtures = []; drafted.unsupported = [{ folder: "server", kind: "server", reason: "Needs a running server" }];
  const r = await publish(repo, { redraft: true, draftFn: async () => drafted, confirm: async summary => { expect(summary).toContain("server: Needs a running server"); return true; }, guHome, log: quiet });
  expect(r.unsupported).toEqual(drafted.unsupported); expect(r.installed).toEqual([]);
});
test("writeDraft runs commands in the tool folder without a shell and reports failures", async () => {
  const drafted = result(); drafted.tools = [];
  drafted.fixtures = [
    { folder: ".", path: ".gu/test/command.txt", command: `node -e 'require("fs").writeFileSync(".gu/test/command.txt", process.argv[1])' 'literal; echo nope'` },
    { folder: ".", path: ".gu/test/fail.txt", command: `node -e 'process.exit(7)'` },
    { folder: ".", path: ".gu/test/..valid.txt", content: "valid" },
  ];
  const r = await writeDraft(repo, drafted);
  expect(readFileSync(join(repo, ".gu/test/command.txt"), "utf8")).toBe("literal; echo nope");
  expect(readFileSync(join(repo, ".gu/test/..valid.txt"), "utf8")).toBe("valid");
  expect(r.fixtureErrors).toHaveLength(1); expect(r.fixtureErrors[0]!.message).toContain("7");
});
test("writeDraft rejects escaped fixture paths and symlink destinations", async () => {
  mkdirSync(join(repo, ".gu/test"), { recursive: true }); symlinkSync(temp, join(repo, ".gu/test/link"));
  const drafted = result(); drafted.tools = [];
  drafted.fixtures = [".gu/test/../../../escape", ".gu/test/../escape", ".gu/test/link/escape", join(temp, "escape")].map(path => ({ folder: ".", path, content: "bad" }));
  const r = await writeDraft(repo, drafted); expect(r.fixtureErrors).toHaveLength(4); expect(existsSync(join(temp, "escape"))).toBe(false);
});
test("CLI wrapper prints DraftError without a stack trace", async () => {
  const logs: string[] = [];
  expect(await publishCommand([], { repoRoot: repo, draftFn: async () => { throw new DraftError("Could not draft this tool."); }, log: s => logs.push(s) })).toBe(1);
  expect(logs).toEqual(["Could not draft this tool."]);
});
test("CLI missing API key is plain English and exits 1", () => {
  const env = { ...process.env, GU_LLM: "anthropic", ANTHROPIC_API_KEY: "" };
  const r = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), "publish", "--yes"], { timeout: 10_000, cwd: repo, env });
  expect(r.exitCode).toBe(1); expect(r.stderr.toString()).toContain("ANTHROPIC_API_KEY"); expect(r.stderr.toString()).not.toContain(" at ");
});
test("stdin confirmation defaults to No on blank input or EOF and accepts yes", () => {
  const drafted = result(); drafted.tools = [];
  const source = `import { publish } from ${JSON.stringify(resolve("src/commands/publish.ts"))}; await publish(${JSON.stringify(repo)}, { draftFn: async () => (${JSON.stringify(drafted)}) });`;
  for (const answer of ["\n", "", "yes\n"]) {
    const child = Bun.spawnSync([process.execPath, "-e", source], { timeout: 10_000, env: process.env, stdin: Buffer.from(answer) });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("(y/N)");
    expect(existsSync(join(repo, ".gu/test/input.txt"))).toBe(answer === "yes\n");
  }
});
test("installation failures are returned with their folder", async () => {
  writeFileSync(join(repo, "gu.yaml"), "invalid");
  const r = await publish(repo, { confirm: async () => true, guHome, log: quiet });
  expect(r.installed).toEqual([]); expect(r.failed).toHaveLength(1); expect(r.failed[0]!.folder).toBe(".");
});
test("--yes writes the draft without prompting", async () => {
  const drafted = result(); drafted.tools = [];
  expect(await publishCommand(["--yes"], { repoRoot: repo, draftFn: async () => drafted, log: quiet })).toBe(0);
  expect(readFileSync(join(repo, ".gu/test/input.txt"), "utf8")).toBe("hello");
});

test("declining existing manifests lists name version and folder and installs nothing", async () => {
  writeFileSync(join(repo, "gu.yaml"), yamlText);
  let confirmed = false;
  const r = await publish(repo, { draftFn: async () => { throw new Error("should not draft"); }, confirm: async summary => {
    confirmed = true;
    expect(summary).toContain("py-echo");
    expect(summary).toContain("version 1");
    expect(summary).toContain("folder: .");
    expect(summary).toContain("installed and tested");
    expect(existsSync(guHome)).toBe(false);
    return false;
  }, guHome, log: quiet });
  expect(confirmed).toBe(true);
  expect(r.installed).toEqual([]);
  expect(existsSync(guHome)).toBe(false);
});
test("--yes installs existing manifests without prompting", () => {
  writeFileSync(join(repo, "gu.yaml"), yamlText);
  const child = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), "publish", "--yes"], { timeout: 10_000, cwd: repo, env: process.env, stdin: Buffer.from("") });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).not.toContain("(y/N)");
  expect(existsSync(join(guHome, "tools/py-echo/1/gu.yaml"))).toBe(true);
});
test("writeDraft refuses a dangling symlink at a fixture destination", async () => {
  mkdirSync(join(repo, ".gu/test"), { recursive: true });
  const outside = join(temp, "outside-fixture");
  symlinkSync(outside, join(repo, ".gu/test/input.txt"));
  const drafted = result(); drafted.tools = [];
  const r = await writeDraft(repo, drafted);
  expect(r.fixtureErrors).toHaveLength(1);
  expect(r.fixtureErrors[0]!.message).toContain("symbolic link");
  expect(existsSync(outside)).toBe(false);
  expect(r.written).toEqual([]);
});
test("writeDraft refuses a dangling symlink at the gu.yaml destination", async () => {
  const outside = join(temp, "outside-manifest");
  symlinkSync(outside, join(repo, "gu.yaml"));
  await expect(writeDraft(repo, result())).rejects.toThrow("symbolic link");
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(join(repo, ".gu"))).toBe(false);
});
test("writeDraft refuses symlink ancestors even when they point inside the repo", async () => {
  mkdirSync(join(repo, "actual"));
  symlinkSync(join(repo, "actual"), join(repo, "linked"));
  const drafted = result();
  drafted.tools[0]!.folder = "linked";
  await expect(writeDraft(repo, drafted)).rejects.toThrow("symbolic link");
  expect(existsSync(join(repo, "actual/gu.yaml"))).toBe(false);
});
test("writeDraft refuses fixture commands in symlinked folders", async () => {
  mkdirSync(join(repo, "actual"));
  symlinkSync(join(repo, "actual"), join(repo, "linked"));
  const drafted = result(); drafted.tools = [];
  drafted.fixtures = [{ folder: "linked", path: ".gu/test/output.txt", command: 'node -e \'require("fs").writeFileSync("marker", "ran")\'' }];
  const r = await writeDraft(repo, drafted);
  expect(r.fixtureErrors).toHaveLength(1);
  expect(r.fixtureErrors[0]!.message).toContain("symbolic link");
  expect(existsSync(join(repo, "actual/marker"))).toBe(false);
  expect(existsSync(join(repo, "actual/.gu"))).toBe(false);
});

test("I3 failed fixture generation blocks only its folder and makes CLI fail", async () => {
  const drafted = result();
  const otherYaml = yamlText.replace("name: py-echo", "name: other");
  const other = parseManifest(otherYaml); if (!other.ok) throw new Error(other.errors.join());
  cpSync(join(import.meta.dir, "fixtures/tools/py-echo"), join(repo, "other"), { recursive: true });
  drafted.tools.push({ folder: "other", manifest: other.manifest, yamlText: otherYaml });
  drafted.fixtures.push({ folder: "./", path: ".gu/test/fail.txt", command: "node -e 'process.exit(7)'" });
  const r = await publish(repo, { redraft: true, draftFn: async () => drafted, confirm: async () => true, guHome, log: quiet });
  expect(r.installed).toEqual(["other"]);
  expect(r.failed).toHaveLength(1);
  expect(r.failed[0].folder).toBe("./");
  expect(r.failed[0].message).toContain("exit code 7");
  expect(existsSync(join(guHome, "tools", "py-echo", "1"))).toBe(false);
  expect(await publishCommand(["--yes", "--redraft"], { repoRoot: repo, draftFn: async () => drafted, log: quiet })).toBe(1);
});

test("I4 writeDraft refuses system installers before executing them", async () => {
  const bin = join(temp, "bin"); mkdirSync(bin);
  for (const command of ["brew", "apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "zypper", "port", "snap", "winget", "choco", "scoop", "sudo", "su", "doas"]) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!${process.execPath}\nrequire("fs").writeFileSync("installer-ran", "bad");`, { mode: 0o755 });
    const drafted = result(); drafted.tools = [];
    drafted.fixtures = [{ folder: ".", path: ".gu/test/x", command: `'${executable}' install package` }];
    const written = await writeDraft(repo, drafted);
    expect(written.fixtureErrors).toHaveLength(1);
    expect(written.fixtureErrors[0].message).toContain(command);
    expect(existsSync(join(repo, "installer-ran"))).toBe(false);
  }
});

test("M2 approval includes full YAML and fixture paths with UTF-8 sizes", async () => {
  const drafted = result();
  drafted.fixtures[0].content = "é😀 private fixture text";
  await publish(repo, { draftFn: async () => drafted, confirm: async summary => {
    expect(summary).toContain(yamlText);
    expect(summary).toContain("gu.yaml");
    expect(summary).toContain(".gu/test/input.txt");
    expect(summary).toContain(`${Buffer.byteLength(drafted.fixtures[0].content!)} bytes`);
    expect(summary).not.toContain(drafted.fixtures[0].content!);
    return false;
  }, guHome, log: quiet });
});
