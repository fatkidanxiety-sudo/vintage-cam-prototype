// Small mechanical clicks, synthesised with Web Audio (no sound files).
// The audio session is set to "ambient" so the clicks follow the ring/silent switch
// and don't stop the user's music. Clicks are suppressed while recording so they
// never end up in a video.

let ctx = null;
const buffers = {};

function makeClick(c, { thump = 110, tick = 1, length = 0.05, second = 0 }) {
  const rate = c.sampleRate;
  const buf = c.createBuffer(1, Math.ceil(rate * (length + second)), rate);
  const d = buf.getChannelData(0);
  const hit = (at, gain) => {
    const start = Math.floor(at * rate);
    for (let i = 0; i < rate * length && start + i < d.length; i++) {
      const t = i / rate;
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 900) * tick;
      const body = Math.sin(2 * Math.PI * thump * t) * Math.exp(-t * 70) * 0.6;
      d[start + i] += (noise + body) * gain;
    }
  };
  hit(0, 0.5);
  if (second) hit(second, 0.35);
  return buf;
}

export const sound = {
  enabled: true,
  muted: false, // set while recording

  setSessionAmbient(on) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = on ? 'ambient' : 'auto';
    } catch { /* not supported */ }
  },

  // Must run from a tap: iOS only starts audio after a user gesture.
  unlock() {
    if (ctx || !this.enabled) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      buffers.key = makeClick(ctx, { thump: 180, tick: 0.6, length: 0.035 });
      buffers.shutter = makeClick(ctx, { thump: 95, tick: 1, length: 0.05, second: 0.07 });
      buffers.rec = makeClick(ctx, { thump: 70, tick: 0.8, length: 0.07 });
    } catch {
      ctx = null;
    }
  },

  play(kind = 'key') {
    if (!this.enabled || this.muted || !ctx || !buffers[kind]) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    src.buffer = buffers[kind];
    src.connect(gain).connect(ctx.destination);
    src.start();
  },
};
