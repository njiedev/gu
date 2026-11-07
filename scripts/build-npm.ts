// Bundles the CLI into one file that runs on Node, for the npm package.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  format: "esm",
  outdir: "dist",
  naming: "cli.js",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const out = "dist/cli.js";
// Swap Bun's shebang for Node's.
const code = readFileSync(out, "utf8").replace(/^(#!.*\n|\/\/ @bun\n)+/, "");
writeFileSync(out, `#!/usr/bin/env node\n${code}`);
chmodSync(out, 0o755);
console.log(`Built ${out} (${(Buffer.byteLength(code) / 1024).toFixed(0)} KB)`);
