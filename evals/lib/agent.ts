import type { ChatModel, McpToolDef, ToolDef } from "../../src/index";

export async function pickTool(model: ChatModel, tools: McpToolDef[], text: string): Promise<{
  name: string; input: Record<string, unknown>;
} | null> {
  const definitions: ToolDef[] = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const turn = await model.turn(
    "You are a coding agent. Use a tool if one fits the request; otherwise answer briefly.",
    [{ role: "user", text }], definitions,
  );
  if (turn.stop !== "end_turn" && turn.stop !== "tool_use") throw new Error(`Agent stopped with ${turn.stop}.`);
  if (!turn.toolCalls.length) {
    if (turn.stop !== "end_turn") throw new Error("Agent reported tool use without a call.");
    return null;
  }
  if (turn.toolCalls.length !== 1) throw new Error(`Expected one tool selection; got ${turn.toolCalls.length}.`);
  const { name, input } = turn.toolCalls[0];
  if (!tools.some(tool => tool.name === name)) throw new Error(`Agent selected an unknown tool: ${name}.`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object.");
  return { name, input: input as Record<string, unknown> };
}
