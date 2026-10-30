// Turns live camera frames into film frames on a 2D canvas.
// WebGL does the colour, grain and gate effects; the date stamp is drawn on top in 2D.
// The 2D output canvas is the one thing we show, photograph (toBlob) and, in Phase 2,
// record (captureStream), so what you see is exactly what gets saved.

import { DateStamp } from './stamp.js';

const MAX_LONG_SIDE = 1920;
const OVERSCAN = 1.015; // slight zoom so gate weave never shows the frame edge

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
uniform vec2 uJitter;      // gate weave offset
uniform float uZoom;
uniform float uSeed;
uniform float uFlicker;
uniform vec4 uLeak;        // centre xy, radius, strength
uniform vec3 uLeakColor;
uniform vec4 uScratch;     // x1, alpha1, x2, alpha2
uniform vec4 uDust[4];     // xy, radius px, alpha

uniform float uSat;
uniform float uContrast;
uniform vec3 uGamma;
uniform vec3 uBlack;
uniform vec3 uWhite;
uniform float uSoft;
uniform float uHalation;
uniform vec3 uHalationColor;
uniform float uHalationRadius;
uniform float uGrain;
uniform float uGrainSize;
uniform float uVignette;
uniform float uCorner;

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
  return mix(c, vec3(0.93, 0.9, 0.82), sa * exp(-d * d) * broken);
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec2 q = (p - 0.5) / uZoom + 0.5 + uJitter;

  // Optics: soft lens, then orange halation around highlights.
  vec2 s = uSrcPx * uSoft;
  vec3 c = src(q) * 0.5
    + (src(q + vec2(s.x, s.y)) + src(q + vec2(-s.x, s.y)) + src(q + vec2(s.x, -s.y)) + src(q + vec2(-s.x, -s.y))) * 0.125;
  vec2 h = uSrcPx * uHalationRadius;
  vec3 g = src(q + vec2(h.x, 0.0)) + src(q - vec2(h.x, 0.0)) + src(q + vec2(0.0, h.y)) + src(q - vec2(0.0, h.y))
    + src(q + h * 0.7) + src(q - h * 0.7) + src(q + vec2(h.x, -h.y) * 0.7) + src(q + vec2(-h.x, h.y) * 0.7);
  float glow = max(dot(g * 0.125, LUMA) - 0.62, 0.0) / 0.38;
  c += uHalationColor * glow * uHalation;

  c *= 1.0 + uFlicker;

  // Colour: faded saturation, soft S-curve, warm cast, lifted blacks, creamy whites.
  c = clamp(c, 0.0, 1.0);
  c = mix(vec3(dot(c, LUMA)), c, uSat);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  c = pow(c, uGamma);
  c = mix(uBlack, uWhite, c);

  // Grain: clumpy value noise plus fine noise, strongest in the midtones.
  vec2 px = p * uRes;
  vec2 o = vec2(uSeed * 137.0, uSeed * 241.0);
  float n = vnoise(px / uGrainSize + o) * 0.65 + hash12(px + o * 3.1) * 0.35 - 0.5;
  float lum = dot(c, LUMA);
  float w = max(1.0 - 0.7 * pow(abs(lum - 0.45) * 1.8, 2.0), 0.25);
  float tint = hash12(px * 1.37 + o) - 0.5;
  c += n * uGrain * w + vec3(tint, -tint, tint * 0.5) * uGrain * 0.18;

  // Vignette.
  float r = length((p - 0.5) * 1.8);
  c *= 1.0 - uVignette * smoothstep(0.45, 1.45, r);

  // Light leak, screen-blended in from the edge of the frame.
  vec2 ld = (p - uLeak.xy) * vec2(uRes.x / uRes.y, 1.0);
  float lk = uLeak.w * exp(-dot(ld, ld) / (uLeak.z * uLeak.z));
  c = 1.0 - (1.0 - c) * (1.0 - clamp(uLeakColor * lk, 0.0, 1.0));

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

  // Rounded corners of the projector gate.
  if (uCorner > 0.0) {
    float rad = uCorner * min(uRes.x, uRes.y);
    float soft = max(rad * 0.25, 1.0);
    vec2 e = abs(p - 0.5) * uRes - (uRes * 0.5 + soft - rad);
    float sdf = length(max(e, 0.0)) - rad;
    c *= 1.0 - 0.92 * smoothstep(-soft, 0.0, sdf);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const LEAK_COLORS = [[1.0, 0.45, 0.15], [1.0, 0.28, 0.12], [1.0, 0.72, 0.3]];
const rand = (a, b) => a + Math.random() * (b - a);

// Per-frame film motion: gate weave, flicker, light leaks, scratches, dust.
class FilmMotion {
  constructor() {
    this.phase = [0, 0, 0, 0].map(() => Math.random() * Math.PI * 2);
    this.leak = null;
    this.scratches = [null, null];
    this.last = 0;
  }

  step(now, look, W, H) {
    const t = now / 1000;
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), 0.25);
    this.last = now;
    const p = this.phase;
    const wv = look.weave;

    let jx = (Math.sin(t * 1.3 + p[0]) * 0.6 + Math.sin(t * 3.7 + p[1]) * 0.4) * 0.0009 * wv + (Math.random() - 0.5) * 0.0005 * wv;
    let jy = (Math.sin(t * 0.9 + p[2]) * 0.6 + Math.sin(t * 2.9 + p[3]) * 0.4) * 0.0014 * wv + (Math.random() - 0.5) * 0.0007 * wv;
    if (Math.random() < 0.004 * wv) jy += 0.004 * wv; // the odd registration hop

    const flicker = (Math.random() - 0.5) * look.flicker + Math.sin(t * 7.1) * look.flicker * 0.25;

    if (!this.leak && Math.random() < look.leakRate * dt) {
      const side = Math.random();
      this.leak = {
        start: t,
        dur: rand(1.5, 4),
        x: side < 0.45 ? -0.15 : side < 0.9 ? 1.15 : rand(0.2, 0.8),
        y: side < 0.9 ? rand(0.1, 0.9) : -0.15,
        r: rand(0.45, 0.8),
        peak: rand(0.25, 0.55),
        color: LEAK_COLORS[Math.floor(Math.random() * LEAK_COLORS.length)],
      };
    }
    let leak = [0, 0, 1, 0];
    let leakColor = LEAK_COLORS[0];
    if (this.leak) {
      const k = (t - this.leak.start) / this.leak.dur;
      if (k < 0 || k >= 1) {
        this.leak = null;
      } else {
        leak = [this.leak.x, this.leak.y + Math.sin(t * 0.7) * 0.05, this.leak.r, this.leak.peak * Math.sin(Math.PI * k) ** 1.5];
        leakColor = this.leak.color;
      }
    }

    const scratch = [0, 0, 0, 0];
    for (let i = 0; i < 2; i++) {
      let s = this.scratches[i];
      if (s && --s.life <= 0) s = this.scratches[i] = null;
      if (!s && Math.random() < (look.scratchRate * dt) / 2) {
        const long = Math.random() < 0.3;
        s = this.scratches[i] = {
          x: rand(0.08, 0.92),
          a: rand(0.12, 0.35),
          life: long ? Math.round(rand(24, 96)) : Math.round(rand(2, 8)),
          drift: (Math.random() - 0.5) * 0.0006,
        };
      }
      if (s) {
        s.x += s.drift + (Math.random() - 0.5) * 0.0006;
        scratch[i * 2] = s.x;
        scratch[i * 2 + 1] = s.a;
      }
    }

    // Dust shows for a single frame, the way it does on a projector.
    const dust = new Float32Array(16);
    const scale = Math.min(W, H) / 1080;
    for (let i = 0; i < 4; i++) {
      if (Math.random() < (look.dustRate * dt) / 4) {
        dust.set([Math.random(), Math.random(), rand(1.2, 4) * scale + 0.8, rand(0.3, 0.7)], i * 4);
      }
    }

    return { jitter: [jx, jy], flicker, leak, leakColor, scratch, dust, seed: Math.random() };
  }
}

export class FilmRenderer {
  constructor(canvas, { prefer = 'webgl' } = {}) {
    this.out = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.stamp = new DateStamp();
    this.motion = new FilmMotion();
    this.look = null;
    this.srcW = 0;
    this.srcH = 0;
    this.W = canvas.width;
    this.H = canvas.height;
    this.mode = '2d';
    this.lastStamp = null;
    this.lastRenderMs = 0;
    this.onResize = null;
    this.onModeChange = null;
    if (prefer !== '2d') this.initGL();
  }

  setLook(look) {
    this.look = look;
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

      this.u = {};
      const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
        this.u[name] = gl.getUniformLocation(prog, name);
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

  // Crops the camera frame to 4:3 (3:4 when the phone is upright), like a Super 8 gate.
  configure(srcW, srcH) {
    const ar = srcH > srcW ? 3 / 4 : 4 / 3;
    let cw = srcW;
    let ch = srcH;
    if (srcW / srcH > ar) cw = Math.round(srcH * ar);
    else ch = Math.round(srcW / ar);
    const scale = Math.min(1, MAX_LONG_SIDE / Math.max(cw, ch));
    const W = Math.round((cw * scale) / 2) * 2;
    const H = Math.round((ch * scale) / 2) * 2;

    this.srcW = srcW;
    this.srcH = srcH;
    this.crop = { sx: (srcW - cw) / 2, sy: (srcH - ch) / 2, sw: cw, sh: ch };
    this.W = this.out.width = W;
    this.H = this.out.height = H;
    if (this.gl) {
      this.glCanvas.width = W;
      this.glCanvas.height = H;
      this.gl.viewport(0, 0, W, H);
    }
    this.onResize?.(W, H);
  }

  render(video, { mirror = false, date = null, seconds = false, now = performance.now() } = {}) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false;
    const t0 = performance.now();
    if (vw !== this.srcW || vh !== this.srcH) this.configure(vw, vh);

    const f = this.motion.step(now, this.look, this.W, this.H);
    if (this.gl && !this.gl.isContextLost()) this.drawGL(video, mirror, f);
    else this.draw2D(video, mirror, f);

    this.lastStamp = date ? this.stamp.draw(this.ctx, this.W, this.H, date, { seconds }) : null;
    this.lastRenderMs = performance.now() - t0;
    return true;
  }

  drawGL(video, mirror, f) {
    const { gl, u, look: L, crop: c, srcW, srcH } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.uniform1i(u.uTex, 0);
    gl.uniform4f(u.uCrop, c.sx / srcW, c.sy / srcH, c.sw / srcW, c.sh / srcH);
    gl.uniform2f(u.uSrcPx, 1 / c.sw, 1 / c.sh);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    gl.uniform2f(u.uRes, this.W, this.H);
    gl.uniform2f(u.uJitter, f.jitter[0], f.jitter[1]);
    gl.uniform1f(u.uZoom, OVERSCAN);
    gl.uniform1f(u.uSeed, f.seed);
    gl.uniform1f(u.uFlicker, f.flicker);
    gl.uniform4fv(u.uLeak, f.leak);
    gl.uniform3fv(u.uLeakColor, f.leakColor);
    gl.uniform4fv(u.uScratch, f.scratch);
    gl.uniform4fv(u.uDust, f.dust);

    gl.uniform1f(u.uSat, L.saturation);
    gl.uniform1f(u.uContrast, L.contrast);
    gl.uniform3fv(u.uGamma, L.gamma);
    gl.uniform3fv(u.uBlack, L.black);
    gl.uniform3fv(u.uWhite, L.white);
    gl.uniform1f(u.uSoft, L.softness);
    gl.uniform1f(u.uHalation, L.halation);
    gl.uniform3fv(u.uHalationColor, L.halationColor);
    gl.uniform1f(u.uHalationRadius, L.halationRadius);
    gl.uniform1f(u.uGrain, L.grain);
    gl.uniform1f(u.uGrainSize, L.grainSize);
    gl.uniform1f(u.uVignette, L.vignette);
    gl.uniform1f(u.uCorner, L.cornerRadius);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.ctx.drawImage(this.glCanvas, 0, 0);
  }

  // Fallback when WebGL is missing or its context was lost: blend modes approximate the grade.
  draw2D(video, mirror, f) {
    const { ctx, W, H, crop: c, look: L } = this;
    ctx.save();
    ctx.translate(W / 2 + f.jitter[0] * W, H / 2 + f.jitter[1] * H);
    ctx.scale((mirror ? -1 : 1) * OVERSCAN, OVERSCAN);
    ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, -W / 2, -H / 2, W, H);
    ctx.restore();

    const rgb = (v, k = 255) => `rgb(${v.map((x) => Math.round(x * k)).join(',')})`;
    const fill = (op, style, alpha = 1) => {
      ctx.globalCompositeOperation = op;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = style;
      ctx.fillRect(0, 0, W, H);
    };
    ctx.save();
    fill('saturation', '#808080', 1 - L.saturation);
    fill('soft-light', 'rgb(232,150,72)', 0.35);
    fill('multiply', rgb(L.white));
    fill('screen', rgb(L.black));
    if (f.flicker) fill(f.flicker > 0 ? 'screen' : 'multiply', f.flicker > 0 ? '#fff' : '#000', Math.abs(f.flicker) * 0.6);

    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    vg.addColorStop(0, '#fff');
    vg.addColorStop(1, `rgb(${Math.round(255 * (1 - L.vignette * 0.8))},${Math.round(255 * (1 - L.vignette * 0.85))},${Math.round(255 * (1 - L.vignette * 0.9))})`);
    fill('multiply', vg);

    if (f.leak[3] > 0.01) {
      const [lx, ly, lr, la] = f.leak;
      const g = ctx.createRadialGradient(lx * W, ly * H, 0, lx * W, ly * H, lr * H * 1.4);
      g.addColorStop(0, rgb(f.leakColor.map((x) => x * la)));
      g.addColorStop(1, '#000');
      fill('screen', g);
    }

    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(1, L.grain * 6);
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

  toBlob(type = 'image/jpeg', quality = 0.92) {
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
