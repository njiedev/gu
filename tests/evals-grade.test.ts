import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseManifest, toMcpTools, type ChatModel, type DraftResult, type Manifest, type Msg, type ToolDef, type Turn } from "../src/index";
import { gradeAgent, gradeSmoke, gradeStructure } from "../evals/lib/grade";
import { pickTool } from "../evals/lib/agent";
import type { EvalCase } from "../evals/lib/types";
import { ensureClone } from "../evals/lib/fetch";
import { evaluateCases, formatReport, parseArgs } from "../evals/run";

let home: string;
let oldHome: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "gu-eval-test-")); oldHome = process.env.GU_HOME; process.env.GU_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.GU_HOME; else process.env.GU_HOME = oldHome; });

function goodDraft(edit?: (m: Manifest) => void): DraftResult {
  const parsed = parseManifest(`name: sample
version: 1
description: Match image colors.
use_when: Transfer a reference image's colors to a source image.
platforms: [macos, linux]
tools:
  - name: match
    run: node smoke.js
    args:
      source: {type: path, flag: -s}
test:
  run: node smoke.js
  expect: {exit_code: 0, stdout_contains: success}
`);
  if (!parsed.ok) throw new Error(parsed.errors.join());
  edit?.(parsed.manifest);
  return { tools: [{ folder: ".", manifest: parsed.manifest, yamlText: stringify(parsed.manifest) }], fixtures: [], unsupported: [], filesSent: 2, totalFiles: 3, rounds: 1, usage: { inputTokens: 10, outputTokens: 5 }, modelId: "test:scripted" };
}
const evalCase = (expect: EvalCase["expect"] = {}, requests: EvalCase["requests"] = []): EvalCase => ({ id: "sample", repo: "unused", commit: null, expect, requests });
function scripted(...picks: (null | { name: string; input: unknown })[]) {
  const calls: { system: string; messages: Msg[]; tools: ToolDef[] }[] = [];
  const model: ChatModel = { id: "test:scripted", async turn(system, messages, tools): Promise<Turn> {
    const pick = picks[calls.length];
    calls.push({ system, messages, tools });
    if (pick === undefined) throw new Error("Script exhausted");
    return { stop: pick ? "tool_use" : "end_turn", text: "", toolCalls: pick ? [{ id: "1", ...pick }] : [], raw: null, usage: { inputTokens: 3, outputTokens: 2 } };
  } };
  return { model, calls };
}

test("forbidden flag fails level 1, including fixed run flags", () => {
  for (const edit of [(m: Manifest) => { m.tools[0].args.window = { type: "boolean", flag: "-w" }; }, (m: Manifest) => { m.tools[0].run += " -w"; }]) {
    expect(gradeStructure(goodDraft(edit), evalCase({ forbiddenFlags: ["-w"] })).failures.join()).toMatch(/-w/);
  }
  expect(gradeStructure(goodDraft(m => { m.tools[0].run += " --width 1"; }), evalCase({ forbiddenFlags: ["-w"] })).failures).toEqual([]);
});
test("unsupported server case passes when drafter refuses; silence does not", () => {
  const r = goodDraft(); r.tools = []; r.unsupported = [{ folder: ".", kind: "server", reason: "FastAPI requires CUDA." }];
  const c = evalCase({ unsupported: true, gpu: "nvidia" });
  expect(gradeStructure(r, c)).toMatchObject({ passed: 3, total: 3, failures: [] });
  r.unsupported = [];
  expect(gradeStructure(r, c).failures.length).toBeGreaterThan(0);
  expect(gradeStructure(goodDraft(), c).failures.length).toBeGreaterThan(0);
});
test("level 1 counts commands, checks every expectation once, and parses YAML", () => {
  const r = goodDraft(m => { m.tools.push({ ...m.tools[0], name: "second" }); });
  expect(gradeStructure(r, evalCase({ minTools: 2, maxTools: 1 }))).toMatchObject({ passed: 2, total: 3 });
  r.tools[0].yamlText = "name: [";
  expect(gradeStructure(r, evalCase()).failures.join()).toMatch(/manifest/i);
  const empty = goodDraft(); empty.tools = [];
  expect(gradeStructure(empty, evalCase({ maxTools: 1 })).failures.length).toBeGreaterThan(0);
});
test("GPU, platform and system requirements are checked", () => {
  const c = evalCase({ gpu: "nvidia", excludesPlatforms: ["macos"], requiresSystem: ["ffmpeg"] });
  expect(gradeStructure(goodDraft(), c)).toMatchObject({ passed: 1, total: 4 });
  expect(gradeStructure(goodDraft(m => { m.requires = { gpu: "nvidia", system: ["ffmpeg"] }; m.platforms = ["linux"]; }), c).failures).toEqual([]);
  expect(gradeStructure(goodDraft(m => { m.install = { node: "22" }; }), evalCase({ requiresSystem: ["node"] })).failures).toEqual([]);
  expect(gradeStructure(goodDraft(m => { m.install = { node: "20" }; }), evalCase({ requiresSystem: ["node"] })).failures.join()).toMatch(/node/);
});
test("pickTool makes one turn with the exact prompt and MCP definitions", async () => {
  const fake = scripted({ name: "sample__match", input: { source: "target.png" } });
  const tools = toMcpTools(goodDraft().tools.map(t => ({ manifest: t.manifest, dir: home })));
  expect(await pickTool(fake.model, tools, "Match target.png")).toEqual({ name: "sample__match", input: { source: "target.png" } });
  expect(fake.calls).toEqual([{ system: "You are a coding agent. Use a tool if one fits the request; otherwise answer briefly.", messages: [{ role: "user", text: "Match target.png" }], tools }]);
});
test("tool:null request passes only when nothing is picked", async () => {
  const c = evalCase({}, [{ text: "Explain recursion", tool: null }]);
  expect((await gradeAgent(goodDraft(), c, scripted(null).model)).passed).toBe(1);
  expect((await gradeAgent(goodDraft(), c, scripted({ name: "sample__match", input: {} }).model)).passed).toBe(0);
});
test("agent matches name and argument regexes and rejects missing, wrong and unknown selections", async () => {
  const c = evalCase({}, [{ text: "Match target.png", tool: "__match$", args: { source: "(^|/)target\\.png$" } }]);
  for (const [pick, passed] of [[{ name: "sample__match", input: { source: "/tmp/target.png" } }, 1], [{ name: "sample__match", input: {} }, 0], [{ name: "sample__match", input: { source: "other.png" } }, 0], [{ name: "unknown__match", input: { source: "target.png" } }, 0], [null, 0]] as const) {
    expect((await gradeAgent(goodDraft(), c, scripted(pick).model)).passed).toBe(passed);
  }
});
test("agent rejects wrong argument types before matching regexes", async () => {
  const r = goodDraft(m => {
    m.tools[0].args.count = { type: "number" };
    m.tools[0].args.verbose = { type: "boolean" };
  });
  const c = evalCase({}, [{ text: "Match target.png", tool: "__match$", args: { source: "^target\\.png$", count: "^2$", verbose: "^false$" } }]);
  for (const [key, value, type] of [["source", ["target.png"], "path"], ["count", "2", "number"], ["verbose", "false", "boolean"]] as const) {
    const input = { source: "target.png", count: 2, verbose: false, [key]: value };
    expect(await gradeAgent(r, c, scripted({ name: "sample__match", input }).model)).toEqual({
      level: 3, passed: 0, total: 1, failures: [`Match target.png: Argument ${key} must be a ${type}`],
    });
  }
});
test("agent rejects missing required arguments on selection-only requests", async () => {
  const c = evalCase({}, [{ text: "Match an image", tool: "__match$" }]);
  expect(await gradeAgent(goodDraft(), c, scripted({ name: "sample__match", input: {} }).model)).toEqual({
    level: 3, passed: 0, total: 1, failures: ["Match an image: Missing required argument: source"],
  });
});
test("agent rejects unknown arguments even when expected arguments match", async () => {
  const c = evalCase({}, [{ text: "Match target.png", tool: "__match$", args: { source: "^target\\.png$" } }]);
  expect(await gradeAgent(goodDraft(), c, scripted({ name: "sample__match", input: { source: "target.png", invented: true } }).model)).toEqual({
    level: 3, passed: 0, total: 1, failures: ["Match target.png: Unknown argument: invented"],
  });
});
test("agent preserves numeric and boolean regex matching on original valid inputs", async () => {
  const r = goodDraft(m => {
    m.tools[0].args.count = { type: "number" };
    m.tools[0].args.verbose = { type: "boolean" };
    m.tools[0].args.optional = { type: "string", required: false };
    m.tools[0].args.defaulted = { type: "number", default: 3 };
  });
  for (const verbose of [true, false]) {
    const c = evalCase({}, [{ text: "Match target.png", tool: "__match$", args: { source: "^target\\.png$", count: "^2$", verbose: `^${verbose}$` } }]);
    expect(await gradeAgent(r, c, scripted({ name: "sample__match", input: { source: "target.png", count: 2, verbose } }).model)).toEqual({
      level: 3, passed: 1, total: 1, failures: [],
    });
  }
});
test("refusals and multiple calls cannot pass a null request", async () => {
  for (const turn of [{ stop: "refusal", toolCalls: [] }, { stop: "tool_use", toolCalls: [{ id: "a", name: "sample__match", input: {} }, { id: "b", name: "sample__match", input: {} }] }] as const) {
    const model: ChatModel = { id: "test:scripted", async turn() { return { ...turn, toolCalls: [...turn.toolCalls], text: "", raw: null, usage: { inputTokens: 0, outputTokens: 0 } }; } };
    expect((await gradeAgent(goodDraft(), evalCase({}, [{ text: "Explain recursion", tool: null }]), model)).passed).toBe(0);
  }
});
test("smoke installs a scratch copy, preserves clone and GU_HOME, and cleans scratch", async () => {
  const clone = join(home, "clone"); mkdirSync(clone);
  const marker = join(home, "installed-path.txt");
  writeFileSync(join(clone, "smoke.js"), `require('fs').writeFileSync(${JSON.stringify(marker)}, process.cwd()); console.log('success');`);
  writeFileSync(join(clone, "gu.yaml"), "original");
  const r = goodDraft(); r.fixtures = [{ folder: ".", path: ".gu/test/input.txt", content: "fixture" }];
  expect(await gradeSmoke(r, clone)).toEqual({ level: 2, passed: 1, total: 1, failures: [] });
  expect(readFileSync(join(clone, "gu.yaml"), "utf8")).toBe("original");
  expect(existsSync(join(clone, ".gu"))).toBe(false);
  expect(existsSync(readFileSync(marker, "utf8"))).toBe(false);
  expect(process.env.GU_HOME).toBe(home);
});
test("smoke reports failed fixtures and commands, skips unsupported/GPU drafts", async () => {
  writeFileSync(join(home, "smoke.js"), "process.exit(1)");
  expect((await gradeSmoke(goodDraft(), home)).passed).toBe(0);
  const r = goodDraft(); r.fixtures = [{ folder: ".", path: ".gu/test/x", command: "node -e 'process.exit(1)'" }];
  expect((await gradeSmoke(r, home)).failures.join()).toMatch(/fixture/i);
  r.tools = []; r.unsupported = [{ folder: ".", kind: "server", reason: "Server" }];
  expect((await gradeSmoke(r, "does-not-exist")).total).toBe(0);
  expect((await gradeSmoke(goodDraft(m => { m.requires.gpu = "nvidia"; }), "does-not-exist")).total).toBe(0);
});

function localCase(id = "local"): { c: EvalCase; cache: string; source: string; caseFile: string } {
  const source = join(home, "origin"); mkdirSync(source);
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], { timeout: 10_000, cwd: source, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  };
  git("init", "--quiet");
  writeFileSync(join(source, "README.md"), "A local test repository; no network needed.");
  git("add", "README.md");
  git("-c", "user.name=Eval Test", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture");
  const c = { ...evalCase(), id, repo: source };
  const caseFile = join(home, "cases", `${id}.json`);
  mkdirSync(join(home, "cases"), { recursive: true });
  writeFileSync(caseFile, JSON.stringify(c));
  return { c, source, caseFile, cache: join(home, ".cache") };
}
test("clone pins a local repo, reuses its SHA, and refuses dirty cache", async () => {
  const { c, cache, caseFile } = localCase();
  const path = await ensureClone(c, cache);
  expect(c.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(JSON.parse(readFileSync(caseFile, "utf8")).commit).toBe(c.commit);
  expect(await ensureClone(c, cache)).toBe(path);
  writeFileSync(join(path, "README.md"), "do not overwrite");
  await expect(ensureClone(c, cache)).rejects.toThrow(/local changes/);
  expect(readFileSync(join(path, "README.md"), "utf8")).toBe("do not overwrite");
});
test("runner continues after a case error and counts drafting plus selection usage", async () => {
  const { c, cache } = localCase();
  c.requests = [{ text: "Explain recursion", tool: null }];
  const r = goodDraft();
  const fake = scripted({ name: "submit_draft", input: { tools: r.tools.map(t => ({ folder: t.folder, gu_yaml: t.yamlText })), fixtures: [], unsupported: [] } }, null);
  const reports = await evaluateCases([{ ...c, id: "../invalid" }, c], fake.model, { cacheDir: cache, levels: [1, 3] });
  expect(reports[0].error).toMatch(/Invalid case id/);
  expect(reports[1]).toMatchObject({ id: "local", usage: { inputTokens: 6, outputTokens: 4 }, levels: [{ level: 1, passed: 1, total: 1 }, { level: 3, passed: 1, total: 1 }] });
  expect(reports[1].filesSent).toBeGreaterThan(0);
  const printed = formatReport(reports, fake.model.id);
  expect(printed).toContain("modelId: test:scripted");
  expect(printed).toContain("[test:scripted] TOTAL (1 case errors) | 1/1 (100.0%) | — | 1/1 (100.0%)");
  expect(fake.calls).toHaveLength(2);
});
test("runner gates expected GPU cases even when a draft omits its GPU requirement", async () => {
  const { c, cache } = localCase(); c.expect.gpu = "nvidia";
  const r = goodDraft();
  const fake = scripted({ name: "submit_draft", input: { tools: r.tools.map(t => ({ folder: ".", gu_yaml: t.yamlText })), fixtures: [], unsupported: [] } });
  expect((await evaluateCases([c], fake.model, { cacheDir: cache, levels: [2] }))[0].levels).toEqual([{ level: 2, passed: 0, total: 0, failures: [] }]);
});
test("CLI filters levels and rejects malformed options before constructing a model", () => {
  expect(parseArgs([])).toEqual({ levels: [1, 2, 3] });
  expect(parseArgs(["--case", "lintapple", "--levels", "3,1,3"])).toEqual({ caseId: "lintapple", levels: [1, 3] });
  for (const args of [["--case"], ["--levels", "0"], ["--levels", "1,"], ["--other"], ["--case", "../oops"], ["--levels", "1", "--levels", "2"]]) expect(() => parseArgs(args)).toThrow();
});
