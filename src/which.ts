import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Find a program on PATH, like the shell would. */
export function which(program: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Not here. */ }
  }
  return null;
}
