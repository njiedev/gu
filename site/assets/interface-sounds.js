// Dry, short metallic cues, synthesized locally with Web Audio.
let context;
let lastHover = -Infinity;
let enabled = true;
try { enabled = localStorage.getItem('chakram-sound') !== 'off'; } catch {}
const toggle = document.querySelector('[data-sound-toggle]');
function updateToggle() {
  if (!toggle) return;
  toggle.textContent = enabled ? 'sound on' : 'sound off';
  toggle.setAttribute('aria-pressed', String(enabled));
}
updateToggle();
function synth(kind) {
  const t = context.currentTime;
  const click = kind === 'click';
  const bus = context.createGain();
  bus.gain.value = 0.18;
  bus.connect(context.destination);
  // Inharmonic partials suggest a small steel mechanism, with no reverb tail.
  for (const [frequency, level, decay] of click
    ? [[1700, .16, .045], [4170, .065, .065], [690, .12, .025]]
    : [[3200, .08, .026], [5210, .025, .035]]) {
    const osc = context.createOscillator(), envelope = context.createGain();
    osc.frequency.setValueAtTime(frequency, t);
    osc.frequency.exponentialRampToValueAtTime(frequency * .93, t + decay);
    envelope.gain.setValueAtTime(.0001, t);
    envelope.gain.exponentialRampToValueAtTime(level, t + .0015);
    envelope.gain.exponentialRampToValueAtTime(.0001, t + decay);
    osc.connect(envelope).connect(bus);
    osc.start(t); osc.stop(t + decay + .01);
    osc.onended = () => { osc.disconnect(); envelope.disconnect(); };
  }
  setTimeout(() => bus.disconnect(), 150);
}
async function play(kind) {
  if (!enabled || !navigator.userActivation?.hasBeenActive) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    context ??= new Audio();
    if (context.state !== 'running') await context.resume();
    if (context.state === 'running' && enabled) synth(kind);
  } catch { /* Sound must never interfere with navigation. */ }
}
toggle?.addEventListener('click', () => {
  enabled = !enabled;
  try { localStorage.setItem('chakram-sound', enabled ? 'on' : 'off'); } catch {}
  updateToggle();
  if (enabled) play('click');
});
for (const target of document.querySelectorAll('a, button:not([data-sound-toggle])')) {
  target.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse' || performance.now() - lastHover < 120) return;
    lastHover = performance.now();
    play('hover');
  });
  // Pointer-down lets the transient start before a link navigates away.
  target.addEventListener('pointerdown', event => { if (event.button === 0) play('click'); });
  target.addEventListener('click', event => { if (event.detail === 0) play('click'); });
}
