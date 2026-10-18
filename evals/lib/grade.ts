import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ArgError, buildArgv, findTool, installTool, parseManifest, toMcpTools, writeDraft, type ChatModel, type DraftResult } from "../../src/index";
import { pickTool } from "./agent";
import type { EvalCase, LevelResult } from "./types";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function gradeStructure(r: DraftResult, c: EvalCase): LevelResult {
  const result: LevelResult = { level: 1, passed: 0, total: 0, failures: [] };
  function check(ok: boolean, failure: string) {
    result.total++;
    if (ok) result.passed++; else result.failures.push(failure);
  }
  const parsed = r.tools.map(t => ({ folder: t.folder, result: parseManifest(t.yamlText) }));
  const manifests = parsed.flatMap(p => p.result.ok ? [p.result.manifest] : []);
  const refused = r.tools.length === 0 && r.unsupported.length > 0;
  const invalid = parsed.flatMap(p => p.result.ok ? [] : [`${p.folder}: ${p.result.errors.join("; ")}`]);
  check(!invalid.length && (manifests.length > 0 || refused), `Every manifest must parse and the draft must contain tools or an explicit refusal.${invalid.length ? ` ${invalid.join("; ")}` : ""}`);
  const count = manifests.reduce((sum, m) => sum + m.tools.length, 0);
  const e = c.expect;
  if (e.unsupported !== undefined) check(e.unsupported ? refused : count > 0, `Expected unsupported=${e.unsupported}; got ${count} tools and ${r.unsupported.length} refusals.`);
  if (e.minTools !== undefined) check(count >= e.minTools, `Expected at least ${e.minTools} tools; got ${count}.`);
  if (e.maxTools !== undefined) check(count <= e.maxTools, `Expected at most ${e.maxTools} tools; got ${count}.`);
  if (e.forbiddenFlags !== undefined) {
    const found = e.forbiddenFlags.filter(flag => manifests.some(m => m.tools.some(t =>
      new RegExp(`(?:^|[\\s"'])${escaped(flag)}(?=$|[\\s"'=])`).test(t.run) ||
      Object.entries(t.args).some(([name, arg]) => !arg.positional && (arg.flag ?? `--${name}`) === flag),
    )));
    check(!found.length, `Forbidden flags exposed: ${found.join(", ")}.`);
  }
  // An explicit unsupported refusal has no manifest on which to declare a GPU.
  if (e.gpu !== undefined) check((refused && e.unsupported === true) || (manifests.length > 0 && manifests.every(m => m.requires.gpu === e.gpu)), `Expected GPU requirement ${e.gpu}.`);
  if (e.excludesPlatforms !== undefined) check(manifests.every(m => e.excludesPlatforms!.every(p => !m.platforms.includes(p))), `Platforms must exclude ${e.excludesPlatforms.join(", ")}.`);
  if (e.requiresSystem !== undefined) {
    // Repository-level requirements may belong to different tool folders.
    const missing = e.requiresSystem.filter(cmd => !manifests.some(m =>
      m.requires.system.includes(cmd) || (cmd === "node" && /^(?:>=|\^|~)?\s*(?:2[2-9]|[3-9]\d)(?:\.|$)/.test(m.install?.node ?? "")),
    ));
    check(!missing.length, `Missing system requirements: ${missing.join(", ")}.`);
  }
  return result;
}

export async function gradeSmoke(r: DraftResult, clonePath: string): Promise<LevelResult> {
  const result: LevelResult = { level: 2, passed: 0, total: 0, failures: [] };
  if (!r.tools.length || r.tools.some(t => t.manifest.requires.gpu !== "none")) return result;
  result.total = r.tools.length;
  const scratch = mkdtempSync(join(tmpdir(), "gu-eval-smoke-"));
  const previousHome = process.env.GU_HOME;
  try {
    const repo = join(scratch, "repo");
    const home = join(scratch, "home");
    process.env.GU_HOME = home;
    cpSync(clonePath, repo, { recursive: true, preserveTimestamps: true,
      filter: path => path === clonePath || ![".git", "node_modules", ".venv", "__pycache__"].includes(basename(path)),
    });
    const written = await writeDraft(repo, r);
    if (written.fixtureErrors.length) {
      result.failures.push(...written.fixtureErrors.map(e => `Fixture ${e.path}: ${e.message}`));
      return result;
    }
    for (const tool of r.tools) {
      // installTool already runs the smoke test; do not execute it twice.
      const installed = await installTool(join(repo, tool.folder), { guHome: home });
      if (installed.ok && installed.smoke.passed) result.passed++;
      else result.failures.push(`${tool.folder}: ${installed.ok ? "Smoke test failed." : `${installed.stage}: ${installed.message}`}`);
    }
  } catch (error) {
    result.failures.push(message(error));
  } finally {
    if (previousHome === undefined) delete process.env.GU_HOME;
    else process.env.GU_HOME = previousHome;
    rmSync(scratch, { recursive: true, force: true });
  }
  return result;
}

export async function gradeAgent(r: DraftResult, c: EvalCase, model: ChatModel): Promise<LevelResult> {
  const result: LevelResult = { level: 3, passed: 0, total: c.requests.length, failures: [] };
  const loaded = r.tools.map(t => ({ manifest: t.manifest, dir: t.folder }));
  const tools = toMcpTools(loaded);
  for (const request of c.requests) {
    try {
      const picked = await pickTool(model, tools, request.text);
      if (picked !== null) {
        const found = findTool(loaded, picked.name);
        if (!found) throw new ArgError(`Unknown tool: ${picked.name}`);
        // Validate exactly as gu serve does; no command is executed.
        buildArgv(found.tool, picked.input, process.cwd());
      }
      const matches = request.tool === null ? picked === null : picked !== null &&
        new RegExp(request.tool).test(picked.name) && Object.entries(request.args ?? {}).every(([name, pattern]) =>
          Object.hasOwn(picked.input, name) && new RegExp(pattern).test(String(picked.input[name])),
        );
      if (matches) result.passed++;
      else result.failures.push(`${request.text}: expected ${request.tool ?? "no tool"}${request.args ? ` with ${JSON.stringify(request.args)}` : ""}; got ${JSON.stringify(picked)}.`);
    } catch (error) {
      result.failures.push(`${request.text}: ${message(error)}`);
    }
  }
  return result;
}
