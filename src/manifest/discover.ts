import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolsDir } from "../paths";
import { parseManifest, type Manifest } from "./schema";

export const INSTALLED_MARKER = ".gu-installed";

export interface LoadedTool {
  manifest: Manifest;
  dir: string;
}

export function discoverInstalled(guHome: string): {
  tools: LoadedTool[];
  problems: { path: string; errors: string[] }[];
} {
  const tools: LoadedTool[] = [];
  const problems: { path: string; errors: string[] }[] = [];
  const root = toolsDir(guHome);
  const report = (path: string, error: unknown) => {
    problems.push({ path, errors: [`path: ${error instanceof Error ? error.message : String(error)}`] });
  };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(root, error);
    return { tools, problems };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const toolDir = join(root, entry.name);
    let versions;
    try {
      versions = readdirSync(toolDir, { withFileTypes: true })
        .filter(version => version.isDirectory() && /^\d+$/.test(version.name) && existsSync(join(toolDir, version.name, INSTALLED_MARKER)))
        .sort((a, b) => {
          const left = BigInt(a.name);
          const right = BigInt(b.name);
          return left === right ? a.name.localeCompare(b.name) : left > right ? -1 : 1;
        });
    } catch (error) {
      report(toolDir, error);
      continue;
    }
    if (!versions.length) continue;
    const dir = join(toolDir, versions[0].name);
    const path = join(dir, "gu.yaml");
    try {
      const result = parseManifest(readFileSync(path, "utf8"));
      if (result.ok) tools.push({ manifest: result.manifest, dir });
      else problems.push({ path, errors: result.errors });
    } catch (error) {
      report(path, error);
    }
  }
  return { tools, problems };
}
