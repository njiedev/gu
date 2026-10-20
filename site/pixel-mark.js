// the chakram on a 16px grid: a ring with one slanted notch. it turns slowly
// and is re-rasterised every step, so the notch crawls around pixel by pixel.

const TAU = Math.PI * 2;
const GRID = 16;

function raster(angle) {
  let out = "";
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const dx = x + 0.5 - 8, dy = y + 0.5 - 8, d = Math.hypot(dx, dy);
      if (d < 4.4 || d > 7.6) continue;
      const a = Math.atan2(dy, dx);
      const off = Math.abs(((((a - angle - (d - 6) * 0.06 + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
      if (off < 0.3) continue; // the notch, slanted so it reads as a cut
      out += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return out;
}

export function createPixelMark(svg, { speed = 0.35 } = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  svg.setAttribute("viewBox", `0 0 ${GRID} ${GRID}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  let angle = -Math.PI / 2 + 0.95, extra = 0, last = performance.now(), shown = "";

  function draw() {
    // snap to 1/64 turns so it steps like a sprite instead of smearing
    const step = Math.round((angle / TAU) * 64) / 64 * TAU;
    const key = step.toFixed(4);
    if (key !== shown) {
      svg.innerHTML = raster(step);
      shown = key;
    }
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    extra *= Math.exp(-1.8 * dt);
    angle += (speed + extra) * dt;
    draw();
    requestAnimationFrame(frame);
  }

  draw();
  if (!reduced) requestAnimationFrame(frame);
  return { kick: (a = 14) => !reduced && (extra = Math.min(extra + a, 40)) };
}
