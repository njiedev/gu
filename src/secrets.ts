import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guHome } from "./paths";

const file = (home: string) => join(home, "secrets.json");

/** Secrets entered at install time, readable only by the owner. */
export function readSecrets(home = guHome()): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(file(home), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

export function saveSecret(name: string, value: string, home = guHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secrets = { ...readSecrets(home), [name]: value };
  writeFileSync(file(home), JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file(home), 0o600);
}

/** Ask for a secret in the terminal without echoing it. */
export function promptSecret(name: string, description: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(`${description} needs ${name}. Paste it and press Enter (leave empty to skip): `);
    let value = "";
    const done = (result: string | undefined) => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done(value || undefined);
        if (char === "\u0003") return done(undefined); // Ctrl-C
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
