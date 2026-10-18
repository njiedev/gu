import Anthropic from "@anthropic-ai/sdk";
import type { ChatModel, Msg, Turn } from "./types";

function message(msg: Msg): Anthropic.Beta.BetaMessageParam {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.text };
    case "assistant":
      return { role: "assistant", content: msg.turn.raw as Anthropic.Beta.BetaContentBlockParam[] };
    case "tool_results":
      return {
        role: "user",
        content: msg.results.map(result => ({
          type: "tool_result", tool_use_id: result.id,
          content: result.content, is_error: result.isError,
        })),
      };
  }
}

function stopReason(reason: Anthropic.Beta.BetaStopReason | null): Turn["stop"] {
  switch (reason) {
    case "tool_use": case "end_turn": case "refusal": case "max_tokens": return reason;
    default: return "other";
  }
}

const unsupportedKeywords = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern",
]);

/** Copy a JSON schema into Anthropic's supported strict subset. */
export function toStrictSchema(schema: unknown): any {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (unsupportedKeywords.has(key)) continue;
    // These are maps of schema names, not schemas themselves.
    if (["properties", "$defs", "definitions", "patternProperties"].includes(key) && value && typeof value === "object") {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toStrictSchema(child)]));
    } else if (["default", "const", "enum", "examples"].includes(key)) {
      result[key] = structuredClone(value);
    } else result[key] = toStrictSchema(value);
  }
  if (result.type === "object" || (Array.isArray(result.type) && result.type.includes("object")) || result.properties) result.additionalProperties = false;
  return result;
}

export function anthropicModel(opts: { client?: Anthropic; model?: string } = {}): ChatModel {
  const model = opts.model ?? "claude-opus-5-5";
  let client = opts.client;
  return {
    id: `anthropic:${model}`,
    async turn(system, messages, tools) {
      client ??= new Anthropic();
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model, system, max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        tool_choice: { type: "auto" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: messages.map(message),
        tools: tools.map(tool => ({
          name: tool.name, description: tool.description,
          input_schema: toStrictSchema(tool.inputSchema) as Anthropic.Beta.BetaTool.InputSchema,
          strict: true,
        })),
      };
      const response = await client.beta.messages.create(params);
      const stop = stopReason(response.stop_reason);
      const content = response.content;
      return {
        stop,
        text: content.filter(block => block.type === "text").map(block => block.text).join(""),
        toolCalls: content.filter(block => block.type === "tool_use").map(block => ({
          id: block.id, name: block.name, input: block.input,
        })),
        raw: content,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}
