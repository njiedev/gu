import type { Manifest, Platform } from "../manifest/schema";

export interface Probe {
  platform: NodeJS.Platform;
  arch: string;
  which(cmd: string): string | null;
}

function platformName(platform: NodeJS.Platform): Platform | undefined {
  return platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
}

export function currentPlatform(): Platform {
  const platform = platformName(process.platform);
  if (!platform) throw new Error(`Unsupported operating system: ${process.platform}`);
  return platform;
}

export function checkPlatform(m: Manifest, probe: Probe = {
  platform: process.platform, arch: process.arch, which: cmd => Bun.which(cmd),
}): { ok: boolean; reasons: string[]; installHints: string[] } {
  const reasons: string[] = [];
  const installHints: string[] = [];
  const platform = platformName(probe.platform);
  if (!platform || !m.platforms.includes(platform)) reasons.push(`supports ${m.platforms.join(", ")}, but this computer runs ${platform ?? probe.platform}`);
  const apple = probe.platform === "darwin" && probe.arch === "arm64";
  const gpu = m.requires.gpu;
  if (gpu === "apple" && !apple) reasons.push("needs an Apple Silicon Mac");
  if (gpu === "nvidia" && !probe.which("nvidia-smi")) reasons.push("needs an NVIDIA GPU (nvidia-smi was not found)");
  if (gpu === "any" && !apple && !probe.which("nvidia-smi")) reasons.push("needs an NVIDIA GPU or an Apple Silicon Mac");
  for (const cmd of m.requires.system) {
    if (probe.which(cmd)) continue;
    reasons.push(`needs ${cmd}`);
    if (probe.platform === "darwin") installHints.push(`brew install ${cmd}`);
    else if (probe.platform === "linux") installHints.push(`sudo apt install ${cmd}`);
  }
  return { ok: reasons.length === 0, reasons, installHints };
}
