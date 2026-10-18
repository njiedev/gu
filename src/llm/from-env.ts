import { anthropicModel } from "./anthropic";
import { openaiCompatModel } from "./openai-compat";
import type { ChatModel } from "./types";

export function modelFromEnv(env: Record<string, string | undefined> = process.env): ChatModel {
  const provider = env.GU_LLM ?? "anthropic";
  if (provider === "anthropic") return anthropicModel({ model: env.GU_LLM_MODEL });
  if (provider === "openai-compatible") {
    const required = (name: string): string => {
      const value = env[name];
      if (!value) throw new Error(`Set ${name} to use an OpenAI-compatible model.`);
      return value;
    };
    return openaiCompatModel({
      baseURL: required("GU_LLM_BASE_URL"),
      apiKey: required("GU_LLM_API_KEY"),
      model: required("GU_LLM_MODEL"),
    });
  }
  throw new Error(`Unknown GU_LLM value "${provider}". Use anthropic or openai-compatible.`);
}
