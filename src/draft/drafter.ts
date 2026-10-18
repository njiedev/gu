import { fixtureArgv } from "./fixture-command";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { modelFromEnv } from "../llm/from-env";
import type { ChatModel, Msg, ToolDef } from "../llm/types";
import { parseManifest, type Manifest } from "../manifest/schema";
import { collectContext, readRepoFile } from "./context";
import { renderContext, SYSTEM_PROMPT } from "./prompt";

export interface DraftedTool {
  folder: string;
  manifest: Manifest;
  yamlText: string;
}

export interface Fixture {
  folder: string;
  path: string;
  content?: string;
  command?: string;
}

export interface Unsupported {
  folder: string;
  kind: "server" | "ui-locked" | "interactive-only" | "other";
  reason: string;
}

export interface DraftResult {
  tools: DraftedTool[];
  fixtures: Fixture[];
  unsupported: Unsupported[];
  filesSent: number;
  totalFiles: number;
  rounds: number;
  usage: { inputTokens: number; outputTokens: number };
  modelId: string;
}

export class DraftError extends Error {
  constructor(message: string, public readonly errors: string[] = []) {
    super(errors.length ? `${message}\n${errors.join("\n")}` : message);
    this.name = "DraftError";
  }
}

const readInput = z.strictObject({ paths: z.array(z.string()).max(10) });
const submitInput = z.strictObject({
  tools: z.array(z.strictObject({ folder: z.string(), gu_yaml: z.string() })),
  fixtures: z.array(z.strictObject({
    folder: z.string(), path: z.string(), content: z.string(), command: z.string(),
  })),
  unsupported: z.array(z.strictObject({
    folder: z.string(),
    kind: z.enum(["server", "ui-locked", "interactive-only", "other"]),
    reason: z.string(),
  })),
});

// One source of truth for runtime validation and both providers' strict schemas.
const tools: ToolDef[] = [
  {
    name: "read_files",
    description: "Read up to 10 repository-relative text files for missing implementation clues. Each result has a path header; unreadable paths return errors.",
    inputSchema: z.toJSONSchema(readInput),
  },
  {
    name: "submit_draft",
    description: 'Submit the complete gu.yaml drafts, tiny generated fixtures, and unsupported folders. All fields are required; use empty arrays and "" for unused content or command. Validation errors are returned for correction.',
    inputSchema: z.toJSONSchema(submitInput),
  },
];

function inputErrors(error: z.ZodError): string[] {
  return error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`);
}

// Apply both path syntaxes on every host so a draft stays relative when moved.
function relativeFolder(folder: string): boolean {
  if (!folder || folder.includes("\0") || folder.startsWith("~") ||
    posix.isAbsolute(folder) || win32.isAbsolute(folder) || /^[a-z]:/i.test(folder)) return false;
  let depth = 0;
  for (const part of folder.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return false;
      depth--;
    } else depth++;
  }
  return true;
}

function fixturePath(path: string): boolean {
  if (!path.startsWith(".gu/test/") || path.includes("\0")) return false;
  const parts = path.slice(".gu/test/".length).split(/[\\/]/);
  return parts.every(part => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
}

type Submission = Pick<DraftResult, "tools" | "fixtures" | "unsupported">;

function validateSubmission(input: z.infer<typeof submitInput>):
  | { ok: true; value: Submission }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const drafted: DraftedTool[] = [];
  const folders = new Set<string>();
  const names = new Set<string>();
  for (const group of ["tools", "fixtures", "unsupported"] as const) {
    input[group].forEach((item, index) => {
      if (!relativeFolder(item.folder)) errors.push(`${group}[${index}].folder: must be repo-relative without escaping the repository; use "." for its root.`);
    });
  }
  input.tools.forEach((tool, index) => {
    const folder = posix.normalize(tool.folder.replaceAll("\\", "/")).replace(/\/$/, "");
    if (folders.has(folder)) errors.push(`tools[${index}].folder: only one gu.yaml is allowed per tool folder.`);
    folders.add(folder);
    const parsed = parseManifest(tool.gu_yaml);
    if (parsed.ok) {
      if (names.has(parsed.manifest.name)) errors.push(`tools[${index}].name: duplicate manifest name '${parsed.manifest.name}'`);
      names.add(parsed.manifest.name);
      drafted.push({ folder: tool.folder, manifest: parsed.manifest, yamlText: tool.gu_yaml });
    }
    else errors.push(...parsed.errors.map(error => `tools[${index}] (${tool.folder}): ${error}`));
  });
  input.fixtures.forEach((fixture, index) => {
    if (fixture.command) {
      try { fixtureArgv(fixture.command); }
      catch (error) { errors.push(`fixtures[${index}].command: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!fixturePath(fixture.path)) errors.push(`fixtures[${index}].path: must name a file under .gu/test/ without traversal.`);
  });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tools: drafted,
      fixtures: input.fixtures.map(({ folder, path, content, command }) => ({
        folder, path, ...(content !== "" ? { content } : {}), ...(command !== "" ? { command } : {}),
      })),
      unsupported: input.unsupported,
    },
  };
}

export async function draft(repoRoot: string, opts: {
  model?: ChatModel;
  maxRounds?: number;
  log?: (s: string) => void;
} = {}): Promise<DraftResult> {
  const maxRounds = opts.maxRounds ?? 8;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new DraftError("maxRounds must be a positive integer.");
  const model = opts.model ?? modelFromEnv();
  const context = collectContext(repoRoot);
  const messages: Msg[] = [{ role: "user", text: renderContext(context) }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let filesSent = context.files.length;
  let failedSubmissions = 0;
  const submissionErrors: string[] = [];
  let reminded = false;

  for (let rounds = 1; rounds <= maxRounds; rounds++) {
    opts.log?.(`Drafting round ${rounds} of ${maxRounds}.`);
    const turn = await model.turn(SYSTEM_PROMPT, messages, tools);
    messages.push({ role: "assistant", turn });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    if (turn.stop === "refusal" || turn.stop === "max_tokens") {
      throw new DraftError(`Drafting stopped: ${turn.stop}.`);
    }

    const results: Extract<Msg, { role: "tool_results" }>["results"] = [];
    let accepted: Submission | undefined;
    let submissionFailedThisTurn = false;
    for (const call of turn.toolCalls) {
      let errors: string[] = [];
      let content = "";
      switch (call.name) {
        case "read_files": {
          const parsed = readInput.safeParse(call.input);
          if (!parsed.success) errors = inputErrors(parsed.error);
          else {
            const sections = parsed.data.paths.map(path => {
              const result = readRepoFile(context.root, path);
              if (result.ok) {
                filesSent++;
                return `--- File: ${JSON.stringify(path)} ---\n${result.content}`;
              }
              errors.push(`${path}: ${result.error}`);
              return `--- File: ${JSON.stringify(path)} ---\nError: ${result.error}`;
            });
            content = sections.join("\n\n") || "No files requested.";
          }
          break;
        }
        case "submit_draft": {
          const parsed = submitInput.safeParse(call.input);
          if (!parsed.success) errors = inputErrors(parsed.error);
          else {
            const validated = validateSubmission(parsed.data);
            if (!validated.ok) errors = validated.errors;
            else {
              accepted = validated.value;
              content = "Draft accepted.";
            }
          }
          if (errors.length) {
            submissionFailedThisTurn = true;
            failedSubmissions++;
            submissionErrors.push(...errors);
          }
          break;
        }
        default:
          errors = [`Unknown tool "${call.name}". Use read_files or submit_draft.`];
      }
      results.push({ id: call.id, content: content || `Validation errors:\n${errors.join("\n")}`, isError: errors.length > 0 });
      if (failedSubmissions >= 2) break;
    }
    // Text-only turns have no tool calls to answer; empty result messages are
    // invalid for Anthropic. Every tool-use turn gets exactly one result batch.
    if (results.length) messages.push({ role: "tool_results", results });
    if (failedSubmissions >= 2) throw new DraftError("Draft validation failed after 2 submissions.", submissionErrors);
    if (accepted && !submissionFailedThisTurn) return { ...accepted, filesSent, totalFiles: context.totalFiles, rounds, usage, modelId: model.id };
    if (turn.stop === "end_turn") {
      if (reminded) throw new DraftError("The model ended its turn without submitting a draft after a reminder.", submissionErrors);
      messages.push({ role: "user", text: "Call submit_draft now." });
      reminded = true;
    }
  }
  throw new DraftError(`Drafting exceeded the maximum of ${maxRounds} rounds.`, submissionErrors);
}
