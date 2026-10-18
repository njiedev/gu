import { discoverInstalled } from "../manifest/discover";
import { guHome } from "../paths";
import { checkPlatform } from "../install/platform";

export function statusCommand(): number {
  const { tools, problems } = discoverInstalled(guHome());
  if (!tools.length && !problems.length) console.log("No tools installed yet.");
  for (const { manifest } of tools) {
    const platform = checkPlatform(manifest);
    console.log(`${manifest.name} (version ${manifest.version}): ${manifest.tools.map(tool => tool.name).join(", ")}${platform.ok ? "" : ` — can't run here: ${platform.reasons.join("; ")}`}`);
  }
  for (const problem of problems) console.log(`Could not load ${problem.path}: ${problem.errors.join("; ")}`);
  return problems.length ? 1 : 0;
}
