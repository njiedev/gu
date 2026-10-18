import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectContext } from "../src/draft/context";
import { draft, DraftError } from "../src/draft/drafter";
import { renderContext, SYSTEM_PROMPT } from "../src/draft/prompt";
import type { ChatModel, Msg, ToolDef, Turn } from "../src/llm/types";
import * as api from "../src/index";

const temp = mkdtempSync(join(tmpdir(), "gu-drafter-"));
const messy = join(temp, "repo");
const oldHome = process.env.GU_HOME;
process.env.GU_HOME = join(temp, "home");
mkdirSync(join(messy, "src", "tool"), { recursive: true });
writeFileSync(join(messy, "README.md"), "A messy repo with a Python CLI.");
writeFileSync(join(messy, "src", "tool", "cli.py"), 'print("Hello")\n');
writeFileSync(join(messy, "src", "tool", "helper.py"), "# Additional implementation clues\n");
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = oldHome;
});

const yamlText = `name: tool
version: 1
description: Print a greeting.
use_when: A greeting is needed.
platforms: [macos, linux]
tools:
  - name: greet
    run: python cli.py
test:
  run: python cli.py
  expect: {exit_code: 0, stdout_contains: Hello}
`;
const goodDraft = {
  tools: [{ folder: "src/tool", gu_yaml: yamlText }],
  fixtures: [],
  unsupported: [],
};
const badDraft = { ...goodDraft, tools: [{ folder: "src/tool", gu_yaml: "name: [" }] };
function turn(overrides: Partial<Turn> = {}): Turn {
  return { stop: "tool_use", text: "", toolCalls: [], raw: [], usage: { inputTokens: 10, outputTokens: 5 }, ...overrides };
}
function toolUse(name: string, input: unknown, id = "call-1"): Turn {
  return turn({ toolCalls: [{ id, name, input }] });
}
function scripted(turns: Turn[]) {
  const calls: { system: string; messages: Msg[]; tools: ToolDef[] }[] = [];
  const model: ChatModel & { calls: typeof calls } = {
    id: "test:scripted", calls,
    async turn(system, messages, tools) {
      const next = turns[calls.length];
      calls.push(structuredClone({ system, messages, tools }));
      if (!next) throw new Error("Script exhausted");
      return next;
    },
  };
  return model;
}
function lastToolResults(call: ReturnType<typeof scripted>["calls"][number]) {
  const msg = call.messages.findLast(m => m.role === "tool_results");
  if (!msg || msg.role !== "tool_results") throw new Error("Missing tool results");
  return msg.results;
}

test("reads files, then returns a validated draft with exact counts and usage", async () => {
  const fake = scripted([
    toolUse("read_files", { paths: ["src/tool/cli.py", "src/tool/helper.py", "missing.py"] }),
    toolUse("submit_draft", goodDraft),
  ]);
  const logs: string[] = [];
  const result = await draft(messy, { model: fake, log: s => logs.push(s) });
  expect(result.tools[0].folder).toBe("src/tool");
  expect(result.tools[0].yamlText).toBe(yamlText);
  expect(result.tools[0].manifest.name).toBe("tool");
  expect(result.tools[0].manifest.tools[0].timeout).toBe(120);
  expect(result.rounds).toBe(2);
  expect(result.filesSent).toBe(collectContext(messy).files.length + 2);
  expect(result.totalFiles).toBe(3);
  expect(result.modelId).toBe(fake.id);
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  expect(logs.length).toBeGreaterThan(0);
  const content = lastToolResults(fake.calls[1])[0].content;
  expect(content).toContain("src/tool/cli.py");
  expect(content).toContain('print("Hello")');
  expect(content).toContain("missing.py");
  expect(content).toContain("Error");
});

test("invalid yaml and manifest fields get fed back, then the fixed draft is accepted", async () => {
  for (const invalid of [badDraft, { ...goodDraft, tools: [{ folder: ".", gu_yaml: "name: tool" }] }]) {
    const fake = scripted([toolUse("submit_draft", invalid), toolUse("submit_draft", goodDraft)]);
    const result = await draft(messy, { model: fake });
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
    expect(lastToolResults(fake.calls[1])[0].content).toContain("tools[0]");
    expect(result.tools).toHaveLength(1);
  }
});

for (const order of ["valid then invalid", "invalid then valid"] as const) {
  const inputs = order === "valid then invalid" ? [goodDraft, badDraft] : [badDraft, goodDraft];
  const mixedTurn = () => turn({ toolCalls: inputs.map((input, index) => ({
    id: `submit-${index}`, name: "submit_draft", input,
  })) });

  test(`mixed submissions (${order}) send feedback and require correction`, async () => {
    const corrected = { ...goodDraft, tools: [{ folder: ".", gu_yaml: yamlText }] };
    const fake = scripted([mixedTurn(), toolUse("submit_draft", corrected)]);
    const result = await draft(messy, { model: fake });
    expect(result.rounds).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(result.tools[0].folder).toBe(".");
    const results = lastToolResults(fake.calls[1]);
    expect(results.map(r => [r.id, r.isError])).toEqual(inputs.map((input, index) => [
      `submit-${index}`, input === badDraft,
    ]));
    expect(results.find(r => r.isError)?.content).toContain("tools[0]");
  });

  test(`mixed submissions (${order}) count toward the two-failure limit`, async () => {
    const fake = scripted([mixedTurn(), toolUse("submit_draft", badDraft), toolUse("submit_draft", goodDraft)]);
    await expect(draft(messy, { model: fake })).rejects.toThrow("Draft validation failed after 2 submissions.");
    expect(fake.calls).toHaveLength(2);
  });
}

test("fixture paths outside .gu/test, including traversal, are rejected", async () => {
  for (const path of ["sample.txt", "/.gu/test/x", ".gu/test/../outside", ".gu/test/../../outside", ".gu/test/..\\outside", ".gu/test/", ".gu/test/.", ".gu/test/x\0.txt"]) {
    const invalid = { ...goodDraft, fixtures: [{ folder: "src/tool", path, content: "tiny", command: "" }] };
    const fake = scripted([toolUse("submit_draft", invalid), toolUse("submit_draft", goodDraft)]);
    await draft(messy, { model: fake });
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
    expect(lastToolResults(fake.calls[1])[0].content).toContain("fixtures[0].path");
  }
});

test("accepts root folders, generated fixtures and unsupported tools without running commands", async () => {
  const input = {
    tools: [{ folder: ".", gu_yaml: yamlText }],
    fixtures: [
      { folder: ".", path: ".gu/test/sample.txt", content: "tiny\n", command: "" },
      { folder: ".", path: ".gu/test/sample.mp4", content: "", command: "ffmpeg -f lavfi -i testsrc=duration=1:size=64x64 .gu/test/sample.mp4" },
    ],
    unsupported: [{ folder: "web", kind: "server" as const, reason: "Only exposes a web server." }],
  };
  const result = await draft(messy, { model: scripted([toolUse("submit_draft", input)]) });
  expect(result.tools[0].folder).toBe(".");
  expect(result.fixtures).toEqual([
    { folder: ".", path: ".gu/test/sample.txt", content: "tiny\n" },
    { folder: ".", path: ".gu/test/sample.mp4", command: input.fixtures[1].command },
  ]);
  expect(result.unsupported).toEqual(input.unsupported);
  expect(existsSync(join(messy, ".gu"))).toBe(false);
});

test("folder paths must stay repo-relative and one manifest is allowed per folder", async () => {
  const invalids = [
    ...["", "../escape", "/tmp/escape", "C:\\escape", "..\\escape"].map(folder => ({ ...goodDraft, tools: [{ folder, gu_yaml: yamlText }] })),
    { ...goodDraft, tools: [...goodDraft.tools, { folder: "src/./tool", gu_yaml: yamlText }] },
    { ...goodDraft, fixtures: [{ folder: "../escape", path: ".gu/test/sample.txt", content: "x", command: "" }] },
    { ...goodDraft, unsupported: [{ folder: "/escape", kind: "server", reason: "Server" }] },
  ];
  for (const invalid of invalids) {
    const fake = scripted([toolUse("submit_draft", invalid), toolUse("submit_draft", goodDraft)]);
    await draft(messy, { model: fake });
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
  }
});

test("bad tool-input shapes and invalid JSON are fed back, not crashed on", async () => {
  for (const input of [null, [], { __invalid_json: "{" }, { tools: [] }, { ...goodDraft, extra: true }, { ...goodDraft, fixtures: [{ folder: ".", path: ".gu/test/x", content: "x" }] }, { ...goodDraft, unsupported: [{ folder: ".", kind: "unknown", reason: "unknown" }] }]) {
    const fake = scripted([toolUse("submit_draft", input), toolUse("submit_draft", goodDraft)]);
    await draft(messy, { model: fake });
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
  }
});

test("read_files validates its shape and ten-path limit before reading", async () => {
  for (const input of [{ paths: "src/tool/cli.py" }, { paths: [42] }, { paths: Array(11).fill("src/tool/cli.py") }, { __invalid_json: "{" }]) {
    const fake = scripted([toolUse("read_files", input), toolUse("submit_draft", goodDraft)]);
    const result = await draft(messy, { model: fake });
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
    expect(result.filesSent).toBe(collectContext(messy).files.length);
  }
  const result = await draft(messy, { model: scripted([toolUse("read_files", { paths: Array(10).fill("src/tool/cli.py") }), toolUse("submit_draft", goodDraft)]) });
  expect(result.filesSent).toBe(collectContext(messy).files.length + 10);
});

test("read failures are fed back and never counted as files sent", async () => {
  const fake = scripted([toolUse("read_files", { paths: ["../outside", "missing"] }), toolUse("submit_draft", goodDraft)]);
  const result = await draft(messy, { model: fake });
  expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
  expect(result.filesSent).toBe(collectContext(messy).files.length);
});

test("two failed submissions throw DraftError with both validation errors", async () => {
  const fake = scripted([toolUse("submit_draft", badDraft), toolUse("submit_draft", { ...goodDraft, tools: [{ folder: ".", gu_yaml: "name: Invalid" }] }), toolUse("submit_draft", goodDraft)]);
  try {
    await draft(messy, { model: fake });
    throw new Error("Expected draft to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DraftError);
    expect((error as Error).message).toContain("yaml");
    expect((error as Error).message).toContain("name");
  }
  expect(fake.calls).toHaveLength(2);
});

test("malformed submissions also exhaust the two-submission limit", async () => {
  const fake = scripted([toolUse("submit_draft", { __invalid_json: "{" }), toolUse("submit_draft", null)]);
  await expect(draft(messy, { model: fake })).rejects.toThrow(DraftError);
  expect(fake.calls).toHaveLength(2);
});

test("refusal and max_tokens throw DraftError even if a partial submission exists", async () => {
  for (const stop of ["refusal", "max_tokens"] as const) {
    const fake = scripted([{ ...toolUse("submit_draft", goodDraft), stop }]);
    await expect(draft(messy, { model: fake })).rejects.toThrow(DraftError);
    expect(fake.calls).toHaveLength(1);
  }
});

test("too many rounds throws at the default eight or configured limit", async () => {
  for (const maxRounds of [undefined, 2]) {
    const fake = scripted(Array.from({ length: 9 }, () => toolUse("read_files", { paths: [] })));
    await expect(draft(messy, { model: fake, maxRounds })).rejects.toThrow(DraftError);
    expect(fake.calls).toHaveLength(maxRounds ?? 8);
  }
});

test("invalid round limits fail before calling the model", async () => {
  for (const maxRounds of [0, -1, 1.5, NaN, Infinity]) {
    const fake = scripted([]);
    await expect(draft(messy, { model: fake, maxRounds })).rejects.toThrow(DraftError);
    expect(fake.calls).toHaveLength(0);
  }
});

test("end_turn gets one exact reminder and can recover with a submission", async () => {
  const fake = scripted([turn({ stop: "end_turn", text: "Here is my analysis." }), toolUse("submit_draft", goodDraft)]);
  const result = await draft(messy, { model: fake });
  expect(result.rounds).toBe(2);
  expect(fake.calls[1].messages.at(-1)).toEqual({ role: "user", text: "Call submit_draft now." });
  expect(fake.calls[1].messages.some(m => m.role === "tool_results")).toBe(false);
});

test("a second end_turn without a submission throws after only one reminder", async () => {
  const fake = scripted([turn({ stop: "end_turn" }), toolUse("read_files", { paths: [] }), turn({ stop: "end_turn" })]);
  await expect(draft(messy, { model: fake })).rejects.toThrow(DraftError);
  expect(fake.calls[2].messages.filter(m => m.role === "user" && m.text === "Call submit_draft now.")).toHaveLength(1);
});

test("history only grows, preserves raw turns, and batches every call's result", async () => {
  const first = turn({
    raw: [{ opaque: "provider-specific thinking" }],
    toolCalls: [
      { id: "read", name: "read_files", input: { paths: ["src/tool/helper.py"] } },
      { id: "unknown", name: "unknown_tool", input: {} },
    ],
  });
  const fake = scripted([first, toolUse("submit_draft", badDraft, "bad"), toolUse("submit_draft", goodDraft, "good")]);
  await draft(messy, { model: fake });
  expect(fake.calls.map(c => c.messages.length)).toEqual([1, 3, 5]);
  expect(fake.calls[2].messages.slice(0, 3)).toEqual(fake.calls[1].messages);
  expect(fake.calls[1].messages[1]).toEqual({ role: "assistant", turn: first });
  expect(lastToolResults(fake.calls[1]).map(r => [r.id, r.isError])).toEqual([["read", false], ["unknown", true]]);
  expect(fake.calls.every(c => c.system === SYSTEM_PROMPT)).toBe(true);
});

test("a successful submission still processes other calls in the same turn", async () => {
  const fake = scripted([turn({ toolCalls: [
    { id: "submit", name: "submit_draft", input: goodDraft },
    { id: "read", name: "read_files", input: { paths: ["src/tool/helper.py"] } },
  ] })]);
  const result = await draft(messy, { model: fake });
  expect(result.filesSent).toBe(collectContext(messy).files.length + 1);
});

test("an unsupported-only repository is a valid completed submission", async () => {
  const input = { tools: [], fixtures: [], unsupported: [{ folder: ".", kind: "ui-locked" as const, reason: "Processing lives in a click handler." }] };
  const result = await draft(messy, { model: scripted([toolUse("submit_draft", input)]) });
  expect(result.tools).toEqual([]);
  expect(result.unsupported).toEqual(input.unsupported);
});

test("tool JSON schemas require every property and disallow extras at every object", async () => {
  const fake = scripted([toolUse("submit_draft", goodDraft)]);
  await draft(messy, { model: fake });
  expect(fake.calls[0].tools.map(t => t.name)).toEqual(["read_files", "submit_draft"]);
  function check(schema: any) {
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      for (const child of Object.values(schema.properties)) check(child);
    }
    if (schema.items) check(schema.items);
  }
  for (const tool of fake.calls[0].tools) check(tool.inputSchema);
  expect((fake.calls[0].tools[0].inputSchema.properties as any).paths.maxItems).toBe(10);
});

test("prompt contains the exact trap table, field reference, argv rules and drafting guidance", () => {
  const spec = readFileSync(join(import.meta.dir, "..", "docs", "superpowers", "specs", "2026-10-16-gu-design.md"), "utf8");
  const table = spec.slice(spec.indexOf("| Trap |"), spec.indexOf("\n\n**Test set"));
  expect(SYSTEM_PROMPT).toContain(table);
  for (const field of ["use_when", "runtime", "platforms", "requires", "install", "python", "pip", "node", "npm", "env", "required", "positional", "flag", "default", "timeout", "returns", "exit_code", "file_exists", "stdout_contains"]) expect(SYSTEM_PROMPT).toContain(field);
  for (const phrase of ["declaration order", 'flag ?? "--" + name', "caller", ".gu/test/", "owner", "submit_draft", "read_files", "non-interactive"]) expect(SYSTEM_PROMPT).toContain(phrase);
});

test("renderContext includes the listing, selected file content and stable boundaries", () => {
  const context = collectContext(messy);
  const rendered = renderContext(context);
  expect(rendered).toBe(renderContext(context));
  expect(rendered).toContain("src/tool/helper.py");
  expect(rendered).toContain('print("Hello")');
  expect(rendered).toContain("README.md");
  expect(rendered).toContain("3");
});

test("public API exports only the currently implemented entry points", () => {
  expect(Object.keys(api).sort()).toEqual(["draft", "DraftError", "collectContext", "parseManifest", "discoverInstalled", "modelFromEnv", "writeDraft", "ArgError", "buildArgv", "findTool", "toMcpTools", "installTool", "runSmokeTest"].sort());
  expect(api.draft).toBe(draft);
  expect(api.DraftError).toBe(DraftError);
});

test("I4 system installers and privilege commands get drafter feedback", async () => {
  for (const command of ["brew", "apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "zypper", "port", "snap", "winget", "choco", "scoop", "sudo", "su", "doas"]) {
    const invalid = { ...goodDraft, fixtures: [{ folder: "src/tool", path: ".gu/test/x", content: "", command: `/usr/local/bin/${command} install package` }] };
    const fake = scripted([toolUse("submit_draft", invalid), toolUse("submit_draft", goodDraft)]);
    await draft(messy, { model: fake });
    expect(fake.calls).toHaveLength(2);
    expect(lastToolResults(fake.calls[1])[0].isError).toBe(true);
    expect(lastToolResults(fake.calls[1])[0].content).toContain(command);
  }
});

test("I6 duplicate manifest names across folders require correction", async () => {
  const invalid = { ...goodDraft, tools: [...goodDraft.tools, { folder: "another", gu_yaml: yamlText }] };
  const fake = scripted([toolUse("submit_draft", invalid), toolUse("submit_draft", goodDraft)]);
  const r = await draft(messy, { model: fake });
  expect(fake.calls).toHaveLength(2);
  expect(lastToolResults(fake.calls[1])[0].content).toContain("duplicate manifest name 'tool'");
  expect(r.tools).toHaveLength(1);
});

test("I9 the actual initial model message stays within 150000 UTF-8 bytes", async () => {
  const root = join(temp, "huge-context"); mkdirSync(root);
  const long = "😀".repeat(40);
  for (let i = 0; i < 2005; i++) writeFileSync(join(root, `${i}-${long}.txt`), "small");
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `README-${i}.md`), "😀".repeat(30000));
  const fake = scripted([toolUse("submit_draft", goodDraft)]);
  await draft(root, { model: fake });
  const message = fake.calls[0].messages[0];
  if (message.role !== "user") throw new Error("Expected initial user context");
  expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(150000);
  expect(message.text).toMatch(/… \d+ more/);
  expect(message.text).toContain("--- End file list ---");
  expect(message.text).toContain("--- End file ---");
  expect(message.text).toContain("submit_draft with the complete proposal.");
  expect(message.text).not.toContain("�");
});
