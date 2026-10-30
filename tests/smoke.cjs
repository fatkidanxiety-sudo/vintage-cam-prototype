// Phase 1 smoke test in headless Chromium with a fake camera.
// This checks the app's logic, not iPhone Safari: real-device behaviour must be tested on the phone.
//
//   python3 -m http.server 8123 &           (from the project root)
//   FAKE_VIDEO=/path/scene.y4m OUT=/tmp/out node tests/smoke.cjs
//
// FAKE_VIDEO is optional (Chromium's built-in test pattern is used without it).

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8123/';
const OUT = process.env.OUT || path.join(__dirname, 'out');
const FAKE = process.env.FAKE_VIDEO;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function launch({ allowCamera }) {
  const args = ['--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  if (allowCamera) args.push('--use-fake-ui-for-media-stream');
  if (FAKE) args.push(`--use-file-for-fake-video-capture=${FAKE}`);
  return chromium.launch({ args });
}

async function newPage(browser, { allowCamera, url = '?debug', viewport, extraInit } = {}) {
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    ...(viewport ? { viewport } : {}),
    timezoneId: 'Europe/Rome',
    locale: 'en-US',
    permissions: allowCamera ? ['camera'] : [],
    acceptDownloads: true,
  });
  if (extraInit) await ctx.addInitScript(extraInit);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + url);
  return { ctx, page, errors };
}

(async () => {
  // ---- 1. Happy path: first run → open camera → photo → review → download ----
  let browser = await launch({ allowCamera: true });
  let { ctx, page, errors } = await newPage(browser, { allowCamera: true });

  check('first run shows "Load the film" before asking for the camera',
    await page.locator('#overlay:not([hidden]) #overlayTitle').textContent() === 'Load the film');
  await page.click('#overlayBtn');
  await page.waitForFunction(() => !document.querySelector('#shutter').disabled, null, { timeout: 10000 });
  check('camera starts and shutter enables', true);

  const mode = await page.evaluate(() => window.__cam.renderer.mode);
  check('WebGL film renderer active', mode === 'webgl', `mode=${mode}`);

  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const r = window.__cam.renderer;
    return { W: r.W, H: r.H, src: [r.srcW, r.srcH], stamp: r.lastStamp, ms: r.lastRenderMs };
  });
  check('output is cropped to 4:3 / 3:4', Math.abs(info.W / info.H - (info.W > info.H ? 4 / 3 : 3 / 4)) < 0.01,
    `${info.W}×${info.H} from ${info.src.join('×')}`);

  const romeNow = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date()).replace(/\s/g, ' ');
  check('date stamp shows Rome local time', info.stamp && info.stamp[0] === romeNow,
    `stamp=${JSON.stringify(info.stamp)} expected time ${romeNow}`);
  await page.screenshot({ path: path.join(OUT, '1-viewfinder.png') });

  await page.click('#shutter');
  await page.waitForFunction(() => !document.querySelector('#thumb').disabled);
  check('unsaved badge shows 1', (await page.textContent('#thumbCount')) === '1');

  await page.click('#thumb');
  await page.waitForFunction(() => document.querySelector('#reviewImg').naturalWidth > 0);
  const review = await page.evaluate(() => ({
    w: document.querySelector('#reviewImg').naturalWidth,
    h: document.querySelector('#reviewImg').naturalHeight,
    meta: document.querySelector('#reviewMeta').textContent,
    status: document.querySelector('#reviewStatus').textContent,
    share: !document.querySelector('#saveBtn').hidden,
    download: !document.querySelector('#downloadBtn').hidden,
    type: window.__cam.state.captures[0].file.type,
    size: window.__cam.state.captures[0].file.size,
  }));
  check('photo decodes at full output size', review.w === info.W && review.h === info.H, `${review.w}×${review.h}`);
  check('photo is a JPEG', review.type === 'image/jpeg', `${(review.size / 1e6).toFixed(2)} MB`);
  check('review shows Rome time zone', review.meta.includes('Europe/Rome'), review.meta);
  check('review says "Not saved yet" before any save', review.status.startsWith('Not saved yet'), review.status);
  check('a save route is offered', review.share || review.download, `share=${review.share} download=${review.download}`);
  await page.screenshot({ path: path.join(OUT, '2-review.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  const photoPath = path.join(OUT, '3-photo.jpg');
  await download.saveAs(photoPath);
  const head = fs.readFileSync(photoPath).subarray(0, 3);
  check('downloaded file is a real JPEG', head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff, download.suggestedFilename());
  check('status changes to Downloaded (not "saved to Photos")',
    (await page.textContent('#reviewStatus')).includes('Files app'));
  await page.click('#reviewClose');

  // ---- 2. Date stamp toggle and front camera mirroring ----
  await page.click('#stampToggle');
  await page.waitForTimeout(300);
  check('stamp toggle turns the imprint off', await page.evaluate(() => window.__cam.renderer.lastStamp === null));
  await page.click('#stampToggle');

  // ---- 3. Background and return: camera released, then reopened ----
  const hide = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(true);
  check('camera released when app is hidden', await page.evaluate(() => window.__cam.camera.stream === null));
  await hide(false);
  await page.waitForFunction(() => window.__cam.camera.running && !document.querySelector('#shutter').disabled, null, { timeout: 10000 });
  check('camera reopens when app returns', true);

  // ---- 4. System ends the track (e.g. another app takes the camera) ----
  await page.evaluate(() => window.__cam.camera.track.dispatchEvent(new Event('ended')));
  check('ended track shows "Camera stopped" with restart',
    (await page.textContent('#overlayTitle')) === 'Camera stopped' && await page.isVisible('#overlayBtn'));
  await page.click('#overlayBtn');
  await page.waitForFunction(() => window.__cam.camera.running, null, { timeout: 10000 });
  check('restart button brings camera back', true);

  // ---- 5. WebGL context loss falls back to 2D and keeps rendering ----
  await page.evaluate(() => window.__cam.renderer.loseContextForTest());
  await page.waitForTimeout(600);
  const lost = await page.evaluate(() => ({ mode: window.__cam.renderer.mode, ok: window.__cam.drawFrame() }));
  check('WebGL context loss falls back to 2D rendering', lost.mode === '2d' && lost.ok, JSON.stringify(lost));
  await page.screenshot({ path: path.join(OUT, '4-fallback-2d.png') });

  check('no page errors in happy path', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ---- 6. Landscape layout ----
  ({ ctx, page, errors } = await newPage(browser, {
    allowCamera: true, viewport: { width: 844, height: 390 },
    extraInit: () => localStorage.setItem('cameraGranted', 'true'),
  }));
  await page.waitForFunction(() => !document.querySelector('#shutter').disabled, null, { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '5-landscape.png') });
  check('returning user: camera starts without the intro', await page.isHidden('#overlay'));
  await ctx.close();
  await browser.close();

  // ---- 7. Permission denied ----
  // Headless Chromium can't show a prompt (it raises NotSupportedError), so simulate
  // the NotAllowedError Safari raises when the user taps Don't Allow.
  browser = await launch({ allowCamera: false });
  ({ ctx, page, errors } = await newPage(browser, {
    allowCamera: false,
    extraInit: () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    },
  }));
  await page.click('#overlayBtn');
  await page.waitForFunction(() => document.querySelector('#overlayTitle').textContent !== 'Load the film', null, { timeout: 10000 });
  const denied = await page.textContent('#overlayTitle');
  check('denied permission explains how to allow it', denied === 'Camera access is off', denied);
  check('shutter stays disabled when denied', await page.isDisabled('#shutter'));
  await page.screenshot({ path: path.join(OUT, '6-denied.png') });
  await ctx.close();
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
