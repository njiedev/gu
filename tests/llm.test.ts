import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { anthropicModel } from "../src/llm/anthropic";
import { openaiCompatModel } from "../src/llm/openai-compat";
import { modelFromEnv } from "../src/llm/from-env";
import type { ToolDef } from "../src/llm/types";

const previousHome = process.env.GU_HOME;
const home = mkdtempSync(join(tmpdir(), "gu-llm-"));
process.env.GU_HOME = home;
afterAll(() => {
  if (previousHome === undefined) delete process.env.GU_HOME;
  else process.env.GU_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const def: ToolDef = { name: "read_files", description: "Read files", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"], additionalProperties: false } };
function fakeAnthropic(responses: object[]) {
  const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client = { beta: { messages: { create: async (p: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => { calls.push(p); return responses.shift(); } } } } as unknown as Anthropic;
  return { client, calls };
}
function claude(stop_reason = "tool_use", content: Anthropic.Beta.BetaContentBlock[] = [{ type: "text", text: "Reading", citations: null }, { type: "tool_use", id: "t1", name: "read_files", input: { paths: ["a"] }, caller: { type: "direct" } }]) {
  return { stop_reason, content, usage: { input_tokens: 5, output_tokens: 3 } };
}
function fakeOpenAI(responses: object[]) {
  const calls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
  const client = { chat: { completions: { create: async (p: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => { calls.push(p); return responses.shift(); } } } } as unknown as OpenAI;
  return { client, calls };
}
function completion(finish_reason = "tool_calls", args = '{"paths":["a"]}') {
  return { choices: [{ finish_reason, message: { role: "assistant" as const, content: "Reading", tool_calls: [{ id: "c1", type: "function" as const, function: { name: "read_files", arguments: args } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
}
const options = { baseURL: "http://x", apiKey: "k", model: "m" };

test("Claude adapter sends the required settings", async () => {
  const fake = fakeAnthropic([claude()]);
  const model = anthropicModel({ client: fake.client });
  const t = await model.turn("sys", [{ role: "user", text: "hi" }], [def]);
  expect(model.id).toBe("anthropic:claude-opus-5-5");
  expect(fake.calls[0]).toMatchObject({ model: "claude-opus-5-5", system: "sys", max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "high" }, tool_choice: { type: "auto" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", tools: [{ name: def.name, description: def.description, input_schema: def.inputSchema, strict: true }], messages: [{ role: "user", content: "hi" }] });
  expect(fake.calls[0].temperature).toBeUndefined();
  expect(fake.calls[0].top_p).toBeUndefined();
  expect(fake.calls[0].stream).not.toBe(true);
  expect(t.toolCalls).toEqual([{ id: "t1", name: "read_files", input: { paths: ["a"] } }]);
  expect(t.text).toBe("Reading");
  expect(t.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
});
test("Claude adapter replays assistant content unchanged and groups results", async () => {
  const response = claude("tool_use", [{ type: "thinking", thinking: "reason", signature: "sig" }, ...claude().content]);
  const fake = fakeAnthropic([response, claude("end_turn", [])]);
  const model = anthropicModel({ client: fake.client, model: "custom" });
  const t = await model.turn("sys", [], []);
  await model.turn("sys", [{ role: "user", text: "hi" }, { role: "assistant", turn: t }, { role: "tool_results", results: [{ id: "t1", content: "ok", isError: false }, { id: "t2", content: "failed", isError: true }] }], []);
  expect(t.raw).toBe(response.content);
  expect(fake.calls[1].messages[1].content).toBe(response.content);
  expect(fake.calls[1].messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }, { type: "tool_result", tool_use_id: "t2", content: "failed", is_error: true }] });
  expect(fake.calls[0].model).toBe("custom");
});
for (const [reason, stop] of Object.entries({ tool_use: "tool_use", end_turn: "end_turn", refusal: "refusal", max_tokens: "max_tokens", pause_turn: "other", stop_sequence: "other" } as const)) {
  test(`Claude maps ${reason} before reading content`, async () => {
    let checked = false;
    const response = { get stop_reason() { checked = true; return reason; }, get content() { expect(checked).toBe(true); return []; }, usage: { input_tokens: 0, output_tokens: 0 } };
    const fake = fakeAnthropic([response]);
    expect((await anthropicModel({ client: fake.client }).turn("", [], [])).stop).toBe(stop);
  });
}
test("OpenAI-compatible adapter maps tools, assistant replay, and tool results", async () => {
  const response = completion();
  const fake = fakeOpenAI([response, completion("stop")]);
  const model = openaiCompatModel({ ...options, client: fake.client });
  const t = await model.turn("sys", [{ role: "user", text: "hi" }], [def]);
  expect(model.id).toBe("openai-compatible:m");
  expect(fake.calls[0]).toMatchObject({ model: "m", tool_choice: "auto", tools: [{ type: "function", function: { name: def.name, description: def.description, parameters: def.inputSchema } }], messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] });
  expect(t.toolCalls).toEqual([{ id: "c1", name: "read_files", input: { paths: ["a"] } }]);
  expect(t.text).toBe("Reading");
  expect(t.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  await model.turn("sys", [{ role: "assistant", turn: t }, { role: "tool_results", results: [{ id: "c1", content: "ok", isError: false }, { id: "c2", content: "failed", isError: true }] }], []);
  expect(fake.calls[1].messages.slice(1)).toEqual([response.choices[0].message, { role: "tool", tool_call_id: "c1", content: "ok" }, { role: "tool", tool_call_id: "c2", content: "failed" }]);
});
test("OpenAI-compatible adapter flags bad JSON arguments", async () => {
  const fake = fakeOpenAI([completion("tool_calls", "{oops")]);
  const t = await openaiCompatModel({ ...options, client: fake.client }).turn("", [], []);
  expect(t.toolCalls[0].input).toEqual({ __invalid_json: "{oops" });
});
for (const [reason, stop] of Object.entries({ tool_calls: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal", function_call: "other" } as const)) {
  test(`OpenAI maps ${reason}`, async () => {
    const fake = fakeOpenAI([completion(reason)]);
    expect((await openaiCompatModel({ ...options, client: fake.client }).turn("", [], [])).stop).toBe(stop);
  });
}
test("OpenAI handles absent usage and null content", async () => {
  const fake = fakeOpenAI([{ choices: [{ finish_reason: "stop", message: { role: "assistant", content: null } }] }]);
  const t = await openaiCompatModel({ ...options, client: fake.client }).turn("", [], []);
  expect(t.text).toBe("");
  expect(t.toolCalls).toEqual([]);
  expect(t.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});
test("modelFromEnv validates required variables and selects models", () => {
  const env = { GU_LLM: "openai-compatible", GU_LLM_BASE_URL: "http://x", GU_LLM_API_KEY: "k", GU_LLM_MODEL: "m" };
  for (const key of ["GU_LLM_BASE_URL", "GU_LLM_API_KEY", "GU_LLM_MODEL"]) expect(() => modelFromEnv({ ...env, [key]: undefined })).toThrow(key);
  expect(modelFromEnv({}).id).toBe("anthropic:claude-opus-5-5");
  expect(modelFromEnv({ GU_LLM_MODEL: "custom" }).id).toBe("anthropic:custom");
  expect(modelFromEnv(env).id).toBe("openai-compatible:m");
  expect(() => modelFromEnv({ GU_LLM: "unknown" })).toThrow("GU_LLM");
});

test("I1 composed drafter and MCP requests contain only supported strict schemas", async () => {
  const { draft } = await import("../src/draft/drafter");
  const { toMcpTools } = await import("../src/core/tools");
  const { parseManifest } = await import("../src/manifest/schema");
  const { readFileSync } = await import("node:fs");
  const fake = fakeAnthropic([claude("tool_use", [{ type: "tool_use", id: "done", name: "submit_draft", input: { tools: [], fixtures: [], unsupported: [] }, caller: { type: "direct" } }]), claude("end_turn", [])]);
  const model = anthropicModel({ client: fake.client });
  await draft(home, { model });
  const parsed = parseManifest(readFileSync(join(import.meta.dir, "fixtures/manifests/colorgrade.yaml"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.errors.join());
  const defs = toMcpTools([{ manifest: parsed.manifest, dir: home }]);
  await model.turn("", [], defs);
  const unsupported = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern"]);
  function check(value: any) {
    if (!value || typeof value !== "object") return;
    if (value.type === "object") expect(value.additionalProperties).toBe(false);
    for (const [key, child] of Object.entries(value)) { expect(unsupported.has(key)).toBe(false); check(child); }
  }
  for (const call of fake.calls) for (const tool of call.tools!) check((tool as any).input_schema);
  expect(defs[0].inputSchema).not.toHaveProperty("additionalProperties");
});

test("I1 strict normalization strips nested constraints without changing property names or OpenAI schemas", async () => {
  const { toStrictSchema } = await import("../src/llm/anthropic");
  const schema = { type: "object", properties: { maximum: { type: "number", minimum: 1, maximum: 9, exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 1 }, nested: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 5, pattern: "x" } } } } } };
  const original = structuredClone(schema);
  expect(toStrictSchema(schema)).toEqual({ type: "object", additionalProperties: false, properties: { maximum: { type: "number" }, nested: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" } } } } } });
  expect(schema).toEqual(original);
  const fake = fakeOpenAI([completion()]);
  await openaiCompatModel({ ...options, client: fake.client }).turn("", [], [{ ...def, inputSchema: schema }]);
  expect((fake.calls[0].tools![0] as any).function.parameters).toEqual(original);
});
