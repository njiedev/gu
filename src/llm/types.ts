export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Turn {
  stop: "tool_use" | "end_turn" | "refusal" | "max_tokens" | "other";
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; turn: Turn }
  | { role: "tool_results"; results: { id: string; content: string; isError: boolean }[] };

export interface ChatModel {
  id: string;
  turn(system: string, messages: Msg[], tools: ToolDef[]): Promise<Turn>;
}
