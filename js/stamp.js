// Orange date imprint, drawn as seven-segment glyphs like the LED date backs on
// 1970s–80s cameras. No font files: every glyph is a canvas path.

const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
  5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  A: 'abcefg', P: 'abefg',
};

// Advance widths in units of the glyph height.
const DIGIT_W = 0.56;
const GAP = 0.26;
const ADVANCE = { ':': 0.34, "'": 0.3, ' ': DIGIT_W + GAP, M: 0.74 + GAP };
const advance = (ch) => ADVANCE[ch] ?? DIGIT_W + GAP;

const SKEW = 0.1;          // italic lean, like the LED digits
const LINE_GAP = 0.55;     // between the time and date lines

function hSeg(ctx, x0, x1, y, t) {
  const k = t / 2;
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + k, y - k);
  ctx.lineTo(x1 - k, y - k);
  ctx.lineTo(x1, y);
  ctx.lineTo(x1 - k, y + k);
  ctx.lineTo(x0 + k, y + k);
  ctx.closePath();
}

function vSeg(ctx, x, y0, y1, t) {
  const k = t / 2;
  ctx.moveTo(x, y0);
  ctx.lineTo(x + k, y0 + k);
  ctx.lineTo(x + k, y1 - k);
  ctx.lineTo(x, y1);
  ctx.lineTo(x - k, y1 - k);
  ctx.lineTo(x - k, y0 + k);
  ctx.closePath();
}

function glyph(ctx, ch, x, y, h) {
  const w = h * DIGIT_W;
  const t = h * 0.15;
  const g = t * 0.4;
  const m = y + h / 2;
  const segs = {
    a: () => hSeg(ctx, x + g, x + w - g, y, t),
    b: () => vSeg(ctx, x + w, y + g, m - g, t),
    c: () => vSeg(ctx, x + w, m + g, y + h - g, t),
    d: () => hSeg(ctx, x + g, x + w - g, y + h, t),
    e: () => vSeg(ctx, x, m + g, y + h - g, t),
    f: () => vSeg(ctx, x, y + g, m - g, t),
    g: () => hSeg(ctx, x + g, x + w - g, m, t),
  };

  if (SEGMENTS[ch]) {
    for (const s of SEGMENTS[ch]) segs[s]();
  } else if (ch === ':') {
    ctx.rect(x + t * 0.2, y + h * 0.28 - t / 2, t, t);
    ctx.rect(x + t * 0.2, y + h * 0.72 - t / 2, t, t);
  } else if (ch === "'") {
    vSeg(ctx, x + t, y - t * 0.3, y + h * 0.3, t * 0.9);
  } else if (ch === 'M') {
    const mw = h * 0.74;
    vSeg(ctx, x, y + g, m - g, t);
    vSeg(ctx, x, m + g, y + h - g, t);
    vSeg(ctx, x + mw, y + g, m - g, t);
    vSeg(ctx, x + mw, m + g, y + h - g, t);
    // The two diagonals are added as a stroke by the caller's second pass.
    return [[x + t * 0.7, y + t * 0.5, x + mw / 2, y + h * 0.5], [x + mw - t * 0.7, y + t * 0.5, x + mw / 2, y + h * 0.5]];
  }
  return null;
}

function lineWidth(text, h) {
  let w = 0;
  for (const ch of text) w += advance(ch) * h;
  return w - GAP * h;
}

// Date order and 12/24-hour clock follow the phone's region settings.
function localeHabits() {
  let order = ['month', 'day', 'year'];
  let hour12 = true;
  try {
    order = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(2006, 10, 22))
      .map((p) => p.type)
      .filter((t) => t === 'year' || t === 'month' || t === 'day');
    hour12 = !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
  } catch { /* keep defaults */ }
  return { order, hour12 };
}

const HABITS = localeHabits();
const pad2 = (n, fill = '0') => String(n).padStart(2, fill);

// Uses the phone's own clock and time zone (new Date() is always local time).
export function formatStamp(date, { seconds = false } = {}) {
  const parts = {
    year: "'" + pad2(date.getFullYear() % 100),
    month: pad2(date.getMonth() + 1, ' '),
    day: pad2(date.getDate(), ' '),
  };
  const dateLine = HABITS.order.map((k) => parts[k]).join(' ');

  const mm = pad2(date.getMinutes());
  const ss = seconds ? ':' + pad2(date.getSeconds()) : '';
  let timeLine;
  if (HABITS.hour12) {
    const h = date.getHours() % 12 || 12;
    timeLine = `${h}:${mm}${ss} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
  } else {
    timeLine = `${pad2(date.getHours())}:${mm}${ss}`;
  }
  return [timeLine, dateLine];
}

export class DateStamp {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.key = '';
    this.pad = 0;
  }

  // Draws the imprint into the bottom-right corner of ctx and returns the text lines.
  draw(ctx, W, H, date, opts) {
    const lines = formatStamp(date, opts);
    const h = Math.max(10, Math.round(Math.min(W, H) * 0.036));
    const key = lines.join('|') + '@' + h;
    if (key !== this.key) {
      this.paint(lines, h);
      this.key = key;
    }
    const margin = Math.round(Math.min(W, H) * 0.07);
    const x = W - margin - this.canvas.width + this.pad;
    const y = H - margin - this.canvas.height + this.pad;
    ctx.save();
    // Screen blend: the imprint is light exposed onto the film, so it adds to the picture.
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.canvas, x, y);
    ctx.restore();
    return lines;
  }

  paint(lines, h) {
    const pad = Math.ceil(h * 0.6);
    const widths = lines.map((l) => lineWidth(l, h));
    const textW = Math.max(...widths);
    const lineH = h * (1 + LINE_GAP);
    const c = this.canvas;
    c.height = Math.ceil(lineH * lines.length - h * LINE_GAP + pad * 2);
    c.width = Math.ceil(textW + c.height * SKEW + pad * 2);
    this.pad = pad;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    // Lean the glyphs forward, shifted right so the top line stays inside the canvas.
    ctx.setTransform(1, 0, -SKEW, 1, c.height * SKEW, 0);

    const path = () => {
      const strokes = [];
      ctx.beginPath();
      lines.forEach((line, i) => {
        let x = pad + textW - widths[i];        // right-aligned
        const y = pad + i * lineH;
        for (const ch of line) {
          const extra = glyph(ctx, ch, x, y, h);
          if (extra) strokes.push(...extra);
          x += advance(ch) * h;
        }
      });
      return strokes;
    };

    const fill = (color, alpha, blur) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.shadowColor = blur ? 'rgba(255, 96, 10, 0.95)' : 'transparent';
      ctx.shadowBlur = blur;
      const strokes = path();
      ctx.fill();
      ctx.lineWidth = h * 0.13;
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of strokes) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
      ctx.stroke();
    };

    fill('#ff7d1f', 0.95, h * 0.45);  // glowing body
    fill('#ffc27a', 0.55, 0);         // hot core
    ctx.restore();
  }
}
