import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, type Manifest, type ToolSpec } from "../src/manifest/schema";
import type { LoadedTool } from "../src/manifest/discover";
import { ArgError, buildArgv, findTool, mcpName, splitCommand, toMcpTools } from "../src/core/tools";

const parsed = parseManifest(readFileSync(join(import.meta.dir, "fixtures", "manifests", "colorgrade.yaml"), "utf8"));
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const manifest: Manifest = parsed.manifest;
const grade = manifest.tools[0];
const colorgradeLoaded: LoadedTool = { manifest, dir: "/installed/colorgrade/3" };
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gu-core-tools-"));
  previousHome = process.env.GU_HOME;
  process.env.GU_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const custom = (args: ToolSpec["args"]): ToolSpec => ({ ...grade, run: "program", args });

test("splitCommand honors quotes", () => {
  expect(splitCommand(`python -m a.cli "two words" 'x y'`)).toEqual(["python", "-m", "a.cli", "two words", "x y"]);
});
test("splitCommand preserves empty and adjacent quoted values and literal shell syntax", () => {
  expect(splitCommand(`  cmd\t'' "" pre"two words"post '$HOME' *.mp4 | other ; \\literal\n`))
    .toEqual(["cmd", "", "", "pretwo wordspost", "$HOME", "*.mp4", "|", "other", ";", "\\literal"]);
  expect(splitCommand(" \t\n")).toEqual([]);
  expect(() => splitCommand(`cmd 'unfinished`)).toThrow();
});
test("builds argv with flags and defaults", () => {
  expect(buildArgv(grade, { input: "a.mp4", lut: "/l.cube" }, "/proj"))
    .toEqual(["python", "-m", "colorgrade.cli", "grade", "--input", "/proj/a.mp4", "--lut", "/l.cube", "--strength", "1"]);
});
test("path args resolve against caller cwd", () => {
  expect(buildArgv(grade, { input: "clips/a.mp4", lut: "x.cube" }, "/work")).toContain("/work/clips/a.mp4");
});
test("missing required arg throws ArgError naming it", () => {
  expect(() => buildArgv(grade, { lut: "x" }, "/")).toThrow(ArgError);
  expect(() => buildArgv(grade, { lut: "x" }, "/")).toThrow(/input/);
});
test("unknown args including prototype names throw", () => {
  for (const name of ["zzz", "toString", "constructor", "__proto__"]) {
    expect(() => buildArgv(grade, { input: "a", lut: "b", [name]: 1 }, "/")).toThrow(name);
  }
});
test("rejects wrong types without coercion", () => {
  for (const [type, invalid] of [["string", 1], ["path", null], ["number", "1"], ["boolean", "false"], ["number", NaN], ["number", Infinity]] as const) {
    expect(() => buildArgv(custom({ value: { type } }), { value: invalid }, "/")).toThrow(ArgError);
    expect(() => buildArgv(custom({ value: { type } }), { value: invalid }, "/")).toThrow(/value/);
  }
});
test("preserves declaration order, positionals, custom flags, false and zero", () => {
  const tool = custom({
    source: { type: "path", positional: true },
    verbose: { type: "boolean", default: true, flag: "-v" },
    quiet: { type: "boolean", default: false },
    count: { type: "number", default: 2, flag: "-n" },
    label: { type: "string", positional: true },
    optional: { type: "string", required: false },
  });
  expect(buildArgv(tool, { label: "$(touch x); *", source: "a b", count: 0 }, "/work"))
    .toEqual(["program", "/work/a b", "-v", "-n", "0", "$(touch x); *"]);
  expect(buildArgv(tool, { source: "a", label: "", verbose: false, quiet: true }, "/"))
    .toEqual(["program", "/a", "--quiet", "-n", "2", ""]);
});
test("defaults resolve paths and are type checked; explicit required is respected", () => {
  expect(buildArgv(custom({ file: { type: "path", default: "a" } }), {}, "/work")).toEqual(["program", "--file", "/work/a"]);
  expect(() => buildArgv(custom({ count: { type: "number", default: "bad" } }), {}, "/")).toThrow(/count/);
  expect(buildArgv(custom({ value: { type: "string", required: true, default: "ok" } }), {}, "/")).toEqual(["program", "--value", "ok"]);
});
test("toMcpTools builds names, schema and required list", () => {
  const [t] = toMcpTools([colorgradeLoaded]);
  expect(t.name).toBe("colorgrade__grade");
  expect(t.inputSchema).toEqual({ type: "object", properties: {
    input: { type: "string", description: "Video file to grade (file path)" },
    lut: { type: "string", description: ".cube LUT file (file path)" },
    strength: { type: "number", default: 1 },
  }, required: ["input", "lut"] });
  expect(t.description).toBe(`${manifest.description}\nUse when: ${manifest.use_when}\nReturns: ${grade.returns}`);
});
test("schema handles optional descriptions, booleans and inferred required fields", () => {
  const tool = { ...custom({ value: { type: "string" }, file: { type: "path", required: false }, enabled: { type: "boolean", default: false }, explicit: { type: "number", required: true, default: 0 } }), description: " Grade a clip.", returns: undefined };
  const [def] = toMcpTools([{ ...colorgradeLoaded, manifest: { ...manifest, tools: [tool] } }]);
  expect(def.description).toBe(`${manifest.description}${tool.description}\nUse when: ${manifest.use_when}`);
  expect(def.inputSchema.required).toEqual(["value", "explicit"]);
  expect(def.inputSchema.properties.file).toEqual({ type: "string", description: " (file path)" });
  expect(def.inputSchema.properties.enabled).toEqual({ type: "boolean", default: false });
});
test("lists and finds tools by exact qualified name in declaration order", () => {
  const second = { ...grade, name: "inspect" };
  const loaded = { ...colorgradeLoaded, manifest: { ...manifest, tools: [grade, second] } };
  expect(mcpName(loaded, second)).toBe("colorgrade__inspect");
  expect(toMcpTools([loaded]).map(t => t.name)).toEqual(["colorgrade__grade", "colorgrade__inspect"]);
  expect(findTool([loaded], "colorgrade__inspect")).toEqual({ loaded, tool: second });
  expect(findTool([loaded], "grade")).toBeUndefined();
  expect(findTool([], "colorgrade__grade")).toBeUndefined();
  expect(toMcpTools([])).toEqual([]);
});
