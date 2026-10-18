#!/usr/bin/env bun

import { publishCommand } from "./commands/publish";
import { installCommand } from "./commands/install";
import { statusCommand } from "./commands/status";
import { register } from "./commands/register";
import { startStdioServer } from "./serve/stdio";
import { VERSION } from "./version";

switch (process.argv[2]) {
  case "publish": {
    process.exitCode = await publishCommand(process.argv.slice(3));
    break;
  }
  case "install":
    process.exitCode = await installCommand(process.argv[3]);
    break;
  case "status":
    process.exitCode = statusCommand();
    break;
  case "serve":
    await startStdioServer();
    break;
  case "register":
    process.exitCode = await register();
    break;
  case "--version":
    console.log(VERSION);
    break;
  default:
    console.error("Usage: gu <publish | install | status | serve | register>");
    process.exit(1);
}
