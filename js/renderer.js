// Turns live camera frames into film/video frames on one 2D canvas.
// WebGL does the grade and texture; the camcorder overlay is drawn on top in 2D.
// That single canvas is what the viewfinder shows, what toBlob() photographs and
// what captureStream() records, so preview and saved media always match.

import { Overlay } from './overlay.js';

const OVERSCAN = 1.015; // slight zoom so gate weave and tracking never show the frame edge

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec4 uCrop;        // crop origin (xy) and size (zw) in texture coordinates
uniform vec2 uSrcPx;       // one source pixel, in crop coordinates
uniform float uMirror;
uniform vec2 uRes;         // output size in pixels
uniform vec2 uJitter;
uniform float uZoom;
uniform float uSeed;
uniform float uTime;
uniform float uFlicker;
uniform vec4 uLeak;        // centre xy, radius, strength
uniform vec3 uLeakColor;
uniform vec4 uScratch;     // x1, alpha1, x2, alpha2
uniform vec4 uDust[4];     // xy, radius px, alpha

uniform vec3 uWB;
uniform float uSat;
uniform float uContrast;
uniform float uKnee;
uniform float uShoulder;
uniform vec3 uBlack;
uniform vec3 uWhite;
uniform float uSoftR;
uniform float uSoftMix;
uniform float uHalation;
uniform float uHalationR;
uniform float uGrain;
uniform float uGrainClump;
uniform float uGrainSize;
uniform float uChromaNoise;
uniform float uChromaShift;
uniform float uChromaBleed;
uniform float uVignette;
uniform float uCorner;
uniform float uTracking;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// q: position inside the cropped frame, 0..1, y pointing down.
vec3 src(vec2 q) {
  q = clamp(q, 0.0, 1.0);
  if (uMirror > 0.5) q.x = 1.0 - q.x;
  return texture2D(uTex, uCrop.xy + q * uCrop.zw).rgb;
}

vec3 scratch(vec3 c, vec2 p, float sx, float sa) {
  if (sa <= 0.0) return c;
  float x = sx + 0.0015 * sin(p.y * 9.0 + sx * 40.0);
  float d = (p.x - x) * uRes.x / 1.3;
  float broken = smoothstep(0.25, 0.6, vnoise(vec2(p.y * 18.0, sx * 97.0)));
  return mix(c, vec3(0.92, 0.91, 0.88), sa * exp(-d * d) * broken);
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec2 q = (p - 0.5) / uZoom + 0.5 + uJitter;
  vec2 px = p * uRes;

  // Tape tracking: rows wobble sideways, a soft band rolls down the frame, and the
  // bottom few rows tear (head switching).
  float band = 0.0;
  if (uTracking > 0.0) {
    float bandPos = fract(uTime * 0.045) * 1.3 - 0.15;
    band = exp(-pow((p.y - bandPos) * 22.0, 2.0));
    float wob = vnoise(vec2(p.y * 90.0, uTime * 6.0)) - 0.5;
    float tear = vnoise(vec2(p.y * 260.0, uTime * 40.0)) - 0.5;
    float hs = smoothstep(0.955, 1.0, p.y);
    q.x += uTracking * (0.003 * wob + 0.02 * band * tear + 0.05 * hs * (tear + 0.3));
  }

  // Optics: soft lens.
  vec3 c = src(q);
  if (uSoftMix > 0.0) {
    vec2 s = uSrcPx * uSoftR;
    vec3 blur = (src(q + vec2(s.x, s.y)) + src(q + vec2(-s.x, s.y)) + src(q + vec2(s.x, -s.y)) + src(q + vec2(-s.x, -s.y))) * 0.25;
    c = mix(c, blur, uSoftMix * 0.7);
  }

  // Video chroma: colour carried at lower resolution and slightly misregistered.
  if (uChromaBleed > 0.0 || uChromaShift > 0.0) {
    vec2 cs = vec2(uSrcPx.x * uChromaShift, 0.0);
    vec2 cb = vec2(uSrcPx.x * uChromaBleed, 0.0);
    vec3 ch = (src(q + cs - cb) + src(q + cs) * 2.0 + src(q + cs + cb)) * 0.25;
    c = dot(c, LUMA) + (ch - dot(ch, LUMA));
  }

  // Highlight halation (subtle glow around bright areas).
  if (uHalation > 0.0) {
    vec2 h = uSrcPx * uHalationR;
    vec3 g = src(q + vec2(h.x, 0.0)) + src(q - vec2(h.x, 0.0)) + src(q + vec2(0.0, h.y)) + src(q - vec2(0.0, h.y));
    float glow = max(dot(g * 0.25, LUMA) - 0.7, 0.0) / 0.3;
    c += vec3(1.0, 0.82, 0.7) * glow * uHalation;
  }

  // Grade: tiny white-balance shift, soft highlight roll-off, saturation, gentle
  // contrast, then a mild fade. No colour overlay.
  c *= uWB * (1.0 + uFlicker);
  c = max(c, 0.0);
  vec3 t = max(c - uKnee, 0.0) / (1.0 - uKnee);
  c = mix(c, uKnee + (1.0 - uKnee) * t / (1.0 + uShoulder * t), step(uKnee, c));
  c = clamp(c, 0.0, 1.0);
  float y = dot(c, LUMA);
  c = mix(vec3(y), c, uSat);
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  c = mix(uBlack, uWhite, c);

  // Noise: fine video noise or clumpy film grain, strongest in the midtones.
  vec2 o = vec2(uSeed * 137.0, uSeed * 241.0);
  float n = mix(hash12(px + o * 3.1), vnoise(px / uGrainSize + o), uGrainClump) - 0.5;
  float lum = dot(c, LUMA);
  float w = max(1.0 - 0.7 * pow(abs(lum - 0.45) * 1.8, 2.0), 0.3);
  vec2 cn = vec2(hash12(px * 1.37 + o), hash12(px * 0.73 + o * 1.9)) - 0.5;
  c += n * uGrain * w + vec3(cn.x, -0.5 * (cn.x + cn.y), cn.y) * uGrain * uChromaNoise;

  // Tracking band: faint bright streaks where the tape loses lock.
  if (uTracking > 0.0) {
    float streak = step(0.985, hash12(vec2(floor(px.y / 2.0), floor(px.x / 60.0) + uSeed * 91.0)));
    c += uTracking * band * (0.08 + streak * 0.5);
  }

  // Vignette.
  float r = length((p - 0.5) * 1.8);
  c *= 1.0 - uVignette * smoothstep(0.4, 1.45, r);

  // Light leak, screen-blended from the edge of the frame.
  if (uLeak.w > 0.0) {
    vec2 ld = (p - uLeak.xy) * vec2(uRes.x / uRes.y, 1.0);
    float lk = uLeak.w * exp(-dot(ld, ld) / (uLeak.z * uLeak.z));
    c = 1.0 - (1.0 - c) * (1.0 - clamp(uLeakColor * lk, 0.0, 1.0));
  }

  // Scratches and dust.
  c = scratch(c, p, uScratch.x, uScratch.y);
  c = scratch(c, p, uScratch.z, uScratch.w);
  for (int i = 0; i < 4; i++) {
    vec4 d = uDust[i];
    if (d.w > 0.0) {
      vec2 dp = (p - d.xy) * uRes;
      float shape = length(dp * vec2(1.0, 0.6 + 0.4 * hash12(d.xy * 99.0)));
      c *= 1.0 - d.w * (1.0 - smoothstep(d.z * 0.35, d.z, shape));
    }
  }

  // Rounded corners of a film gate (Super 8 only).
  if (uCorner > 0.0) {
    float rad = uCorner * min(uRes.x, uRes.y);
    float soft = max(rad * 0.25, 1.0);
    vec2 e = abs(p - 0.5) * uRes - (uRes * 0.5 + soft - rad);
    float sdf = length(max(e, 0.0)) - rad;
    c *= 1.0 - 0.92 * smoothstep(-soft, 0.0, sdf);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const LEAK_COLORS = [[1.0, 0.55, 0.3], [1.0, 0.4, 0.25], [1.0, 0.75, 0.45]];
const rand = (a, b) => a + Math.random() * (b - a);

// Per-frame film motion: gate weave, flicker, light leaks, scratches, dust.
// Reuses its output arrays so nothing is allocated per frame.
class FilmMotion {
  constructor() {
    this.phase = [0, 0, 0, 0].map(() => Math.random() * Math.PI * 2);
    this.leak = null;
    this.scratches = [null, null];
    this.last = 0;
    this.out = {
      jitter: [0, 0], flicker: 0, leak: [0, 0, 1, 0], leakColor: LEAK_COLORS[0],
      scratch: [0, 0, 0, 0], dust: new Float32Array(16), seed: 0,
    };
  }

  step(now, u, W, H) {
    const f = this.out;
    const t = now / 1000;
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), 0.25);
    this.last = now;
    const p = this.phase;
    const wv = u.weave;

    f.jitter[0] = (Math.sin(t * 1.3 + p[0]) * 0.6 + Math.sin(t * 3.7 + p[1]) * 0.4) * 0.0009 * wv + (Math.random() - 0.5) * 0.0005 * wv;
    f.jitter[1] = (Math.sin(t * 0.9 + p[2]) * 0.6 + Math.sin(t * 2.9 + p[3]) * 0.4) * 0.0014 * wv + (Math.random() - 0.5) * 0.0007 * wv;
    if (wv && Math.random() < 0.004 * wv) f.jitter[1] += 0.004 * wv; // the odd registration hop
    f.flicker = (Math.random() - 0.5) * u.flicker + Math.sin(t * 7.1) * u.flicker * 0.25;

    if (!this.leak && Math.random() < u.leakRate * dt) {
      const side = Math.random();
      this.leak = {
        start: t,
        dur: rand(1.5, 4),
        x: side < 0.45 ? -0.15 : side < 0.9 ? 1.15 : rand(0.2, 0.8),
        y: side < 0.9 ? rand(0.1, 0.9) : -0.15,
        r: rand(0.45, 0.8),
        peak: rand(0.15, 0.35),
        color: LEAK_COLORS[Math.floor(Math.random() * LEAK_COLORS.length)],
      };
    }
    f.leak[3] = 0;
    if (this.leak) {
      const k = (t - this.leak.start) / this.leak.dur;
      if (k < 0 || k >= 1 || !u.leakRate) {
        this.leak = null;
      } else {
        f.leak[0] = this.leak.x;
        f.leak[1] = this.leak.y + Math.sin(t * 0.7) * 0.05;
        f.leak[2] = this.leak.r;
        f.leak[3] = this.leak.peak * Math.sin(Math.PI * k) ** 1.5;
        f.leakColor = this.leak.color;
      }
    }

    for (let i = 0; i < 2; i++) {
      let s = this.scratches[i];
      if (s && (--s.life <= 0 || !u.scratchRate)) s = this.scratches[i] = null;
      if (!s && Math.random() < (u.scratchRate * dt) / 2) {
        const long = Math.random() < 0.3;
        s = this.scratches[i] = {
          x: rand(0.08, 0.92),
          a: rand(0.08, 0.25),
          life: long ? Math.round(rand(24, 96)) : Math.round(rand(2, 8)),
          drift: (Math.random() - 0.5) * 0.0006,
        };
      }
      if (s) s.x += s.drift + (Math.random() - 0.5) * 0.0006;
      f.scratch[i * 2] = s ? s.x : 0;
      f.scratch[i * 2 + 1] = s ? s.a : 0;
    }

    // Dust shows for a single frame, the way it does on a projector.
    f.dust.fill(0);
    const scale = Math.min(W, H) / 1080;
    for (let i = 0; i < 4; i++) {
      if (Math.random() < (u.dustRate * dt) / 4) {
        f.dust[i * 4] = Math.random();
        f.dust[i * 4 + 1] = Math.random();
        f.dust[i * 4 + 2] = rand(1.2, 4) * scale + 0.8;
        f.dust[i * 4 + 3] = rand(0.25, 0.55);
      }
    }

    f.seed = Math.random();
    return f;
  }
}

export class FilmRenderer {
  constructor(canvas, { prefer = 'webgl' } = {}) {
    this.out = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.overlay = new Overlay();
    this.motion = new FilmMotion();
    this.u = null;          // look uniforms from looks.js
    this.aspect = '4:3';
    this.maxLong = 1920;
    this.locked = false;    // keep the output size fixed (while recording)
    this.srcW = 0;
    this.srcH = 0;
    this.W = canvas.width;
    this.H = canvas.height;
    this.mode = '2d';
    this.lite = false;      // drop halation and softness taps when frames run slow
    this.lastStamp = null;
    this.lastRenderMs = 0;
    this.avgRenderMs = 0;
    this.onResize = null;
    this.onModeChange = null;
    if (prefer !== '2d') this.initGL();
  }

  setLook(uniforms) {
    this.u = uniforms;
  }

  setFormat({ aspect = this.aspect, maxLong = this.maxLong } = {}) {
    if (aspect === this.aspect && maxLong === this.maxLong) return;
    this.aspect = aspect;
    this.maxLong = maxLong;
    if (!this.locked) this.srcW = 0; // re-crop on the next frame
  }

  lock(on) {
    this.locked = on;
    if (!on) this.srcW = 0;
  }

  initGL() {
    if (!this.glCanvas) {
      this.glCanvas = document.createElement('canvas');
      this.glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault(); // allows the browser to restore it later
        this.gl = null;
        this.setMode('2d', 'context lost');
      });
      this.glCanvas.addEventListener('webglcontextrestored', () => this.initGL());
    }
    const gl = this.glCanvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
    });
    if (!gl) return false;
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      this.loc = {};
      const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
        this.loc[name] = gl.getUniformLocation(prog, name);
      }
    } catch (err) {
      console.warn('WebGL film renderer unavailable, using 2D fallback:', err);
      return false;
    }
    this.gl = gl;
    this.srcW = 0; // force a resize on the next frame
    this.setMode('webgl');
    return true;
  }

  setMode(mode, reason) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange?.(mode, reason);
  }

  // Crops the camera frame to the chosen aspect (4:3 or 16:9, turned upright in
  // portrait) without stretching. While locked, the output size stays fixed and a
  // rotated camera frame is cropped to fit it, because recorders break on resize.
  configure(srcW, srcH) {
    let ar;
    if (this.locked && this.W && this.H) {
      ar = this.W / this.H;
    } else {
      const base = this.aspect === '16:9' ? 16 / 9 : 4 / 3;
      ar = srcH > srcW ? 1 / base : base;
    }
    let cw = srcW;
    let ch = srcH;
    if (srcW / srcH > ar) cw = Math.round(srcH * ar);
    else ch = Math.round(srcW / ar);

    this.srcW = srcW;
    this.srcH = srcH;
    this.crop = { sx: (srcW - cw) / 2, sy: (srcH - ch) / 2, sw: cw, sh: ch };
    if (this.locked && this.W && this.H) return;

    const scale = Math.min(1, this.maxLong / Math.max(cw, ch));
    const W = Math.round((cw * scale) / 2) * 2;
    const H = Math.round((ch * scale) / 2) * 2;
    this.W = this.out.width = W;
    this.H = this.out.height = H;
    if (this.gl) {
      this.glCanvas.width = W;
      this.glCanvas.height = H;
      this.gl.viewport(0, 0, W, H);
    }
    this.onResize?.(W, H);
  }

  // raw: draw the plain camera image (for the before/after compare), no overlay.
  render(video, { mirror = false, date = null, stamp = {}, rec = false, raw = false, now = performance.now() } = {}) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2 || !this.u) return false;
    const t0 = performance.now();
    if (vw !== this.srcW || vh !== this.srcH) this.configure(vw, vh);

    if (raw) {
      this.drawRaw(video, mirror);
      this.lastStamp = null;
    } else {
      const f = this.motion.step(now, this.u, this.W, this.H);
      if (this.gl && !this.gl.isContextLost()) this.drawGL(video, mirror, f, now);
      else this.draw2D(video, mirror, f);
      this.overlay.draw(this.ctx, this.W, this.H, { date, settings: stamp, rec });
      this.lastStamp = this.overlay.lastLines;
    }

    this.lastRenderMs = performance.now() - t0;
    this.avgRenderMs = this.avgRenderMs ? this.avgRenderMs * 0.95 + this.lastRenderMs * 0.05 : this.lastRenderMs;
    return true;
  }

  drawRaw(video, mirror) {
    const { ctx, W, H, crop: c } = this;
    ctx.save();
    ctx.translate(mirror ? W : 0, 0);
    ctx.scale(mirror ? -1 : 1, 1);
    ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, 0, 0, W, H);
    ctx.restore();
  }

  drawGL(video, mirror, f, now) {
    const { gl, loc: l, u, crop: c, srcW, srcH } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.uniform1i(l.uTex, 0);
    gl.uniform4f(l.uCrop, c.sx / srcW, c.sy / srcH, c.sw / srcW, c.sh / srcH);
    gl.uniform2f(l.uSrcPx, 1 / c.sw, 1 / c.sh);
    gl.uniform1f(l.uMirror, mirror ? 1 : 0);
    gl.uniform2f(l.uRes, this.W, this.H);
    gl.uniform2f(l.uJitter, f.jitter[0], f.jitter[1]);
    gl.uniform1f(l.uZoom, OVERSCAN);
    gl.uniform1f(l.uSeed, f.seed);
    gl.uniform1f(l.uTime, (now / 1000) % 1000);
    gl.uniform1f(l.uFlicker, f.flicker);
    gl.uniform4fv(l.uLeak, f.leak);
    gl.uniform3fv(l.uLeakColor, f.leakColor);
    gl.uniform4fv(l.uScratch, f.scratch);
    gl.uniform4fv(l.uDust, f.dust);

    gl.uniform3fv(l.uWB, u.wb);
    gl.uniform1f(l.uSat, u.saturation);
    gl.uniform1f(l.uContrast, u.contrast);
    gl.uniform1f(l.uKnee, u.knee);
    gl.uniform1f(l.uShoulder, u.shoulder);
    gl.uniform3fv(l.uBlack, u.black);
    gl.uniform3fv(l.uWhite, u.white);
    gl.uniform1f(l.uSoftR, u.softRadius);
    gl.uniform1f(l.uSoftMix, this.lite ? 0 : u.softMix);
    gl.uniform1f(l.uHalation, this.lite ? 0 : u.halation);
    gl.uniform1f(l.uHalationR, u.halationRadius);
    gl.uniform1f(l.uGrain, u.grain);
    gl.uniform1f(l.uGrainClump, u.grainClump);
    gl.uniform1f(l.uGrainSize, u.grainSize);
    gl.uniform1f(l.uChromaNoise, u.chromaNoise);
    gl.uniform1f(l.uChromaShift, u.chromaShift);
    gl.uniform1f(l.uChromaBleed, u.chromaBleed);
    gl.uniform1f(l.uVignette, u.vignette);
    gl.uniform1f(l.uCorner, u.corner);
    gl.uniform1f(l.uTracking, u.tracking);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.ctx.drawImage(this.glCanvas, 0, 0);
  }

  // Fallback when WebGL is missing or its context was lost: blend modes approximate
  // the grade (neutral: no colour overlay), plus vignette and grain.
  draw2D(video, mirror, f) {
    const { ctx, W, H, crop: c, u } = this;
    ctx.save();
    ctx.translate(W / 2 + f.jitter[0] * W, H / 2 + f.jitter[1] * H);
    ctx.scale((mirror ? -1 : 1) * OVERSCAN, OVERSCAN);
    ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, -W / 2, -H / 2, W, H);
    ctx.restore();

    const rgb = (v) => `rgb(${v.map((x) => Math.round(Math.min(1, x) * 255)).join(',')})`;
    const fill = (op, style, alpha = 1) => {
      ctx.globalCompositeOperation = op;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = style;
      ctx.fillRect(0, 0, W, H);
    };
    ctx.save();
    if (u.saturation < 1) fill('saturation', '#808080', 1 - u.saturation);
    fill('multiply', rgb(u.wb.map((x, i) => x * u.white[i])));
    fill('screen', rgb(u.black));

    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    const v = Math.round(255 * (1 - u.vignette * 0.8));
    vg.addColorStop(0, '#fff');
    vg.addColorStop(1, `rgb(${v},${v},${v})`);
    fill('multiply', vg);

    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(1, u.grain * 5);
    ctx.fillStyle = this.grainPattern();
    ctx.translate(-Math.random() * 128, -Math.random() * 128);
    ctx.fillRect(0, 0, W + 128, H + 128);
    ctx.restore();
  }

  grainPattern() {
    if (!this._grain) {
      const n = document.createElement('canvas');
      n.width = n.height = 128;
      const nctx = n.getContext('2d');
      const img = nctx.createImageData(128, 128);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 140;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      nctx.putImageData(img, 0, 0);
      this._grain = this.ctx.createPattern(n, 'repeat');
    }
    return this._grain;
  }

  toBlob(type = 'image/jpeg', quality = 0.93) {
    return new Promise((resolve) => this.out.toBlob(resolve, type, quality));
  }

  // Test hook: simulate the GPU dropping our context (happens on iOS under memory pressure).
  loseContextForTest() {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}
