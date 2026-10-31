// Camcorder on-screen display: the date/time stamp and the REC indicator.
// Drawn into the same canvas that is photographed and recorded, so preview and
// saved media match exactly. The font is a 5×7 dot-matrix character generator,
// the kind 1980s camcorders burned into the picture. No font files.

const FONT = {
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110',
  2: '01110100010000100010001000100011111', 3: '11111000100010000010000011000101110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000',
  8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110', D: '11100100101000110001100011001011100',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110', J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100011000101010001000010000100', Z: '11111000010001000100010001000011111',
  ':': '00000011000110000000011000110000000', '.': '00000000000000000000000000110001100',
  '/': '00001000100001000100010001000010000', '-': '00000000000000011111000000000000000',
  '●': '00000011101111111111111110111000000', ' ': '00000000000000000000000000000000000',
};
const ADV = 6;   // 5 dots + 1 gap, monospaced like the hardware
const ROWS = 7;
const LINE = 10; // 7 dots + 3 gap

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const STAMP_DEFAULTS = {
  on: true,
  clock: '12',            // '12' | '24'
  dateFormat: 'mon-d-y',  // see DATE_FORMATS
  position: 'br',         // 'br' | 'bl' | 'tr' | 'tl'
  size: 'm',              // 's' | 'm' | 'l'
  color: 'white',         // 'white' | 'orange'
  shadow: true,
};

export const DATE_FORMATS = {
  'mon-d-y': (d) => `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`,
  'd-mon-y': (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  'm/d/y': (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
  'd.m.y': (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`,
  'y-m-d': (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
};

const COLORS = { white: '#f3f0e7', orange: '#ffc08a' };
const SIZES = { s: 0.0034, m: 0.0044, l: 0.0058 }; // dot size as a fraction of the short side
const REC_RED = '#ff3b2f';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Always built from a fresh Date, which uses the phone's current clock and time zone.
export function stampLines(date, s) {
  const fmt = DATE_FORMATS[s.dateFormat] || DATE_FORMATS['mon-d-y'];
  const mm = pad(date.getMinutes());
  const time = s.clock === '24'
    ? `${pad(date.getHours())}:${mm}`
    : `${date.getHours() % 12 || 12}:${mm} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
  return [fmt(date), time];
}

class TextSprite {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.key = '';
  }

  // Re-rasterises only when the text or style changes (once a minute for the clock).
  update(lines, dot, color, shadow, align) {
    const key = `${lines.join('|')}|${dot}|${color}|${shadow}|${align}`;
    if (key === this.key) return;
    this.key = key;
    const cols = Math.max(...lines.map((l) => l.length));
    const pad = dot * 2;
    const c = this.canvas;
    c.width = cols * ADV * dot - dot + pad * 2;
    c.height = (lines.length * LINE - (LINE - ROWS)) * dot + pad * 2;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, c.width, c.height);

    const paint = (fill, dx, dy, blur) => {
      ctx.fillStyle = fill;
      ctx.shadowColor = blur ? fill : 'transparent';
      ctx.shadowBlur = blur;
      lines.forEach((line, li) => {
        const offset = align === 'right' ? (cols - line.length) * ADV : 0;
        [...line].forEach((ch, ci) => {
          const bits = FONT[ch] ?? FONT[' '];
          for (let i = 0; i < 35; i++) {
            if (bits[i] !== '1') continue;
            const x = pad + ((offset + ci * ADV) + (i % 5)) * dot + dx;
            const y = pad + (li * LINE + Math.floor(i / 5)) * dot + dy;
            ctx.fillRect(x, y, dot, dot);
          }
        });
      });
    };
    if (shadow) paint('rgba(0, 0, 0, 0.55)', Math.max(1, dot * 0.6), Math.max(1, dot * 0.6), 0);
    paint(color, 0, 0, dot * 0.9); // slight bloom, like characters keyed into a video signal
  }
}

export class Overlay {
  constructor() {
    this.stamp = new TextSprite();
    this.rec = new TextSprite();
    this.lastLines = null;
  }

  // date: Date or null (stamp off). rec: show the REC indicator this frame.
  draw(ctx, W, H, { date, settings, rec }) {
    const s = { ...STAMP_DEFAULTS, ...settings };
    const short = Math.min(W, H);
    const dot = Math.max(1, Math.round(short * (SIZES[s.size] || SIZES.m)));
    const margin = Math.round(short * 0.055);
    const pos = s.position || 'br';
    this.lastLines = null;

    if (date) {
      const lines = stampLines(date, s);
      this.lastLines = lines;
      const right = pos[1] === 'r';
      this.stamp.update(lines, dot, COLORS[s.color] || COLORS.white, s.shadow, right ? 'right' : 'left');
      const sc = this.stamp.canvas;
      const x = right ? W - margin - sc.width + dot * 2 : margin - dot * 2;
      const y = pos[0] === 'b' ? H - margin - sc.height + dot * 2 : margin - dot * 2;
      ctx.drawImage(sc, x, y);
    }

    if (rec) {
      // REC goes in the top corner the stamp isn't using.
      this.rec.update(['● REC'], dot, REC_RED, s.shadow, 'left');
      const rc = this.rec.canvas;
      const left = !(pos[0] === 't' && pos[1] === 'l');
      const x = left ? margin - dot * 2 : W - margin - rc.width + dot * 2;
      ctx.drawImage(rc, x, margin - dot * 2);
    }
  }
}
