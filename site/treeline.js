// a thin strip of the forest: stars, a low mist bank, and a dithered treeline.
// same pixel language as /forest (five greys, ordered dither, 2px pixels),
// but sized to its own element so it can sit above or below the docs.

const PALETTE = [[9, 9, 10], [52, 52, 56], [112, 112, 117], [178, 178, 182], [236, 236, 238]];
const LEVELS = PALETTE.length - 1;
const BAYER = (() => {
  const m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return m.flat().map((v) => (v + 0.5) / 64);
})();

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 362437) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Draw a treeline into a canvas, sized to the canvas's own box.
 * @param {HTMLCanvasElement} canvas
 * @param {{ seed?: number, stars?: boolean, mist?: number, height?: number, fadeBottom?: boolean }} opts
 *   height: how tall the tallest trees are, as a fraction of the strip.
 */
export function drawTreeline(canvas, { seed = 3, stars = true, mist = 0.3, height = 0.75, fadeBottom = false } = {}) {
  const ctx = canvas.getContext("2d");
  const px = 2;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let background, twinkles = [], raf = 0, lastFrame = 0;

  function render() {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.ceil(rect.width / px)), H = Math.max(1, Math.ceil(rect.height / px));
    canvas.width = W;
    canvas.height = H;
    const r = mulberry32(seed);
    const tone = new Float32Array(W * H);

    if (stars) {
      for (let i = 0; i < W * H * 0.0012; i++) {
        const x = Math.floor(r() * W), y = Math.floor(r() * H * 0.55);
        tone[y * W + x] = 0.45 + r() * 0.55;
      }
    }

    // mist: a soft bank along the bottom, lumpy on top
    if (mist > 0) {
      for (let x = 0; x < W; x++) {
        const top = H * (0.55 + 0.18 * noise2(x * 0.03, 0, seed + 4));
        for (let y = Math.floor(top); y < H; y++) {
          const k = smoothstep(top, top + H * 0.12, y);
          tone[y * W + x] = Math.max(tone[y * W + x], mist * k * (0.7 + 0.5 * noise2(x * 0.08, y * 0.08, seed + 5)));
        }
      }
    }

    // conifers: rows of ragged branch tips in tiers, near black, snow clumped on the tier tops
    const tree = (cx, h, w, base, snowAmt) => {
      const top = H - h, tiers = Math.max(4, Math.round(h / 9));
      const sL = Math.floor(r() * 1e6), sR = sL + 7;
      for (let y = Math.max(0, Math.floor(top)); y < H; y++) {
        const t = (y - top) / h, tp = t * tiers, phase = tp - Math.floor(tp);
        const env = (w / 2) * (0.05 + 0.95 * Math.pow(t, 0.92));
        const shape = 0.32 + 0.68 * Math.pow(phase, 0.55);
        const tipL = (noise2(y * 0.28, 0, sL) - 0.4) * 0.8 + (hash2(Math.floor(y / 3), 0, sL) - 0.5) * 0.35;
        const tipR = (noise2(y * 0.28, 0, sR) - 0.4) * 0.8 + (hash2(Math.floor(y / 3), 0, sR) - 0.5) * 0.35;
        const hwL = env * (shape + tipL * (0.4 + 0.6 * phase)), hwR = env * (shape + tipR * (0.4 + 0.6 * phase));
        for (let x = Math.max(0, Math.floor(cx - hwL)); x <= Math.min(W - 1, Math.ceil(cx + hwR)); x++) {
          const dx = x - cx, rel = Math.abs(dx) / Math.max(1, dx < 0 ? hwL : hwR);
          const upper = 1 - smoothstep(0.25, 0.7, phase - 0.25 * rel);
          let snow = upper * smoothstep(0.12, 0.5, rel) * smoothstep(0.5, 0.72, noise2(x * 0.16, y * 0.2, 3) * 0.7 + noise2(x * 0.5, y * 0.5, 13) * 0.3);
          snow *= dx < 0 ? 1 : 0.6;
          tone[y * W + x] = base + snowAmt * snow;
        }
      }
    };
    const S = H / 90;
    for (let x = -10; x < W + 10; x += (8 + r() * 10) * S) tree(x, H * height * (0.35 + r() * 0.25), H * height * 0.2, 0.22, 0.25);
    for (let x = -10; x < W + 10; x += (16 + r() * 22) * S) tree(x, H * height * (0.55 + r() * 0.45), H * height * 0.34, 0.02, 0.85);

    const img = ctx.createImageData(W, H), d = img.data;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        // Fade before quantization so the transition keeps the same crisp pixel palette.
        const fade = fadeBottom ? 1 - smoothstep(H * 0.65, H - 1, y) : 1;
        const s = clamp(tone[i] * fade) * LEVELS, lo = Math.floor(s);
        const c = PALETTE[Math.min(LEVELS, lo + (s - lo > BAYER[(y & 7) * 8 + (x & 7)] ? 1 : 0))], o = i * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    background = img;
    // A separate seed keeps the original forest and static stars in place.
    const sparkleRandom = mulberry32(seed + 100);
    twinkles = stars ? Array.from({ length: Math.max(3, Math.round(W / 90)) }, () => ({
      x: 4 + Math.floor(sparkleRandom() * Math.max(1, W - 8)),
      y: 4 + Math.floor(sparkleRandom() * Math.max(1, H * 0.4 - 8)),
      phase: sparkleRandom() * Math.PI * 2,
      speed: 0.7 + sparkleRandom() * 0.8,
    })) : [];
  }

  function animate(now) {
    raf = requestAnimationFrame(animate);
    if (now - lastFrame < 80 || document.hidden || canvas.getBoundingClientRect().bottom < 0) return;
    lastFrame = now;
    ctx.putImageData(background, 0, 0);
    for (const star of twinkles) {
      const pulse = (1 + Math.sin(now / 1000 * star.speed + star.phase)) / 2;
      const arm = Math.floor(pulse ** 3 * 3);
      const shade = PALETTE[1 + Math.round(pulse * (LEVELS - 1))];
      ctx.fillStyle = `rgb(${shade.join(",")})`;
      ctx.fillRect(star.x - arm, star.y, arm * 2 + 1, 1);
      ctx.fillRect(star.x, star.y - arm, 1, arm * 2 + 1);
    }
  }
  function updateMotion() {
    cancelAnimationFrame(raf);
    if (background) ctx.putImageData(background, 0, 0);
    if (stars && !reducedMotion.matches) raf = requestAnimationFrame(animate);
  }
  reducedMotion.addEventListener("change", updateMotion);
  let timer = 0;
  new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(render, 120); }).observe(canvas);
  render();
  updateMotion();
}
