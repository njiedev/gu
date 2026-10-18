import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, realpathSync, readdirSync, symlinkSync, readlinkSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPlatform, currentPlatform } from "../src/install/platform";
import { installTool } from "../src/install/install";
import { INSTALLED_MARKER } from "../src/manifest/discover";
import { runSmokeTest } from "../src/smoke";
import { parseManifest, type Manifest } from "../src/manifest/schema";
const fixture = (name: string) => join(import.meta.dir, "fixtures", "tools", name);
function manifest(name = "py-echo"): Manifest {
  const r = parseManifest(readFileSync(join(fixture(name), "gu.yaml"), "utf8"));
  if (!r.ok) throw new Error(r.errors.join());
  return r.manifest;
}
let home: string;
let oldHome: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "gu-install-")); oldHome = process.env.GU_HOME; process.env.GU_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.GU_HOME; else process.env.GU_HOME = oldHome; });
test("nvidia tool is reported as can't-run-here on a Mac", () => {
  const m = manifest(); m.requires.gpu = "nvidia";
  const r = checkPlatform(m, { platform: "darwin", arch: "arm64", which: () => null });
  expect(r.ok).toBe(false); expect(r.reasons.join()).toMatch(/NVIDIA/i);
});
test("missing system program gives OS-specific hints", () => {
  const m = manifest(); m.requires.system = ["ffmpeg"];
  for (const [platform, hint] of [["darwin", "brew install ffmpeg"], ["linux", "sudo apt install ffmpeg"]] as const) {
    expect(checkPlatform(m, { platform, arch: "arm64", which: () => null }).installHints).toEqual([hint]);
  }
});
test("platform and GPU combinations are enforced", () => {
  expect(currentPlatform()).toBe(process.platform === "darwin" ? "macos" : "linux");
  const m = manifest(); m.requires.gpu = "apple";
  expect(checkPlatform(m, { platform: "darwin", arch: "x64", which: () => null }).ok).toBe(false);
  expect(checkPlatform(m, { platform: "darwin", arch: "arm64", which: () => null }).ok).toBe(true);
  m.requires.gpu = "any";
  expect(checkPlatform(m, { platform: "linux", arch: "x64", which: () => "/bin/nvidia-smi" }).ok).toBe(true);
  expect(checkPlatform(m, { platform: "linux", arch: "x64", which: () => null }).ok).toBe(false);
  m.platforms = ["windows"];
  expect(checkPlatform(m).ok).toBe(false);
});
for (const marked of [false, true]) test(`installs Python, excludes generated folders, and replaces ${marked ? "verified" : "dead"} versions`, async () => {
  const src = join(home, "source"); cpSync(fixture("py-echo"), src, { recursive: true });
  for (const dir of [".git", "node_modules", ".venv", "__pycache__"]) { mkdirSync(join(src, dir)); writeFileSync(join(src, dir, "sentinel"), "excluded"); }
  writeFileSync(join(src, "gu.yaml"), readFileSync(join(src, "gu.yaml"), "utf8").replaceAll("python3 ", "python ") + '\ninstall: {python: "3.12", pip: requirements.txt}\n');
  const dest = join(home, "tools", "py-echo", "1"); mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "old"), "old");
  if (marked) writeFileSync(join(dest, INSTALLED_MARKER), "verified");
  const r = await installTool(src, { guHome: home, dependencyTimeoutSec: 10 });
  expect(r.ok).toBe(true); expect(existsSync(join(dest, ".venv", "bin", "python"))).toBe(true);
  expect(existsSync(join(dest, "old"))).toBe(false);
  expect(existsSync(join(dest, INSTALLED_MARKER))).toBe(true);
  for (const dir of [".git", "node_modules", ".venv", "__pycache__"]) expect(existsSync(join(dest, dir, "sentinel"))).toBe(false);
  if (r.ok) {
    expect(r.smoke.run.stdout).toContain("hello-gu");
    expect((await runSmokeTest(r.loaded)).passed).toBe(true);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "installed-python-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("src/cli.ts"), "serve"], env: { ...process.env, GU_HOME: home } as Record<string, string>, stderr: "pipe" }));
      const called = await client.callTool({ name: "py-echo__echo", arguments: { text: "after-install" } });
      expect(called.isError).toBeFalsy();
      expect(JSON.stringify(called.content)).toContain("after-install");
    } finally { await client.close(); }
  }
}, 40_000);
test("installs and smoke-tests the Node fixture", async () => {
  const src = join(home, "source"); cpSync(fixture("node-echo"), src, { recursive: true });
  writeFileSync(join(src, "gu.yaml"), readFileSync(join(src, "gu.yaml"), "utf8") + '\ninstall: {node: "20", npm: package.json}\n');
  const r = await installTool(src, { guHome: home, dependencyTimeoutSec: 10 });
  expect(r.ok).toBe(true); if (r.ok) expect(r.smoke.run.stdout).toContain("hello-gu");
}, 40_000);
test("stale output file does not count", async () => {
  const dir = join(home, "stale"); cpSync(fixture("py-stale"), dir, { recursive: true });
  utimesSync(join(dir, "out.txt"), new Date(0), new Date(0));
  const m = manifest("py-stale"); m.test.run = "node -e 'console.log(\"hello-gu\")'";
  const s = await runSmokeTest({ manifest: m, dir });
  expect(s.passed).toBe(false); expect(s.checks.find(c => c.name === "file_exists")!.passed).toBe(false);
});
test("fresh globbed output passes and wrong stdout fails", async () => {
  const m = manifest(); m.test.run = `node -e 'require("fs").writeFileSync("out.txt", "ok"); console.log("hello-gu")'`; m.test.expect.file_exists = "*.txt";
  expect((await runSmokeTest({ manifest: m, dir: home })).passed).toBe(true);
  m.test.expect.stdout_contains = "missing";
  expect((await runSmokeTest({ manifest: m, dir: home })).passed).toBe(false);
});
test("failed smoke test removes the install", async () => {
  expect(await installTool(fixture("py-broken"), { guHome: home })).toMatchObject({ ok: false, stage: "smoke" });
  expect(existsSync(join(home, "tools", "py-broken", "1"))).toBe(false);
}, 40_000);
test("invalid manifests and unsupported platforms fail before copy", async () => {
  expect(await installTool(home)).toMatchObject({ ok: false, stage: "manifest" });
  const source = join(home, "source"); cpSync(fixture("node-echo"), source, { recursive: true });
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8").replace("[macos, linux]", "[windows]"));
  expect(await installTool(source)).toMatchObject({ ok: false, stage: "platform" });
  expect(existsSync(join(home, "tools"))).toBe(false);
});
test("dependency failure removes the install", async () => {
  const source = probeSource();
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8") + '\ninstall: {npm: package.json}\n');
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nprocess.exit(7);`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin;
  try {
    expect(await installTool(source)).toMatchObject({ ok: false, stage: "deps" });
    expect(existsSync(join(home, "tools", "probe", "1"))).toBe(false);
  } finally { process.env.PATH = oldPath; }
});
test("CLI installs, reports status and discovery problems, and rejects missing folder", async () => {
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args], { timeout: 10_000, env: process.env });
  expect(cli("install").exitCode).toBe(1);
  const installed = cli("install", fixture("node-echo")); expect(installed.exitCode).toBe(0); expect(installed.stdout.toString()).toContain("Installed node-echo (version 1). It passed its test.");
  const dir = join(home, "tools", "node-echo", "1");
  writeFileSync(join(dir, "gu.yaml"), readFileSync(join(dir, "gu.yaml"), "utf8").replace("[macos, linux]", "[windows]"));
  const broken = join(home, "tools", "broken", "1"); mkdirSync(broken, { recursive: true }); writeFileSync(join(broken, INSTALLED_MARKER), "verified");
  const status = cli("status"); expect(status.stdout.toString()).toContain("node-echo (version 1)"); expect(status.stdout.toString()).toContain("echo"); expect(status.stdout.toString()).toContain("can't run here:"); expect(status.stdout.toString()).toContain("broken");
}, 40_000);
test("timestamp tolerance never accepts an unchanged recent file", async () => {
  const m = manifest(); m.test.run = "node -e 'console.log(\"hello-gu\")'"; m.test.expect.file_exists = "out.txt";
  writeFileSync(join(home, "out.txt"), "pre-existing");
  expect((await runSmokeTest({ manifest: m, dir: home })).checks.find(c => c.name === "file_exists")!.passed).toBe(false);
});
test("copying stale output does not make the install pass", async () => {
  const source = join(home, "source"); cpSync(fixture("py-stale"), source, { recursive: true });
  utimesSync(join(source, "out.txt"), new Date(0), new Date(0));
  expect(await installTool(source)).toMatchObject({ ok: false, stage: "smoke" });
  expect(existsSync(join(home, "tools", "py-stale", "1"))).toBe(false);
}, 40_000);
test("installing from the destination does not delete the source", async () => {
  const source = join(home, "tools", "node-echo", "1"); cpSync(fixture("node-echo"), source, { recursive: true });
  expect(await installTool(source)).toMatchObject({ ok: false, stage: "deps" });
  expect(existsSync(join(source, "gu.yaml"))).toBe(true);
});
test("installing from a descendant named ..source rejects overlap and preserves the source", async () => {
  const source = join(home, "tools", "node-echo", "1", "..source");
  cpSync(fixture("node-echo"), source, { recursive: true });
  const files = ["gu.yaml", "echo.js", "package.json"];
  const before = files.map(file => readFileSync(join(source, file), "utf8"));
  const result = await installTool(source);
  expect(result).toMatchObject({ ok: false, stage: "deps", message: expect.stringContaining("must not contain one another") });
  for (const [index, file] of files.entries()) expect(readFileSync(join(source, file), "utf8")).toBe(before[index]);
});

test("C1 refuses destination symlinks without deleting outside files", async () => {
  const source = probeSource();
  const outside = join(home, "outside");
  mkdirSync(join(outside, "1"), { recursive: true });
  writeFileSync(join(outside, "1", "sentinel"), "safe");
  mkdirSync(join(home, "tools"));
  symlinkSync(outside, join(home, "tools", "probe"));
  const result = await installTool(source);
  expect(result.ok).toBe(false);
  expect(readFileSync(join(outside, "1", "sentinel"), "utf8")).toBe("safe");
});
test("C1 preserves internal relative links without modifying the source", async () => {
  const source = probeSource();
  writeFileSync(join(source, "original"), "safe");
  symlinkSync("original", join(source, "link"));
  writeFileSync(join(source, "probe.js"), 'require("fs").writeFileSync("link", "installed");');
  const result = await installTool(source);
  expect(result.ok).toBe(true);
  expect(readFileSync(join(source, "original"), "utf8")).toBe("safe");
  if (result.ok) expect(readlinkSync(join(result.loaded.dir, "link"))).toBe("original");
});
test("C1 refuses source links escaping the source", async () => {
  const source = probeSource();
  writeFileSync(join(home, "outside"), "safe");
  symlinkSync("../outside", join(source, "link"));
  expect(await installTool(source)).toMatchObject({ ok: false, message: expect.stringContaining("symbolic link") });
});
function probeSource() {
  const source = join(home, "probe-source"); mkdirSync(source);
  writeFileSync(join(source, "gu.yaml"), `name: probe\nversion: 1\ndescription: Probe\nuse_when: Testing\nplatforms: [macos, linux]\ntools:\n  - name: probe\n    run: node probe.js\ntest:\n  run: node probe.js\n  expect: {exit_code: 0}\n`);
  writeFileSync(join(source, "probe.js"), "");
  return source;
}

test("I7 ordinary fixtures never provision dependency environments", () => {
  for (const name of ["py-echo", "py-stale", "py-broken", "node-echo"]) expect(manifest(name).install).toBeUndefined();
});
test("I7 dependency failures include elapsed time and npm uses quiet offline preferences", async () => {
  const source = probeSource();
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8") + '\ninstall: {npm: package.json}\n');
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nconsole.error(JSON.stringify(process.argv.slice(2)) + " notifier=" + process.env.npm_config_update_notifier); process.exit(7);`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin;
  try {
    const result = await installTool(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/after [\d.]+ seconds/);
    if (!result.ok) for (const expected of ["--prefer-offline", "--no-audit", "--no-fund", "notifier=false"]) expect(result.message).toContain(expected);
  } finally { process.env.PATH = oldPath; }
});

test("I7 dependency deadline bounds a hanging setup", async () => {
  const source = probeSource();
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8") + '\ninstall: {npm: package.json}\n');
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nsetTimeout(() => {}, 60_000);`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin;
  try {
    const start = performance.now();
    const result = await installTool(source, { dependencyTimeoutSec: 0.1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("exceeded its time limit after");
    expect(performance.now() - start).toBeLessThan(2000);
  } finally { process.env.PATH = oldPath; }
});

for (const exitCode of [0, 7]) test(`I2 unverified replacement stays hidden and preserves old install (exit ${exitCode})`, async () => {
  const { discoverInstalled } = await import("../src/manifest/discover");
  const source = probeSource();
  const dest = join(home, "tools", "probe", "1"); cpSync(source, dest, { recursive: true });
  writeFileSync(join(dest, "old"), "verified");
  writeFileSync(join(dest, INSTALLED_MARKER), "verified");
  writeFileSync(join(source, INSTALLED_MARKER), "source marker must not publish a half-install");
  const started = join(home, "started"), release = join(home, "release");
  writeFileSync(join(source, "probe.js"), `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(started)}, process.cwd()); const t = setInterval(() => { if(fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); process.exit(${exitCode}); } }, 10); setTimeout(() => process.exit(9), 2000);`);
  const pending = installTool(source);
  try {
    for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    const visible = discoverInstalled(home);
    expect(visible.problems).toEqual([]);
    expect(visible.tools).toEqual([]);
    expect(existsSync(join(dest, INSTALLED_MARKER))).toBe(false);
    expect(readFileSync(started, "utf8")).toBe(realpathSync(dest));
  } finally { writeFileSync(release, "go"); await pending; }
  const result = await pending;
  expect(result.ok).toBe(exitCode === 0);
  expect(existsSync(join(dest, INSTALLED_MARKER))).toBe(true);
  if (exitCode !== 0) expect(readFileSync(join(dest, "old"), "utf8")).toBe("verified");
  expect(existsSync(join(dest, "old"))).toBe(exitCode !== 0);
  expect(readdirSync(join(home, "tools", "probe"))).toEqual(["1"]);
});

for (const found of ["18.4.0", "24.0.0", undefined]) test(`I5 checks declared Node major before installing (${found ?? "missing"})`, async () => {
  const source = probeSource();
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8") + '\ninstall: {node: "999"}\n');
  const bin = join(home, "bin"); mkdirSync(bin);
  if (found) writeFileSync(join(bin, "node"), `#!${process.execPath}\nconsole.log("v${found}");`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin;
  try {
    const r = await installTool(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("platform");
      expect(r.message).toContain("needs Node 999 or newer; this computer has");
      expect(r.message).toContain(found ?? "no Node");
      expect(r.message).toContain(process.platform === "darwin" ? "brew install node@999" : "nodejs.org");
    }
    expect(existsSync(join(home, "tools"))).toBe(false);
  } finally { process.env.PATH = oldPath; }
});
test("I5 accepts a newer Node major without provisioning it", async () => {
  const source = probeSource();
  writeFileSync(join(source, "gu.yaml"), readFileSync(join(source, "gu.yaml"), "utf8") + '\ninstall: {node: "1"}\n');
  expect((await installTool(source)).ok).toBe(true);
});

test("I2 Python console script works after install and through MCP", async () => {
  const r = await installTool(fixture("py-cli"), { dependencyTimeoutSec: 20 });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.message);
  expect(r.smoke.passed).toBe(true);
  expect((await runSmokeTest(r.loaded)).passed).toBe(true);
  expect(r.loaded.dir).toBe(join(home, "tools", "py-cli", "1"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "console-script-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("src/cli.ts"), "serve"], env: { ...process.env, GU_HOME: home } as Record<string, string>, stderr: "pipe" }));
    const called = await client.callTool({ name: "py-cli__echo", arguments: { text: "console-script-argument" } });
    expect(called.isError).toBeFalsy();
    expect(called.content).toEqual([{ type: "text", text: "console-script-argument\n\n[exit code 0]" }]);
  } finally { await client.close(); }
}, 40_000);

test("I2 failing to remove the old copy keeps the new verified install", async () => {
  const source = probeSource();
  const dest = join(home, "tools", "probe", "1"); cpSync(source, dest, { recursive: true });
  writeFileSync(join(dest, INSTALLED_MARKER), "verified");
  const locked = join(dest, "locked"); mkdirSync(locked); writeFileSync(join(locked, "file"), "old");
  chmodSync(locked, 0o555);
  const logs: string[] = [];
  try {
    const result = await installTool(source, { log: line => logs.push(line) });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, INSTALLED_MARKER))).toBe(true);
    expect(existsSync(join(dest, "locked"))).toBe(false);
    expect(logs.some(line => line.includes("could not remove the old copy"))).toBe(true);
    // A logger that throws must not undo the verified install either.
    writeFileSync(join(dest, "locked-again"), ""); mkdirSync(join(dest, "locked")); writeFileSync(join(dest, "locked", "file"), "old"); chmodSync(join(dest, "locked"), 0o555);
    const again = await installTool(source, { log: line => { if (line.includes("old copy")) throw new Error("logger broke"); } });
    expect(again.ok).toBe(true);
    expect(existsSync(join(dest, INSTALLED_MARKER))).toBe(true);
    expect(existsSync(join(dest, "locked-again"))).toBe(false);
  } finally {
    for (const name of readdirSync(join(home, "tools", "probe"))) {
      const leftover = join(home, "tools", "probe", name, "locked");
      if (existsSync(leftover)) chmodSync(leftover, 0o755);
    }
  }
});
