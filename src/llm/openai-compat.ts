import OpenAI from "openai";
import type { ChatModel, Msg, Turn } from "./types";

function messagesFor(msg: Msg): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  switch (msg.role) {
    case "user": return [{ role: "user", content: msg.text }];
    case "assistant": return [msg.turn.raw as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam];
    case "tool_results": return msg.results.map(result => ({
      role: "tool", tool_call_id: result.id, content: result.content,
    }));
  }
}

function stopReason(reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"]): Turn["stop"] {
  switch (reason) {
    case "tool_calls": return "tool_use";
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "content_filter": return "refusal";
    default: return "other";
  }
}

function argumentsInput(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return { __invalid_json: raw }; }
}

export function openaiCompatModel(opts: { baseURL: string; apiKey: string; model: string; client?: OpenAI }): ChatModel {
  let client = opts.client;
  return {
    id: `openai-compatible:${opts.model}`,
    async turn(system, messages, tools) {
      client ??= new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: opts.model,
        messages: [{ role: "system", content: system }, ...messages.flatMap(messagesFor)],
        tools: tools.map(tool => ({ type: "function", function: {
          name: tool.name, description: tool.description, parameters: tool.inputSchema,
        } })),
        tool_choice: "auto",
      };
      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];
      if (!choice) throw new Error("The model returned no response choices.");
      const stop = stopReason(choice.finish_reason);
      const message = choice.message;
      return {
        stop, text: message.content ?? "",
        toolCalls: (message.tool_calls ?? []).filter(call => call.type === "function").map(call => ({
          id: call.id, name: call.function.name, input: argumentsInput(call.function.arguments),
        })),
        raw: message,
        usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
      };
    },
  };
}
