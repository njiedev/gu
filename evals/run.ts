import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { draft, modelFromEnv, type ChatModel } from "../src/index";
import { ensureClone } from "./lib/fetch";
import { gradeAgent, gradeSmoke, gradeStructure } from "./lib/grade";
import type { CaseReport, EvalCase, LevelResult } from "./lib/types";

type Level = LevelResult["level"];
export function parseArgs(args: string[]): { caseId?: string; levels: Level[] } {
  let caseId: string | undefined;
  let levels: Level[] = [1, 2, 3];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--case", "--levels"].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option: ${flag}.`);
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Provide a value for ${flag}.`);
    if (flag === "--case") {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error("Invalid case id.");
      caseId = value;
    } else {
      if (!/^[123](,[123])*$/.test(value)) throw new Error("Levels must be a comma-separated list of 1, 2, 3.");
      levels = [...new Set(value.split(",").map(Number) as Level[])].sort();
    }
  }
  return { caseId, levels };
}

export async function evaluateCases(cases: EvalCase[], model: ChatModel, opts: {
  cacheDir: string; levels: Level[];
}): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  for (const c of cases) {
    const report: CaseReport = { id: c.id, levels: [], filesSent: 0, totalFiles: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    // Count drafting AND selection turns, including turns before a failed draft.
    const counted: ChatModel = { id: model.id, async turn(system, messages, tools) {
      const turn = await model.turn(system, messages, tools);
      report.usage.inputTokens += turn.usage.inputTokens;
      report.usage.outputTokens += turn.usage.outputTokens;
      return turn;
    } };
    try {
      const clone = await ensureClone(c, opts.cacheDir);
      const result = await draft(clone, { model: counted });
      report.filesSent = result.filesSent;
      report.totalFiles = result.totalFiles;
      for (const level of opts.levels) {
        if (level === 1) report.levels.push(gradeStructure(result, c));
        // Case expectations also gate execution if a bad draft omits the GPU.
        if (level === 2) report.levels.push(c.expect.unsupported || (c.expect.gpu && c.expect.gpu !== "none")
          ? { level: 2, passed: 0, total: 0, failures: [] } : await gradeSmoke(result, clone));
        if (level === 3) report.levels.push(await gradeAgent(result, c, counted));
      }
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    reports.push(report);
  }
  return reports;
}

export function formatReport(reports: CaseReport[], modelId: string): string {
  const score = (level?: Pick<LevelResult, "passed" | "total">) => !level ? "—" : level.total === 0 ? "skip" : `${level.passed}/${level.total} (${(100 * level.passed / level.total).toFixed(1)}%)`;
  const lines = [`Eval results — modelId: ${modelId}`, "case | L1 | L2 | L3 | files sent/total | tokens (in/out)"];
  for (const r of reports) {
    lines.push(`[${modelId}] ${r.id} | ${([1, 2, 3] as const).map(level => score(r.levels.find(l => l.level === level))).join(" | ")} | ${r.filesSent}/${r.totalFiles} | ${r.usage.inputTokens}/${r.usage.outputTokens}${r.error ? ` | ERROR: ${r.error.replace(/\s+/g, " ")}` : ""}`);
    for (const l of r.levels) for (const failure of l.failures) lines.push(`[${modelId}] ${r.id} L${l.level}: ${failure.replace(/\s+/g, " ")}`);
  }
  const totals = ([1, 2, 3] as const).map(level => {
    const entries = reports.flatMap(r => r.levels.filter(l => l.level === level));
    return score(entries.length ? entries.reduce((sum, l) => ({ passed: sum.passed + l.passed, total: sum.total + l.total }), { passed: 0, total: 0 }) : undefined);
  });
  const sum = (field: "filesSent" | "totalFiles") => reports.reduce((n, r) => n + r[field], 0);
  const tokens = (field: "inputTokens" | "outputTokens") => reports.reduce((n, r) => n + r.usage[field], 0);
  lines.push(`[${modelId}] TOTAL (${reports.filter(r => r.error).length} case errors) | ${totals.join(" | ")} | ${sum("filesSent")}/${sum("totalFiles")} | ${tokens("inputTokens")}/${tokens("outputTokens")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: bun evals/run.ts [--case <id>] [--levels 1,2,3]\nRuns paid model calls. Level 2 installs and executes drafted tools in temporary folders.");
    return;
  }
  const opts = parseArgs(process.argv.slice(2));
  const root = import.meta.dir;
  const caseDir = join(root, "cases");
  const cases = readdirSync(caseDir).filter(file => file.endsWith(".json")).sort().map(file => JSON.parse(readFileSync(join(caseDir, file), "utf8")) as EvalCase)
    .filter(c => opts.caseId === undefined || c.id === opts.caseId);
  if (!cases.length) throw new Error(`Unknown case: ${opts.caseId}.`);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: resolve(root, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (sha.exitCode !== 0) throw new Error(`Could not read gu Git SHA: ${sha.stderr.toString().trim()}`);
  const model = modelFromEnv();
  console.log(`[${model.id}] Starting ${cases.length} cases, levels ${opts.levels.join(", ")}.`);
  const reports = await evaluateCases(cases, model, { cacheDir: join(root, ".cache"), levels: opts.levels });
  const timestamp = new Date().toISOString();
  const resultsDir = join(root, "results");
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, `${timestamp}.json`);
  writeFileSync(path, JSON.stringify({ modelId: model.id, guCommit: sha.stdout.toString().trim(), timestamp, levels: opts.levels,
    caseCommits: Object.fromEntries(cases.map(c => [c.id, c.commit])), cases: reports }, null, 2) + "\n");
  console.log(formatReport(reports, model.id));
  console.log(`[${model.id}] Saved ${path}`);
  if (reports.some(r => r.error || r.levels.some(l => l.passed !== l.total))) process.exitCode = 1;
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
