// Records site/banner.html into site/assets/readme-banner.gif for the README.
// Needs Playwright with Chromium, and ffmpeg. Run: node scripts/render-banner.mjs
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)("playwright");

const root = resolve(import.meta.dirname, "..", "site");
const out = join(root, "assets", "readme-banner.gif");
const FRAMES = 64; // one full turn of the mark, one pixel step per frame
const FPS = 10;
const types = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };

// ES modules don't load from file://, so serve the site folder locally.
const server = createServer((req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const frames = mkdtempSync(join(tmpdir(), "gu-banner-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${server.address().port}/banner.html`);
  await page.waitForFunction(() => window.bannerReady === true, null, { timeout: 15_000 }).catch(() => console.warn("Fonts did not load; using the fallback font."));
  await page.waitForTimeout(400); // the forest draws once its canvas has a size
  const banner = page.locator("#banner");
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate(([i, n]) => window.setFrame(i, n), [i, FRAMES]);
    await banner.screenshot({ path: join(frames, `${String(i).padStart(3, "0")}.png`) });
  }
} finally {
  await browser.close();
  server.close();
}
// A palette from all frames, and only changed pixels per frame, keep the file small.
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "%03d.png"),
  "-vf", "split[a][b];[a]palettegen=max_colors=32:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  "-loop", "0", out]);
rmSync(frames, { recursive: true, force: true });
console.log(`Wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
