import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findCards } from "../manifest/find";
import { createInterface } from "node:readline";
import { draft, type DraftResult, type Unsupported } from "../draft/drafter";
import { writeDraft } from "../draft/write";
import { installTool } from "../install/install";
import { parseManifest } from "../manifest/schema";
import { apiModelConfigured } from "../llm/from-env";
import { AGENT_GUIDE } from "../draft/prompt";
import { ensureRegistered } from "./register";

function summarize(r: DraftResult): string {
  const lines = ["Here is the proposed draft:"];
  for (const { folder, manifest, yamlText } of r.tools) {
    lines.push(`${manifest.name} (${folder}): ${manifest.description}`);
    for (const tool of manifest.tools) lines.push(`  ${tool.name}: ${tool.description ?? manifest.description}\n  Command: ${tool.run}`);
    if (manifest.install) lines.push(`  Dependency setup: ${Object.entries(manifest.install).map(([key, value]) => `${key}: ${value}`).join(", ")}`);
    lines.push(`  Test command: ${manifest.test.run}`);
    lines.push(`--- ${join(folder, "gu.yaml")} ---\n${yamlText}\n--- End gu.yaml ---`);
  }
  for (const fixture of r.fixtures) {
    lines.push(`Fixture ${join(fixture.folder, fixture.path)}${fixture.content !== undefined ? `; write ${Buffer.byteLength(fixture.content)} bytes` : ""}${fixture.command !== undefined ? `; command: ${fixture.command}` : ""}`);
  }
  for (const item of r.unsupported) lines.push(`Unsupported folder ${item.folder}: ${item.reason}`);
  lines.push(`AI looked at ${r.filesSent} of ${r.totalFiles} files`);
  return lines.join("\n");
}
function confirmOnStdin(_summary: string): Promise<boolean> {
  return new Promise(resolve => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.once("close", () => resolve(false));
    input.question("Proceed with the proposed files and install and test the tools? (y/N) ", answer => {
      resolve(/^(y|yes)$/i.test(answer.trim())); input.close();
    });
  });
}
export async function publish(repoRoot: string, opts: {
  draftFn?: typeof draft;
  confirm?: (summary: string) => Promise<boolean>;
  guHome?: string;
  redraft?: boolean;
  /** Have the coding agent write the card even when an API model is configured. */
  agent?: boolean;
  log?: (s: string) => void;
} = {}): Promise<{ installed: string[]; failed: { folder: string; message: string }[]; unsupported: Unsupported[]; needsCard?: boolean }> {
  const root = resolve(repoRoot);
  const log = opts.log ?? console.log;
  const installed: string[] = [];
  const failed: { folder: string; message: string }[] = [];
  let unsupported: Unsupported[] = [];
  let folders = opts.redraft ? [] : findCards(root);
  let drafted: DraftResult | undefined;
  let summary: string;
  if (!folders.length) {
    if (!opts.draftFn && (opts.agent || !apiModelConfigured())) {
      log(agentInstructions(root, Boolean(opts.redraft)));
      return { installed, failed, unsupported, needsCard: true };
    }
    drafted = await (opts.draftFn ?? draft)(root, { log });
    unsupported = drafted.unsupported;
    summary = summarize(drafted);
  } else {
    const lines = ["These tools will be installed and tested:"];
    folders = folders.filter(folder => {
      const parsed = parseManifest(readFileSync(join(root, folder, "gu.yaml"), "utf8"));
      if (!parsed.ok) {
        const message = `The tool's gu.yaml is invalid: ${parsed.errors.join("; ")}`;
        failed.push({ folder, message });
        log(`Could not install ${folder}: ${message}`);
        return false;
      }
      lines.push(`${parsed.manifest.name} (version ${parsed.manifest.version}, folder: ${folder})`);
      return true;
    });
    summary = lines.join("\n");
  }
  log(summary);
  if (!await (opts.confirm ?? confirmOnStdin)(summary)) {
    log("Cancelled. No files were written or tools installed.");
    return { installed, failed, unsupported };
  }
  if (drafted) {
    const written = await writeDraft(root, drafted);
    for (const error of written.fixtureErrors) {
      const message = `Could not generate fixture ${error.path}: ${error.message}`;
      log(message);
      failed.push({ folder: error.folder, message });
    }
    const blocked = new Set(written.fixtureErrors.map(error => resolve(root, error.folder)));
    folders = drafted.tools.map(tool => tool.folder).filter(folder => !blocked.has(resolve(root, folder)));
  }
  for (const folder of folders) {
    const result = await installTool(resolve(root, folder), { guHome: opts.guHome, log });
    if (result.ok) {
      installed.push(result.loaded.manifest.name);
      log(`Installed ${result.loaded.manifest.name}. It passed its test.`);
    } else {
      failed.push({ folder, message: result.message });
      log(`Could not install ${folder}: ${result.message}`);
    }
  }
  return { installed, failed, unsupported };
}

function agentInstructions(root: string, redraft: boolean): string {
  return [
    `gu publish: ${redraft ? "a fresh card was requested" : "no gu.yaml card was found"} in ${root}.`,
    "The card isn't written yet (exit code 2). If you are a coding agent, write it now by following the rules below, then run `gu publish --yes` from this folder.",
    ...(redraft ? ["Replace the existing gu.yaml files rather than editing them."] : []),
    "If you are a person, ask your coding agent to run `gu publish`, or set ANTHROPIC_API_KEY (or GU_LLM=openai-compatible) so gu can write the card itself.",
    "",
    AGENT_GUIDE,
  ].join("\n");
}

export async function publishCommand(args: string[], opts: {
  repoRoot?: string; draftFn?: typeof draft; log?: (s: string) => void; register?: () => Promise<void>;
} = {}): Promise<number> {
  try {
    if (args.some(arg => !["--redraft", "--yes", "--agent"].includes(arg))) throw new Error("Usage: gu publish [--redraft] [--agent] [--yes]");
    const result = await publish(opts.repoRoot ?? process.cwd(), {
      draftFn: opts.draftFn, log: opts.log,
      redraft: args.includes("--redraft"),
      agent: args.includes("--agent"),
      ...(args.includes("--yes") ? { confirm: async () => true } : {}),
    });
    if (result.needsCard) return 2;
    if (result.installed.length) await (opts.register ?? (() => ensureRegistered({ log: opts.log })))();
    return result.failed.length ? 1 : 0;
  } catch (error) {
    (opts.log ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
