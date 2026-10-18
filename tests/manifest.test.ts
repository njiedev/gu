import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { ManifestSchema, parseManifest } from "../src/manifest/schema";
import { discoverInstalled, INSTALLED_MARKER } from "../src/manifest/discover";
import { guHome, toolsDir } from "../src/paths";

const read = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "manifests", name), "utf8");
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gu-manifest-"));
  previousHome = process.env.GU_HOME;
  process.env.GU_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function minimal() { return parse(read("minimal.yaml")); }
function install(name: string, version: string, content: string) {
  const dir = join(toolsDir(home), name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gu.yaml"), content);
  writeFileSync(join(dir, INSTALLED_MARKER), "verified");
  return dir;
}

test("parses the spec's colorgrade example", () => {
  const r = parseManifest(read("colorgrade.yaml"));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  expect(r.manifest.tools[0].timeout).toBe(600);
  expect(r.manifest.requires.system).toEqual(["ffmpeg"]);
  expect(r.manifest.tools[0].args.input.required).toBe(true);
  expect(r.manifest.tools[0].args.strength.required).toBe(false);
});

test("applies defaults", () => {
  const m = ManifestSchema.parse(minimal());
  expect(m.tools[0].timeout).toBe(120);
  expect(m.requires).toEqual({ gpu: "none", system: [] });
  expect(m.env).toEqual([]);
  expect(m.tools[0].args).toEqual({});
});

test("argument required default respects supplied defaults and explicit required", () => {
  const raw = minimal();
  raw.tools[0].args = {
    zero: { type: "number", default: 0 },
    empty: { type: "string", default: "" },
    off: { type: "boolean", default: false },
    optional: { type: "path", required: false, flag: "--file", positional: false },
    explicit: { type: "number", default: 1, required: true },
    missing: { type: "path" },
  };
  const args = ManifestSchema.parse(raw).tools[0].args;
  expect(Object.values(args).map(a => a.required)).toEqual([false, false, false, false, true, true]);
});

test("reports readable errors", () => {
  const r = parseManifest("name: Bad Name\nversion: 0\n");
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("Expected validation errors");
  expect(r.errors.some(e => e.startsWith("name:"))).toBe(true);
  expect(r.errors.some(e => e.startsWith("version:"))).toBe(true);
});

function withPaths(value: string | number | boolean) {
  const raw = minimal();
  raw.install = { pip: value, npm: value };
  raw.tools[0].args = { input: { type: "path", default: value } };
  raw.test.expect.file_exists = value;
  return raw;
}

test("rejects absolute, home, and escaping paths in every scoped field", () => {
  for (const value of [
    "/Users/alice/input", "C:\\tools\\input", "C:/tools/input", "C:input",
    "\\\\server\\share\\input", "//server/share/input", "\\input",
    "~", "~/input", "~alice/input", "~\\input",
    "..", "../input", "..\\input", "data/../../input", "data\\..\\..\\input",
    "data/..\\../input",
  ]) {
    expect(parseManifest(stringify(withPaths(value)))).toEqual({
      ok: false,
      errors: [
        "install.pip: must be a path relative to the tool folder",
        "install.npm: must be a path relative to the tool folder",
        "tools.0.args.input.default: must be a path relative to the tool folder",
        "test.expect.file_exists: must be a path relative to the tool folder",
      ],
    });
  }
});

test("preserves relative paths, contained parent segments, and globs", () => {
  for (const value of [
    ".", "requirements.txt", "./package.json", "data/input", "data\\input",
    "data/../input", "data\\..\\input", "data/..", "..hidden/input",
    "output/*.png", "output/**/*.png", "output/frame-[0-9]?.png",
  ]) {
    const result = parseManifest(stringify(withPaths(value)));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.manifest.install).toEqual({ pip: value, npm: value });
    expect(result.manifest.tools[0].args.input.default).toBe(value);
    expect(result.manifest.test.expect.file_exists).toBe(value);
  }
});

test("path defaults require strings while commands and other strings stay unrestricted", () => {
  for (const value of [0, false]) {
    const raw = minimal();
    raw.tools[0].args = { input: { type: "path", default: value } };
    expect(parseManifest(stringify(raw))).toEqual({
      ok: false,
      errors: ["tools.0.args.input.default: must be a path relative to the tool folder"],
    });
  }
  const raw = minimal();
  raw.tools[0].run = "/usr/bin/python ../script.py";
  raw.test.run = "C:\\tools\\check.exe ~/output";
  raw.tools[0].args = { text: { type: "string", default: "/absolute/text" } };
  raw.test.expect.stdout_contains = "../output";
  const result = parseManifest(stringify(raw));
  if (!result.ok) throw new Error(result.errors.join("\n"));
  expect(result.manifest.tools[0].run).toBe(raw.tools[0].run);
  expect(result.manifest.test.run).toBe(raw.test.run);
  expect(result.manifest.tools[0].args.text.default).toBe("/absolute/text");
  expect(result.manifest.test.expect.stdout_contains).toBe("../output");
});

test("validates names, positive integer versions, platforms, and tools", () => {
  for (const name of ["Bad", "a_b", "1a", "a".repeat(42), ""]) {
    expect(ManifestSchema.safeParse({ ...minimal(), name }).success).toBe(false);
    const raw = minimal(); raw.tools[0].name = name;
    expect(ManifestSchema.safeParse(raw).success).toBe(false);
  }
  expect(ManifestSchema.safeParse({ ...minimal(), name: "a".repeat(41) }).success).toBe(true);
  for (const version of [0, -1, 1.5, "1"]) {
    expect(ManifestSchema.safeParse({ ...minimal(), version }).success).toBe(false);
  }
  for (const platforms of [[], ["other"]]) {
    expect(ManifestSchema.safeParse({ ...minimal(), platforms }).success).toBe(false);
  }
  expect(ManifestSchema.safeParse({ ...minimal(), tools: [] }).success).toBe(false);
});

test("nested validation errors use dotted paths and malformed YAML does not throw", () => {
  const raw = minimal(); raw.tools[0].args = { input: { type: "invalid" } };
  const r = parseManifest(stringify(raw));
  if (r.ok) throw new Error("Expected validation errors");
  expect(r.errors.some(e => e.startsWith("tools.0.args.input.type:"))).toBe(true);
  for (const yaml of ["name: [", "", "null", "name: a\nname: b"]) {
    const result = parseManifest(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  }
});

test("discoverInstalled picks the newest version and reports broken ones", () => {
  install("a", "1", stringify({ ...minimal(), name: "a", version: 1 }));
  const dir = install("a", "3", stringify({ ...minimal(), name: "a", version: 3 }));
  install("b", "1", "name: invalid name");
  const { tools, problems } = discoverInstalled(home);
  expect(tools.map(t => [t.manifest.name, t.manifest.version])).toEqual([["a", 3]]);
  expect(tools[0].dir).toBe(dir);
  expect(problems).toHaveLength(1);
  expect(problems[0].path).toBe(join(toolsDir(home), "b", "1", "gu.yaml"));
  expect(problems[0].errors.length).toBeGreaterThan(0);
});

test("discovery sorts versions numerically and ignores non-version directories and files", () => {
  install("a", "2", stringify({ ...minimal(), name: "a", version: 2 }));
  install("a", "10", stringify({ ...minimal(), name: "a", version: 10 }));
  install("a", "latest", "invalid");
  writeFileSync(join(toolsDir(home), "a", "99"), "not a directory");
  writeFileSync(join(toolsDir(home), "unrelated"), "not a directory");
  expect(discoverInstalled(home).tools.map(t => t.manifest.version)).toEqual([10]);
  expect(discoverInstalled(home).problems).toEqual([]);
});

test("discovery reports missing and malformed newest manifests without falling back", () => {
  install("a", "1", read("minimal.yaml"));
  const missing = join(toolsDir(home), "a", "2");
  mkdirSync(missing);
  writeFileSync(join(missing, INSTALLED_MARKER), "verified");
  install("b", "1", "name: [");
  const result = discoverInstalled(home);
  expect(result.tools).toEqual([]);
  expect(result.problems).toHaveLength(2);
  expect(result.problems[0].path).toBe(join(missing, "gu.yaml"));
});

test("empty and absent tool directories discover no tools", () => {
  expect(discoverInstalled(home)).toEqual({ tools: [], problems: [] });
  mkdirSync(join(toolsDir(home), "empty"), { recursive: true });
  expect(discoverInstalled(home)).toEqual({ tools: [], problems: [] });
});

test("paths respect GU_HOME and default to the user home", () => {
  expect(guHome()).toBe(home);
  expect(toolsDir(home)).toBe(join(home, "tools"));
  delete process.env.GU_HOME;
  expect(guHome()).toBe(join(homedir(), ".gu"));
});

test("I6 duplicate tool names report the conflicting index", () => {
  const raw = minimal(); raw.tools.push({ ...raw.tools[0] });
  const r = parseManifest(stringify(raw));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors).toContain(`tools.1.name: duplicate tool name '${raw.tools[0].name}'`);
});

test("M3 argument defaults must match their declared types", () => {
  for (const [type, good, bad] of [["number", 0, ["1", true]], ["boolean", false, ["false", 1]], ["string", "", [0, false]], ["path", "input.txt", [0, false]]] as const) {
    for (const value of bad) {
      const raw = minimal(); raw.tools[0].args = { value: { type, default: value } };
      const r = parseManifest(stringify(raw));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some(e => e.startsWith("tools.0.args.value.default:"))).toBe(true);
    }
    const raw = minimal(); raw.tools[0].args = { value: { type, default: good } };
    expect(parseManifest(stringify(raw)).ok).toBe(true);
  }
});
test("M3 timeouts must be integer seconds from 1 through 86400", () => {
  for (const value of [0, -1, 0.1, 1.5, 86401]) {
    const raw = minimal(); raw.tools[0].timeout = value;
    const r = parseManifest(stringify(raw));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.startsWith("tools.0.timeout:"))).toBe(true);
  }
  for (const value of [1, 86400]) {
    const raw = minimal(); raw.tools[0].timeout = value;
    expect(parseManifest(stringify(raw)).ok).toBe(true);
  }
});

test("discovery ignores an unmarked higher version without reporting a problem", () => {
  const lower = install("a", "1", stringify({ ...minimal(), name: "a", version: 1 }));
  const higher = install("a", "2", "invalid manifest");
  rmSync(join(higher, INSTALLED_MARKER));
  const result = discoverInstalled(home);
  expect(result.tools.map(t => t.dir)).toEqual([lower]);
  expect(result.problems).toEqual([]);
});
