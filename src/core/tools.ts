import { resolve } from "node:path";
import type { ArgSpec, ToolSpec } from "../manifest/schema";
import type { LoadedTool } from "../manifest/discover";

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

/** Tokenize quotes and whitespace only; shell syntax remains literal text. */
export function splitCommand(cmd: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (const char of cmd) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new ArgError("Command contains an unterminated quote");
  if (started) words.push(word);
  return words;
}

function isRequired(arg: ArgSpec): boolean {
  return arg.required ?? (arg.default === undefined);
}

export function buildArgv(tool: ToolSpec, args: Record<string, unknown>, callerCwd: string): string[] {
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(tool.args, name)) throw new ArgError(`Unknown argument: ${name}`);
  }
  const argv = splitCommand(tool.run);
  for (const [name, arg] of Object.entries(tool.args)) {
    const supplied = Object.hasOwn(args, name) ? args[name] : undefined;
    const value = supplied === undefined ? arg.default : supplied;
    if (value === undefined) {
      if (isRequired(arg)) throw new ArgError(`Missing required argument: ${name}`);
      continue;
    }
    const type = arg.type === "path" ? "string" : arg.type;
    if (typeof value !== type || (typeof value === "number" && !Number.isFinite(value))) {
      throw new ArgError(`Argument ${name} must be a ${arg.type}`);
    }
    const flag = arg.flag ?? `--${name}`;
    if (arg.type === "boolean") {
      if (value) argv.push(flag);
      continue;
    }
    if (!arg.positional) argv.push(flag);
    argv.push(arg.type === "path" ? resolve(callerCwd, value as string) : String(value));
  }
  return argv;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function mcpName(loaded: LoadedTool, tool: ToolSpec): string {
  return `${loaded.manifest.name}__${tool.name}`;
}

export function toMcpTools(tools: LoadedTool[]): McpToolDef[] {
  return tools.flatMap(loaded => loaded.manifest.tools.map(tool => ({
    name: mcpName(loaded, tool),
    description: loaded.manifest.description + (tool.description ?? "") +
      `\nUse when: ${loaded.manifest.use_when}` + (tool.returns ? `\nReturns: ${tool.returns}` : ""),
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(Object.entries(tool.args).map(([name, arg]) => [name, {
        type: arg.type === "path" ? "string" : arg.type,
        ...(arg.type === "path" ? { description: `${arg.description ?? ""} (file path)` } :
          arg.description !== undefined ? { description: arg.description } : {}),
        ...(arg.default !== undefined ? { default: arg.default } : {}),
      }])),
      required: Object.entries(tool.args).filter(([, arg]) => isRequired(arg)).map(([name]) => name),
    },
  })));
}

export function findTool(tools: LoadedTool[], name: string): { loaded: LoadedTool; tool: ToolSpec } | undefined {
  for (const loaded of tools) {
    for (const tool of loaded.manifest.tools) {
      if (mcpName(loaded, tool) === name) return { loaded, tool };
    }
  }
  return undefined;
}
