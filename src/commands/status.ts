import { discoverInstalled } from "../manifest/discover";
import { guHome } from "../paths";
import { checkPlatform } from "../install/platform";
import { staleNote } from "../install/staleness";

export function statusCommand(home = guHome(), log: (s: string) => void = console.log): number {
  const { tools, problems } = discoverInstalled(home);
  if (!tools.length && !problems.length) log("No tools installed yet.");
  for (const { manifest, dir } of tools) {
    const platform = checkPlatform(manifest);
    const stale = staleNote(dir);
    log(`${manifest.name} (version ${manifest.version}): ${manifest.tools.map(tool => tool.name).join(", ")}` +
      `${platform.ok ? "" : ` — can't run here: ${platform.reasons.join("; ")}`}` +
      `${stale ? ` — out of date: ${stale}` : ""}`);
  }
  for (const problem of problems) log(`Could not load ${problem.path}: ${problem.errors.join("; ")}`);
  return problems.length ? 1 : 0;
}
