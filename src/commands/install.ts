import { installTool } from "../install/install";

export async function installCommand(folder?: string): Promise<number> {
  if (!folder) { console.error("Usage: gu install <folder>"); return 1; }
  const result = await installTool(folder);
  if (!result.ok) { console.error(result.message); return 1; }
  console.log(`Installed ${result.loaded.manifest.name} (version ${result.loaded.manifest.version}). It passed its test.`);
  return 0;
}
