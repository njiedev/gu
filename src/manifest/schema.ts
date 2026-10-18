import { z } from "zod";
import { parse } from "yaml";

export type Platform = "macos" | "linux" | "windows";

export interface ArgSpec {
  type: "string" | "number" | "boolean" | "path";
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  flag?: string;
  positional?: boolean;
}

export interface ToolSpec {
  name: string;
  description?: string;
  run: string;
  args: Record<string, ArgSpec>;
  returns?: string;
  timeout: number;
}

export interface Manifest {
  name: string;
  version: number;
  description: string;
  use_when: string;
  runtime?: "local";
  platforms: Platform[];
  requires: { gpu: "none" | "any" | "nvidia" | "apple"; system: string[] };
  install?: { python?: string; pip?: string; node?: string; npm?: string };
  env: { name: string; required: boolean }[];
  tools: ToolSpec[];
  test: { run: string; expect: { exit_code: number; file_exists?: string; stdout_contains?: string } };
}

const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const relativePathMessage = "must be a path relative to the tool folder";

function isToolRelativePath(value: string): boolean {
  // Check both platforms regardless of the host running gu.
  if (/^(?:[\\/]|[a-z]:|~)/i.test(value)) return false;
  let depth = 0;
  for (const segment of value.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return false;
      depth--;
    } else {
      depth++;
    }
  }
  return true;
}

const relativePathSchema = z.string().refine(isToolRelativePath, relativePathMessage);
const argSchema = z.object({
  type: z.enum(["string", "number", "boolean", "path"]),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  flag: z.string().optional(),
  positional: z.boolean().optional(),
}).refine(arg => arg.default === undefined || arg.type === "path" || typeof arg.default === arg.type, {
  path: ["default"],
  message: "must match the declared argument type",
}).refine(arg => arg.type !== "path" || arg.default === undefined ||
  (typeof arg.default === "string" && isToolRelativePath(arg.default)), {
  path: ["default"],
  message: relativePathMessage,
}).transform(arg => ({ ...arg, required: arg.required ?? (arg.default === undefined) }));

export const ManifestSchema = z.object({
  name: nameSchema,
  version: z.number().int().positive(),
  description: z.string(),
  use_when: z.string(),
  runtime: z.literal("local").optional(),
  platforms: z.array(z.enum(["macos", "linux", "windows"])).min(1),
  requires: z.object({
    gpu: z.enum(["none", "any", "nvidia", "apple"]).default("none"),
    system: z.array(z.string()).default([]),
  }).default({ gpu: "none", system: [] }),
  install: z.object({
    python: z.string().optional(),
    pip: relativePathSchema.optional(),
    node: z.string().optional(),
    npm: relativePathSchema.optional(),
  }).optional(),
  env: z.array(z.object({ name: z.string(), required: z.boolean() })).default([]),
  tools: z.array(z.object({
    name: nameSchema,
    description: z.string().optional(),
    run: z.string(),
    args: z.record(z.string(), argSchema).default({}),
    returns: z.string().optional(),
    timeout: z.number().int().min(1).max(86400).default(120),
  })).min(1).superRefine((tools, ctx) => {
    const names = new Set<string>();
    tools.forEach((tool, index) => {
      if (names.has(tool.name)) ctx.addIssue({ code: "custom", path: [index, "name"], message: `duplicate tool name '${tool.name}'` });
      names.add(tool.name);
    });
  }),
  test: z.object({
    run: z.string(),
    expect: z.object({
      exit_code: z.number(),
      file_exists: relativePathSchema.optional(),
      stdout_contains: z.string().optional(),
    }),
  }),
});

export function parseManifest(yamlText: string):
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] } {
  let value: unknown;
  try {
    value = parse(yamlText);
  } catch (error) {
    return { ok: false, errors: [`yaml: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const result = ManifestSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { ok: true, manifest: result.data };
}
