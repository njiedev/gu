import { homedir } from "node:os";
import { join } from "node:path";

export function guHome(): string {
  return process.env.GU_HOME || join(homedir(), ".gu");
}

export function toolsDir(home: string): string {
  return join(home, "tools");
}
