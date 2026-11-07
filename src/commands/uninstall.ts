import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { guHome, toolsDir } from "../paths";

export function uninstallCommand(args: string[], home = guHome(), log = console.log, error = console.error): number {
  if (args.length !== 1 || !/^[a-z][a-z0-9-]{0,40}$/.test(args[0])) { error("Usage: gu uninstall <tool name> (see gu status)"); return 1; }
  const dir = join(toolsDir(home), args[0]);
  if (!existsSync(dir)) { error(`${args[0]} is not installed. gu status lists installed tools.`); return 1; }
  rmSync(dir, { recursive: true, force: true });
  log(`Uninstalled ${args[0]}. Your agents stop seeing it from their next tool list.`);
  return 0;
}
