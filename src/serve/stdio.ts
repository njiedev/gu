import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ArgError, buildArgv, findTool, toMcpTools } from "../core/tools";
import { killAllActive, runCommand, toolEnv } from "../core/run";
import { discoverInstalled } from "../manifest/discover";
import { guHome } from "../paths";
import { VERSION } from "../version";

export async function startStdioServer(opts: { guHome?: string; callerCwd?: string } = {}): Promise<void> {
  const home = opts.guHome ?? guHome();
  const callerCwd = opts.callerCwd ?? process.cwd();
  const server = new Server({ name: "gu", version: VERSION }, { capabilities: { tools: {} } });
  const discover = () => {
    const { tools, problems } = discoverInstalled(home);
    for (const problem of problems) console.error(`${problem.path}: ${problem.errors.join("; ")}`);
    return tools;
  };
  const result = (text: string, isError: boolean) => ({ content: [{ type: "text" as const, text }], isError });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools(discover()) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const found = findTool(discover(), request.params.name);
    if (!found) return result(`Unknown tool: ${request.params.name}`, true);
    const { loaded, tool } = found;
    let argv: string[];
    try {
      argv = buildArgv(tool, request.params.arguments ?? {}, callerCwd);
    } catch (error) {
      if (error instanceof ArgError) return result(error.message, true);
      throw error;
    }
    const run = await runCommand(argv, { cwd: loaded.dir, env: toolEnv(loaded), timeoutSec: tool.timeout });
    const text = run.stdout + (run.stderr ? `\n--- stderr ---\n${run.stderr}` : "") +
      (run.timedOut ? `\n[timed out after ${tool.timeout}s]` : `\n[exit code ${run.exitCode}]`);
    return result(text, run.exitCode !== 0 || run.timedOut);
  });
  server.onerror = error => console.error(error.message);
  const shutdown = (code: number) => {
    killAllActive();
    process.exit(code);
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  process.stdin.once("end", () => shutdown(0));
  server.onclose = () => shutdown(0);
  await server.connect(new StdioServerTransport());
}
