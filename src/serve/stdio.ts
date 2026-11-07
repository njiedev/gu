import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ArgError, buildArgv, findTool, toMcpTools } from "../core/tools";
import { killAllActive, runCommand, toolEnv } from "../core/run";
import { fileURLToPath } from "node:url";
import { changedFiles, describeOutputs, mentionedImages, snapshot } from "../core/outputs";
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
  // The project the agent is working in: the client's first folder root when it
  // shares roots, otherwise the folder the client started gu in.
  async function projectFolder(): Promise<string> {
    if (opts.callerCwd || !server.getClientCapabilities()?.roots) return callerCwd;
    try {
      const { roots } = await server.listRoots(undefined, { timeout: 2000 });
      const root = roots.find(root => root.uri.startsWith("file://"));
      if (root) return fileURLToPath(root.uri);
    } catch { /* Clients may advertise roots and still fail to answer. */ }
    return callerCwd;
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools(discover()) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const found = findTool(discover(), request.params.name);
    if (!found) return result(`Unknown tool: ${request.params.name}`, true);
    const { loaded, tool } = found;
    const cwd = await projectFolder();
    let argv: string[];
    try {
      argv = buildArgv(tool, request.params.arguments ?? {}, cwd, loaded.dir);
    } catch (error) {
      if (error instanceof ArgError) return result(error.message, true);
      throw error;
    }
    // Long jobs report elapsed time so clients that reset timeouts on progress keep waiting.
    const progressToken = request.params._meta?.progressToken;
    const started = Date.now();
    const ticker = progressToken === undefined ? undefined : setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: seconds, total: tool.timeout, message: `${tool.name} running for ${seconds}s` } }).catch(() => {});
    }, 5000);
    const before = snapshot(cwd);
    let run;
    try {
      run = await runCommand(argv, { cwd, env: toolEnv(loaded), timeoutSec: tool.timeout });
    } finally {
      clearInterval(ticker);
    }
    const outputs = describeOutputs(cwd, changedFiles(cwd, before), mentionedImages(run.stdout, cwd));
    const text = run.stdout + (run.stderr ? `\n--- stderr ---\n${run.stderr}` : "") +
      (run.timedOut ? `\n[timed out after ${tool.timeout}s]` : `\n[exit code ${run.exitCode}]`) + outputs.note;
    return { content: [{ type: "text" as const, text }, ...outputs.images], isError: run.exitCode !== 0 || run.timedOut };
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
