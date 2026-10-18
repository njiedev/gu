import { basename } from "node:path";
import { splitCommand } from "../core/tools";

const forbidden = new Set([
  "brew", "apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "zypper", "port",
  "snap", "winget", "choco", "scoop", "sudo", "su", "doas",
]);

export function fixtureArgv(command: string): string[] {
  const argv = splitCommand(command);
  if (!argv[0]) throw new Error("A fixture command must name a program.");
  if (forbidden.has(basename(argv[0]))) {
    throw new Error(`Cannot run fixture command ${argv[0]}: system installers and privilege commands are not allowed.`);
  }
  return argv;
}
