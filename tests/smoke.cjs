// End-to-end checks in headless Chromium with a fake camera and microphone.
// This verifies the app's logic, not iPhone Safari: real-device behaviour (codecs,
// share sheet, permissions, performance) must be checked on the phone.
//
//   python3 -m http.server 8123 &                 (from the project root)
//   CHECKER=checker.y4m CHECKER_JSON=checker.json SCENE=scene.y4m OUT=/tmp/out node tests/smoke.cjs
//
// CHECKER is a colour-patch feed used to measure neutrality; SCENE is any photo feed.

const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8123/';
const OUT = process.env.OUT || path.join(__dirname, 'out');
const CHECKER = process.env.CHECKER;
const PATCHES = CHECKER ? JSON.parse(fs.readFileSync(process.env.CHECKER_JSON, 'utf8')) : null;
const SCENE = process.env.SCENE;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browsers = {};
async function browser(feed, { allowMedia = true } = {}) {
  const key = `${feed}|${allowMedia}`;
  if (!browsers[key]) {
    const args = ['--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
    if (allowMedia) args.push('--use-fake-ui-for-media-stream');
    if (feed) args.push(`--use-file-for-fake-video-capture=${feed}`);
    browsers[key] = await chromium.launch({ args });
  }
  return browsers[key];
}

// Opens the app. returning: skip the first-run screen. prefs: initial preferences.
async function open({ feed = SCENE, permissions = ['camera', 'microphone'], viewport, returning = true, prefs, url = '?debug&nosw', init, ctx } = {}) {
  ctx = ctx || await (await browser(feed)).newContext({
    ...devices['iPhone 13'],
    ...(viewport ? { viewport } : {}),
    timezoneId: 'Europe/Rome',
    locale: 'en-US',
    permissions,
    acceptDownloads: true,
  });
  await ctx.addInitScript(({ returning, prefs }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    if (returning) localStorage.setItem('cameraGranted', 'true');
    if (prefs) localStorage.setItem('prefs-v2', JSON.stringify(prefs));
  }, { returning, prefs });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + url);
  return { ctx, page, errors };
}

const ready = (page) => page.waitForFunction(() => window.__cam?.camera.running && !document.querySelector('#shutter').disabled, null, { timeout: 15000 });

async function saveCapture(page, index, file) {
  const b64 = await page.evaluate(async (i) => {
    const c = window.__cam.state.captures.at(i);
    const buf = new Uint8Array(await c.blob.arrayBuffer());
    let s = '';
    for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
    return btoa(s);
  }, index);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file]);
    return JSON.parse(out);
  } catch (e) {
    return { error: String(e.stderr || e) };
  }
}

// Decodes every frame; returns the number decoded (0 if the file is unreadable).
function decodedFrames(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
    return parseInt(String(out).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function record(page, seconds) {
  await page.click('#shutter');
  await page.waitForFunction(() => !!window.__cam.state.recording, null, { timeout: 10000 });
  await page.waitForTimeout(seconds * 1000);
}

(async () => {
  // ---------- 1. Colour: each profile vs the unfiltered camera image ----------
  if (CHECKER) {
    const { ctx, page } = await open({ feed: CHECKER });
    await ready(page);
    await page.waitForTimeout(800);
    const sample = (name) => page.evaluate(async ({ patches }) => {
      const { renderer, drawFrame } = window.__cam;
      const ctx2 = renderer.out.getContext('2d');
      const res = {};
      for (const [k, p] of Object.entries(patches)) res[k] = [0, 0, 0];
      const N = 6;
      for (let f = 0; f < N; f++) {
        drawFrame(performance.now() + f * 40, null);
        const c = renderer.crop;
        for (const [k, p] of Object.entries(patches)) {
          const sx = Math.min(Math.max(p.x, c.sx + 120), c.sx + c.sw - 120);
          const x = Math.round(((sx - c.sx) / c.sw) * renderer.W);
          const y = Math.round(((p.y - c.sy) / c.sh) * renderer.H);
          const d = ctx2.getImageData(x - 20, y - 20, 40, 40).data;
          for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) res[k][j] += d[i + j] / (d.length / 4) / N;
        }
      }
      for (const k in res) res[k] = res[k].map(Math.round);
      return res;
    }, { patches: PATCHES });

    await page.evaluate(() => { window.__cam.state.comparing = true; });
    const raw = await sample();
    await page.evaluate(() => { window.__cam.state.comparing = false; });
    const table = { raw };
    for (const id of ['home', 'super8', 'vhs']) {
      await page.evaluate((id) => { window.__cam.prefs.profile = id; document.querySelector('#menuBtn'); }, id);
      await page.evaluate(() => window.__cam.prefs && null);
      await page.evaluate(async (id) => {
        const m = await import('./js/looks.js');
        window.__cam.renderer.setLook(m.toUniforms(id, window.__cam.prefs.film[id]));
      }, id);
      table[id] = await sample();
      if (id === 'home') {
        await page.evaluate(async () => {
          const m = await import('./js/looks.js');
          window.__cam.renderer.setLook(m.toUniforms('home', { ...window.__cam.prefs.film.home, vignette: 0 }));
        });
        table.homeNoVignette = await sample();
      }
    }
    const warm = (c) => c[0] - c[2]; // red minus blue: positive = warm/yellow
    const lines = ['patch        raw            home           super8         vhs'];
    for (const k of Object.keys(PATCHES)) lines.push(`${k.padEnd(12)} ${['raw', 'home', 'super8', 'vhs'].map((p) => table[p][k].join(',').padEnd(14)).join(' ')}`);
    fs.writeFileSync(path.join(OUT, 'colour-table.txt'), lines.join('\n'));
    console.log(lines.join('\n'));

    const h = table.home;
    // Home Movie is matched to 1980s camcorder footage: cool (lavender/blue) whites and
    // lifted blue-grey shadows, while sky, foliage and skin keep their natural hues.
    const hw = table.homeNoVignette.white;
    check('Home Movie: whites lean cool like the reference (B > R, no yellow)', h.white[2] > h.white[0] + 5 && warm(h.white) < 0, `raw ${raw.white} → ${h.white}`);
    check('Home Movie: whites stay bright (≥ 200, the reference is ~172–198)', Math.min(...hw) >= 200, `${hw}`);
    check('Home Movie: sky stays blue', h.sky[2] > h.sky[0] + 40 && h.sky[2] > h.sky[1], `${raw.sky} → ${h.sky}`);
    check('Home Movie: foliage stays green', h.foliage[1] > h.foliage[0] && h.foliage[1] > h.foliage[2], `${raw.foliage} → ${h.foliage}`);
    check('Home Movie: skin keeps natural order R>G>B', h.skin_light[0] > h.skin_light[1] && h.skin_light[1] > h.skin_light[2], `${raw.skin_light} → ${h.skin_light}`);
    check('Home Movie: shadows lifted and bluish like the reference', Math.min(...h.black) >= 18 && h.black[2] >= h.black[0], `${raw.black} → ${h.black}`);
    for (const id of ['super8', 'vhs']) {
      check(`${id}: no strong yellow cast on white (R−B shift ≤ 18)`, warm(table[id].white) - warm(raw.white) <= 18, `${table[id].white}`);
      check(`${id}: sky still blue`, table[id].sky[2] > table[id].sky[0] + 25, `${table[id].sky}`);
    }
    const distinct = (a, b) => Object.keys(PATCHES).some((k) => a[k].some((v, i) => Math.abs(v - b[k][i]) > 6));
    check('three profiles look distinct', distinct(table.home, table.super8) && distinct(table.home, table.vhs) && distinct(table.super8, table.vhs));
    await ctx.close();
  }

  // ---------- 2. First run, photo, quick preview, gallery persists across relaunch ----------
  {
    const { ctx, page, errors } = await open({ returning: false });
    check('first run explains before asking for the camera', (await page.textContent('#overlayTitle')) === 'Insert tape');
    await page.click('#overlayBtn');
    await ready(page);
    check('power lamp lights when the camera runs', await page.evaluate(() => document.querySelector('#powerLamp').classList.contains('on')));
    check('WebGL renderer active', (await page.evaluate(() => window.__cam.renderer.mode)) === 'webgl');
    await page.waitForTimeout(800);

    const romeTime = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date()).replace(/\s/g, ' ');
    const romeDate = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', month: 'short', day: 'numeric', year: 'numeric' }).formatToParts(new Date());
    const part = (t) => romeDate.find((p) => p.type === t).value;
    const expectDate = `${part('month').toUpperCase()} ${part('day')} ${part('year')}`;
    const stamp = await page.evaluate(() => window.__cam.renderer.lastStamp);
    check('live stamp uses the phone clock in camcorder format', stamp?.[0] === expectDate && stamp?.[1] === romeTime, `${JSON.stringify(stamp)} expected ${expectDate} / ${romeTime}`);
    await page.screenshot({ path: path.join(OUT, '1-photo-mode.png') });

    await page.click('#shutter');
    await page.waitForFunction(() => window.__cam.state.captures.length === 1);
    check('photo shows an immediate preview', await page.waitForSelector('#quick:not([hidden])', { timeout: 3000 }).then(() => true, () => false));
    await page.$eval('#quickOpen', (b) => b.click());
    await page.waitForSelector('#review:not([hidden])');
    await page.click('#reviewClose');
    const cap = await page.evaluate(() => { const c = window.__cam.state.captures[0]; return { kind: c.kind, type: c.blob.type, size: c.blob.size, w: c.width, h: c.height }; });
    check('photo is a JPEG at the full output size', cap.type === 'image/jpeg' && cap.w === await page.evaluate(() => window.__cam.renderer.W), JSON.stringify(cap));
    const photo = await saveCapture(page, -1, path.join(OUT, '2-photo.jpg'));
    check('photo file decodes', probe(photo).streams?.[0]?.width === cap.w);

    await page.click('#thumb');
    await page.waitForSelector('#review:not([hidden])');
    const status = await page.textContent('#reviewStatus');
    check('review never claims it is in Photos before saving', status.startsWith('Kept in this app only'), status);
    await page.screenshot({ path: path.join(OUT, '3-review-photo.png') });
    await page.click('#reviewClose');

    await page.reload();
    await ready(page);
    check('gallery survives an app relaunch (stored on the phone)', (await page.evaluate(() => window.__cam.state.captures.length)) === 1);
    check('no page errors (photo flow)', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------- 3. Stamp settings, profiles, compare, persistence ----------
  {
    const { ctx, page, errors } = await open();
    await ready(page);
    await page.click('#menuBtn');
    await page.waitForSelector('#settings:not([hidden])');
    await page.screenshot({ path: path.join(OUT, '4-menu.png') });
    await page.click('#settings .segment button[data-value="24"]');
    await page.selectOption('#settings select >> nth=0', 'd-mon-y');
    await page.waitForTimeout(300);
    const s24 = await page.evaluate(() => window.__cam.renderer.lastStamp);
    check('24-hour clock and day-month date format apply live', /^\d{2}:\d{2}$/.test(s24[1]) && /^\d{1,2} [A-Z]{3} \d{4}$/.test(s24[0]), JSON.stringify(s24));

    await page.click('#settings .segment button[data-value="vhs"]');
    check('profile switch updates the LCD', (await page.textContent('#lcdProfile')) === 'VHS');
    const slider = page.locator('#settings input[type=range] >> nth=0');
    await slider.fill('60');
    check('warmth slider edits the current profile', (await page.evaluate(() => window.__cam.prefs.film.vhs.warmth)) === 60);
    await page.click('#settings button:has-text("Reset this profile")');
    check('reset restores profile defaults', (await page.evaluate(() => window.__cam.prefs.film.vhs.warmth)) === 4);
    await page.click('#settings .segment button[data-value="home"]');
    await page.click('#settingsClose');

    await page.click('#stampToggle');
    await page.waitForTimeout(200);
    check('DATE switch turns the stamp off', (await page.evaluate(() => window.__cam.renderer.lastStamp)) === null);
    await page.click('#stampToggle');

    const box = await page.locator('#finderWindow').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(200);
    const comparing = await page.evaluate(() => window.__cam.state.comparing && !document.querySelector('#compareTag').hidden);
    await page.mouse.up();
    check('press and hold shows the original image', comparing && !(await page.evaluate(() => window.__cam.state.comparing)));

    await page.waitForTimeout(400); // let the debounced save run
    await page.reload();
    await ready(page);
    const kept = await page.evaluate(() => ({ clock: window.__cam.prefs.stamp.clock, fmt: window.__cam.prefs.stamp.dateFormat }));
    check('settings persist across relaunch', kept.clock === '24' && kept.fmt === 'd-mon-y', JSON.stringify(kept));
    check('no page errors (settings)', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------- 4. Video with audio, both formats ----------
  for (const fmt of ['mp4', 'webm']) {
    const { ctx, page, errors } = await open({ prefs: { quality: '720', mode: 'video', videoFormat: fmt } });
    await ready(page);
    const supported = await page.evaluate((f) => !!window.__cam.support[f], fmt);
    if (!supported) {
      check(`${fmt}: recording`, true, 'format not offered by this browser, skipped');
      await ctx.close();
      continue;
    }
    await page.waitForFunction(() => !!window.__cam.mic.track, null, { timeout: 10000 });
    check(`${fmt}: LCD shows STBY in video mode`, (await page.textContent('#lcdMode')) === 'STBY');
    await record(page, 4);
    const during = await page.evaluate(() => ({
      lcd: document.querySelector('#lcdMode').textContent,
      lamp: document.querySelector('#recLamp').classList.contains('on'),
      menu: document.querySelector('#menuBtn').disabled,
      flip: document.querySelector('#flip').disabled,
      timer: document.querySelector('#recTimer').textContent,
    }));
    check(`${fmt}: recording UI (REC lamp, timer, MENU/flip locked)`, during.lamp && during.menu && during.flip && /^REC 0:00:0[2-9]$/.test(during.lcd), JSON.stringify(during));
    await page.screenshot({ path: path.join(OUT, `5-recording-${fmt}.png`) });
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 15000 });
    const file = await saveCapture(page, -1, path.join(OUT, `6-video.${fmt}`));
    const info = probe(file);
    const v = info.streams?.find((s) => s.codec_type === 'video');
    const a = info.streams?.find((s) => s.codec_type === 'audio');
    const dims = await page.evaluate(() => { const c = window.__cam.state.captures.at(-1); return [c.width, c.height, c.mime]; });
    check(`${fmt}: file has filtered video at the output size`, v && v.width === dims[0] && v.height === dims[1], `${v?.codec_name} ${v?.width}×${v?.height} (${dims[2]})`);
    check(`${fmt}: file has microphone audio`, !!a, a ? a.codec_name : 'no audio stream');
    check(`${fmt}: file decodes`, decodedFrames(file) > 0, `${decodedFrames(file)} frames, duration ${info.format?.duration}`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-sseof', '-1', '-i', file, '-frames:v', '1', path.join(OUT, `7-video-frame-${fmt}.png`)]);
    // The blinking REC indicator sits in the top-left corner: the amount of bright red
    // there must rise and fall with the blink (scene content alone stays constant).
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'fps=4,crop=200:60:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 });
    const reds = [];
    for (let f = 0; f + 36000 <= raw.length; f += 36000) {
      let red = 0;
      for (let i = f; i < f + 36000; i += 3) if (raw[i] > 200 && raw[i + 1] < 110 && raw[i + 2] < 100) red++;
      reds.push(red);
    }
    const swing = Math.max(...reds) - Math.min(...reds);
    check(`${fmt}: blinking REC indicator is burned into the video`, swing > 300, `red pixels per frame range ${Math.min(...reds)}–${Math.max(...reds)}`);
    await page.screenshot({ path: path.join(OUT, `8-review-video-${fmt}.png`) });
    check(`${fmt}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------- 4b. Save sheet opens right after capture (iOS share sheet stubbed) ----------
  {
    const stub = () => {
      window.__shares = [];
      window.__shareMode = 'ok';
      navigator.canShare = () => true;
      navigator.share = (data) => {
        window.__shares.push(data.files.map((f) => `${f.type}|${f.name}|${f.size}`));
        if (window.__shareMode === 'deny') return Promise.reject(new DOMException('no activation', 'NotAllowedError'));
        return Promise.resolve();
      };
    };
    const { ctx, page, errors } = await open({ prefs: { quality: '720', videoFormat: 'webm' }, init: stub });
    await ready(page);
    await page.click('#shutter');
    await page.waitForFunction(() => window.__shares.length === 1, null, { timeout: 10000 });
    const r = await page.evaluate(() => ({ shares: window.__shares, shared: window.__cam.state.captures.at(-1).shared, badge: document.querySelector('#thumbCount').hidden }));
    check('auto-save: Save sheet opens right after a photo with the JPEG', r.shares[0][0].startsWith('image/jpeg|vintage-') && r.shared && r.badge, JSON.stringify(r.shares));

    await page.evaluate(() => { window.__shareMode = 'deny'; });
    await page.click('#shutter');
    await page.waitForFunction(() => window.__shares.length === 2, null, { timeout: 10000 });
    await page.waitForSelector('#quickSave:not([hidden])', { timeout: 5000 });
    const label = await page.textContent('#quickSave');
    await page.evaluate(() => { window.__shareMode = 'ok'; });
    await page.click('#quickSave');
    await page.waitForFunction(() => window.__shares.length === 3 && window.__cam.state.captures.at(-1).shared, null, { timeout: 5000 });
    check('auto-save refused by iOS: one-tap SAVE on the preview works', label === 'Save', `button said "${label}"`);

    await page.click('.mode [data-mode="video"]');
    await page.waitForFunction(() => !!window.__cam.mic.track, null, { timeout: 10000 });
    await record(page, 2);
    await page.click('#shutter');
    await page.waitForFunction(() => window.__shares.length === 4, null, { timeout: 15000 });
    const v = await page.evaluate(() => window.__shares[3][0]);
    check('auto-save: Save sheet opens right after a video with the video file', /^video\/webm.*\|vintage-.*\.webm\|\d+$/.test(v), v);
    check('no page errors (auto-save)', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------- 5. App killed mid-recording: recovered on next launch ----------
  {
    const { ctx, page } = await open({ prefs: { quality: '720', mode: 'video', videoFormat: 'webm' } });
    await ready(page);
    await page.waitForFunction(() => !!window.__cam.mic.track, null, { timeout: 10000 });
    await record(page, 3.5);
    const page2 = await ctx.newPage();
    await page.close({ runBeforeUnload: false }); // like iOS killing the app
    await page2.goto(BASE + '?debug&nosw');
    await page2.waitForFunction(() => window.__cam?.state.store, null, { timeout: 10000 });
    await page2.waitForTimeout(800);
    const rec = await page2.evaluate(() => window.__cam.state.captures.filter((c) => c.recovered).map((c) => c.blob.size));
    check('interrupted recording is recovered on next launch', rec.length === 1 && rec[0] > 0, `${rec}`);
    if (rec.length) {
      const file = await saveCapture(page2, -1, path.join(OUT, '9-recovered.webm'));
      check('recovered video decodes', decodedFrames(file) > 0, `${decodedFrames(file)} frames`);
    }
    await ctx.close();
  }

  // ---------- 6. Leaving the app while recording keeps the clip ----------
  {
    const { ctx, page } = await open({ prefs: { quality: '720', mode: 'video' } });
    await ready(page);
    await page.waitForFunction(() => !!window.__cam.mic.track, null, { timeout: 10000 });
    await record(page, 2.5);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !window.__cam.state.recording && window.__cam.state.captures.length === 1, null, { timeout: 10000 });
    const r = await page.evaluate(() => ({ size: window.__cam.state.captures[0].blob.size, cam: window.__cam.camera.stream, mic: window.__cam.mic.stream }));
    check('going to the background stops recording, keeps the clip, releases camera and mic', r.size > 0 && r.cam === null && r.mic === null, JSON.stringify({ size: r.size }));
    await ctx.close();
  }

  // ---------- 7. Rotation while recording keeps the output size fixed ----------
  {
    const { ctx, page } = await open();
    await ready(page);
    const r = await page.evaluate(() => {
      const ren = window.__cam.renderer;
      const before = [ren.W, ren.H];
      ren.lock(true);
      ren.configure(1080, 1920); // phone turned upright mid-recording
      const locked = [ren.W, ren.H, ren.crop.sw / ren.crop.sh];
      ren.lock(false);
      ren.configure(1080, 1920);
      return { before, locked, after: [ren.W, ren.H] };
    });
    check('rotation during recording: size locked, crop keeps the aspect (no stretch)',
      r.locked[0] === r.before[0] && r.locked[1] === r.before[1] && Math.abs(r.locked[2] - r.before[0] / r.before[1]) < 0.01, JSON.stringify(r));
    check('after recording, portrait frames get a portrait output', r.after[1] > r.after[0], JSON.stringify(r.after));
    await ctx.close();
  }

  // ---------- 8. Microphone denied: video still records, silently, and says so ----------
  {
    const { ctx, page } = await open({ permissions: ['camera'], prefs: { quality: '720', videoFormat: 'webm' },
      init: () => {
        const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => (c.audio ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : orig(c));
      } });
    await ready(page);
    await page.click('.mode [data-mode="video"]');
    await page.waitForFunction(() => /Microphone is off/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
    check('mic denied: clear message', true);
    await record(page, 2);
    await page.click('#shutter');
    await page.waitForSelector('#review:not([hidden])', { timeout: 15000 });
    const c = await page.evaluate(() => { const x = window.__cam.state.captures.at(-1); return { silent: x.silent, size: x.blob.size, meta: document.querySelector('#reviewMeta').textContent }; });
    check('mic denied: video still saved, marked "no sound"', c.silent && c.size > 0 && c.meta.includes('no sound'), c.meta);
    await ctx.close();
  }

  // ---------- 9. Camera denied, context loss, landscape ----------
  {
    const { ctx, page } = await open({ returning: false, permissions: [],
      init: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); } });
    await page.click('#overlayBtn');
    await page.waitForFunction(() => document.querySelector('#overlayTitle').textContent === 'Camera access is off', null, { timeout: 5000 });
    check('camera denied: explains how to allow it, shutter stays off', await page.isDisabled('#shutter'));
    await page.screenshot({ path: path.join(OUT, '10-denied.png') });
    await ctx.close();
  }
  {
    const { ctx, page } = await open();
    await ready(page);
    await page.evaluate(() => window.__cam.renderer.loseContextForTest());
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ mode: window.__cam.renderer.mode, ok: window.__cam.drawFrame() }));
    check('GPU context loss falls back to 2D rendering', r.mode === '2d' && r.ok, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ viewport: { width: 844, height: 390 } });
    await ready(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '11-landscape.png') });
    const fits = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent && !b.closest('#review,#settings'))
      .every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    check('landscape: every control is on screen', fits);
    await ctx.close();
  }

  // ---------- 10. Offline cold start after the first visit ----------
  {
    const ctx = await (await browser(SCENE)).newContext({ ...devices['iPhone 13'], permissions: ['camera', 'microphone'] });
    let page = (await open({ ctx, url: '?debug' })).page;
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => page.reload());
    await page.waitForTimeout(500);
    await page.close();
    await ctx.setOffline(true);
    page = await ctx.newPage();
    const resp = await page.goto(BASE + '?debug').catch((e) => e);
    const ok = !(resp instanceof Error) && await page.waitForFunction(() => window.__cam?.camera.running, null, { timeout: 15000 }).then(() => true, () => false);
    check('offline: app and camera start with no connection (after one online visit)', ok);
    await ctx.close();
  }

  for (const b of Object.values(browsers)) await b.close();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
  process.exit(1);
});
