import { Camera } from './camera.js';
import { FilmRenderer } from './renderer.js';
import { LOOKS, DEFAULT_LOOK } from './looks.js';
import { canShareFiles, shareFiles, downloadFile, isStandalone } from './share.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('cam'), out: $('out'), finderWindow: $('finderWindow'), flash: $('flash'),
  overlay: $('overlay'), overlayTitle: $('overlayTitle'), overlayText: $('overlayText'), overlayBtn: $('overlayBtn'),
  shutter: $('shutter'), flip: $('flip'), thumb: $('thumb'), thumbCount: $('thumbCount'),
  stampToggle: $('stampToggle'), lookEra: $('lookEra'), toast: $('toast'),
  review: $('review'), reviewImg: $('reviewImg'), reviewMeta: $('reviewMeta'), reviewStatus: $('reviewStatus'),
  reviewCount: $('reviewCount'), reviewClose: $('reviewClose'), reviewDelete: $('reviewDelete'),
  reviewPrev: $('reviewPrev'), reviewNext: $('reviewNext'), reviewHint: $('reviewHint'),
  saveBtn: $('saveBtn'), saveAllBtn: $('saveAllBtn'), downloadBtn: $('downloadBtn'),
};

const params = new URLSearchParams(location.search);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const state = {
  look: LOOKS[DEFAULT_LOOK],
  stampOn: store.get('stampOn', true),
  facing: store.get('facing', 'environment'),
  wantCamera: false,   // true once the user has asked for the camera
  starting: false,
  busy: false,
  captures: [],        // { id, file, url, takenAt, zone, width, height, shared, downloaded }
  reviewIndex: -1,
};

const camera = new Camera(els.video);
const renderer = new FilmRenderer(els.out, { prefer: params.get('renderer') === '2d' ? '2d' : 'webgl' });
renderer.setLook(state.look);
renderer.onResize = (W, H) => {
  els.finderWindow.style.setProperty('--ar', `${W} / ${H}`);
  els.finderWindow.style.setProperty('--ar-num', String(W / H));
};
renderer.onModeChange = (mode, reason) => {
  if (reason) console.info(`Film renderer: ${mode} (${reason})`);
};

if (params.has('debug')) window.__cam = { camera, renderer, state, drawFrame };

// ---------- Render loop ----------

let raf = 0;
let lastFrame = 0;

function startLoop() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

// Runs at the look's frame rate (24 fps for Super 8), not the screen's 60–120 Hz.
function tick(now) {
  raf = requestAnimationFrame(tick);
  const interval = 1000 / state.look.fps;
  if (now - lastFrame < interval - 4) return;
  lastFrame = now - lastFrame > interval * 3 ? now : lastFrame + interval;
  drawFrame(now);
}

function drawFrame(now = performance.now(), date = new Date()) {
  return renderer.render(els.video, {
    mirror: camera.facing === 'user',
    date: state.stampOn ? date : null,
    now,
  });
}

// ---------- Camera lifecycle ----------

function explain(err) {
  switch (err.name) {
    case 'InsecureContext':
      return { title: 'Needs a secure link', text: 'The camera only works on an https:// page. Open the app from its https link.' };
    case 'Unsupported':
      return { title: 'No camera in this browser', text: 'This browser can’t open the camera. Open the link in Safari instead.' };
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Camera access is off',
        text: 'In Safari, tap the ᴀA button in the address bar → Website Settings → Camera → Allow. You can also use the Settings app → Apps → Safari → Camera. Then come back and tap Try again.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', text: 'This device didn’t offer a camera that matches. Try switching cameras.' };
    case 'NotReadableError':
    case 'AbortError':
      return { title: 'Camera is busy', text: 'Another app or a call may be using the camera. Close it, then tap Try again.' };
    case 'NoFrames':
      return { title: 'Camera didn’t start', text: 'The camera opened but showed no picture. Tap Try again.' };
    default:
      return { title: 'Camera didn’t start', text: `${err.message || err}. Tap Try again.` };
  }
}

async function startCamera() {
  if (state.starting) return;
  state.starting = true;
  state.wantCamera = true;
  hideOverlay();
  setControls(false);
  try {
    await camera.start(state.facing);
    store.set('cameraGranted', true);
    setControls(true);
    els.flip.disabled = (await camera.cameraCount()) < 2;
    lastFrame = 0;
    startLoop();
  } catch (err) {
    camera.stop();
    stopLoop();
    const m = explain(err);
    showOverlay(m.title, m.text, 'Try again', startCamera);
  } finally {
    state.starting = false;
  }
}

function pauseCamera() {
  stopLoop();
  camera.stop();
  setControls(false);
}

camera.onInterrupt = (kind) => {
  if (kind === 'muted') {
    showOverlay('Camera paused', 'iOS paused the camera (a call, Siri, or another app). It resumes on its own.', null);
  } else if (kind === 'unmuted') {
    hideOverlay();
  } else if (kind === 'ended' && !document.hidden) {
    pauseCamera();
    showOverlay('Camera stopped', 'The camera was turned off by the system.', 'Restart camera', startCamera);
  }
};

// iOS stops the camera when the app goes to the background and doesn't always
// bring it back, so release it on purpose and reopen it on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (camera.stream) pauseCamera();
  } else if (state.wantCamera && !camera.running) {
    startCamera();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.wantCamera && !camera.running) startCamera();
});

function setControls(on) {
  els.shutter.disabled = !on;
  els.flip.disabled = !on;
}

function showOverlay(title, text, action, onAction) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text;
  els.overlayBtn.hidden = !action;
  els.overlayBtn.textContent = action || '';
  els.overlayBtn.onclick = onAction || null;
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

// ---------- Controls ----------

function updateStampToggle() {
  els.stampToggle.setAttribute('aria-checked', String(state.stampOn));
}

els.stampToggle.addEventListener('click', () => {
  state.stampOn = !state.stampOn;
  store.set('stampOn', state.stampOn);
  updateStampToggle();
  toast(state.stampOn ? 'Date stamp on' : 'Date stamp off', 1400);
});

els.flip.addEventListener('click', () => {
  state.facing = camera.facing === 'user' ? 'environment' : 'user';
  store.set('facing', state.facing);
  startCamera();
});

els.shutter.addEventListener('click', takePhoto);

async function takePhoto() {
  if (state.busy || !camera.running) return;
  state.busy = true;
  els.shutter.classList.add('firing');
  try {
    const takenAt = new Date();
    if (!drawFrame(performance.now(), takenAt)) throw new Error('no frame');
    const blob = await renderer.toBlob('image/jpeg', 0.92);
    if (!blob || !blob.size) throw new Error('encode failed');
    const file = new File([blob], fileName(takenAt, 'jpg'), { type: 'image/jpeg', lastModified: takenAt.getTime() });
    addCapture({ file, takenAt, width: renderer.W, height: renderer.H });
    flash();
  } catch (err) {
    console.error(err);
    toast('Couldn’t make that photo. The phone may be short on memory: close other apps and try again.', 5000);
  } finally {
    state.busy = false;
    setTimeout(() => els.shutter.classList.remove('firing'), 120);
  }
}

function flash() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth; // restart the animation
  els.flash.classList.add('on');
}

function fileName(d, ext) {
  const p = (n) => String(n).padStart(2, '0');
  return `vintage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function zoneLabel(date) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  let short = '';
  try {
    short = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { /* older engines */ }
  return short ? `${zone} (${short})` : zone;
}

// ---------- Captures ----------

function addCapture({ file, takenAt, width, height }) {
  state.captures.push({
    id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()),
    file, takenAt, width, height,
    url: URL.createObjectURL(file),
    zone: zoneLabel(takenAt),
    shared: false,
    downloaded: false,
  });
  updateThumb();
}

const unsaved = () => state.captures.filter((c) => !c.shared && !c.downloaded);

function updateThumb() {
  const last = state.captures.at(-1);
  els.thumb.disabled = !last;
  els.thumb.style.backgroundImage = last ? `url("${last.url}")` : '';
  const n = unsaved().length;
  els.thumbCount.hidden = n === 0;
  els.thumbCount.textContent = String(n);
  els.thumb.setAttribute('aria-label', last ? `Review photos (${n} not saved yet)` : 'No photos yet');
}

els.thumb.addEventListener('click', () => openReview(state.captures.length - 1));

function openReview(i) {
  if (!state.captures.length) return;
  state.reviewIndex = Math.max(0, Math.min(i, state.captures.length - 1));
  els.review.hidden = false;
  renderReview();
}

function closeReview() {
  els.review.hidden = true;
  state.reviewIndex = -1;
  updateThumb();
}

function current() {
  return state.captures[state.reviewIndex];
}

function renderReview(message) {
  const c = current();
  if (!c) return closeReview();
  const total = state.captures.length;
  els.reviewImg.src = c.url;
  els.reviewImg.alt = `Photo taken ${c.takenAt.toLocaleString()}`;
  els.reviewCount.textContent = `${state.reviewIndex + 1} of ${total}`;
  els.reviewPrev.hidden = state.reviewIndex === 0;
  els.reviewNext.hidden = state.reviewIndex === total - 1;

  const when = c.takenAt.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  els.reviewMeta.textContent = `${when} · ${c.zone} · ${c.width}×${c.height} · ${(c.file.size / 1e6).toFixed(1)} MB`;

  els.reviewStatus.textContent = message ?? (c.shared
    ? 'Sent through the share sheet. If you picked Save Image, it’s in Photos.'
    : c.downloaded
      ? 'Downloaded to the Files app (Downloads), not to Photos.'
      : 'Not saved yet. It only lives in this app until you save it.');
  els.reviewStatus.dataset.saved = String(c.shared || c.downloaded);

  const sharable = canShareFiles([c.file]);
  els.saveBtn.hidden = !sharable;
  // Downloads reportedly fail silently in Home Screen apps, so only offer them in a tab.
  els.downloadBtn.hidden = isStandalone() && sharable;
  els.downloadBtn.classList.toggle('primary', !sharable);

  const pending = unsaved();
  const showAll = sharable && pending.length > 1 && canShareFiles(pending.map((p) => p.file));
  els.saveAllBtn.hidden = !showAll;
  els.saveAllBtn.textContent = `Save / Share all ${pending.length} unsaved`;

  els.reviewHint.textContent = sharable
    ? 'In the share sheet, choose Save Image to put it in Photos. If Save Image isn’t listed, close the sheet, press and hold the photo above, and choose Save to Photos.'
    : 'Press and hold the photo above and choose Save to Photos, or use Download.';
}

// No await before shareFiles(): iOS only allows the share sheet during the tap itself.
function shareCaptures(list) {
  let p;
  try {
    p = shareFiles(list.map((c) => c.file));
  } catch (err) {
    p = Promise.reject(err);
  }
  p.then(() => {
    for (const c of list) c.shared = true;
    renderReview();
  }).catch((err) => {
    if (err?.name === 'AbortError') renderReview('Share sheet closed. Nothing was saved.');
    else renderReview(`Sharing didn’t work (${err?.name || err}). Press and hold the photo to save it instead.`);
  });
}

els.saveBtn.addEventListener('click', () => shareCaptures([current()]));
els.saveAllBtn.addEventListener('click', () => shareCaptures(unsaved()));
els.downloadBtn.addEventListener('click', () => {
  const c = current();
  downloadFile(c.file);
  c.downloaded = true;
  renderReview('Download started. On iPhone it goes to the Files app (Downloads), not Photos.');
});

els.reviewClose.addEventListener('click', closeReview);
els.reviewPrev.addEventListener('click', () => { state.reviewIndex--; renderReview(); });
els.reviewNext.addEventListener('click', () => { state.reviewIndex++; renderReview(); });
els.reviewDelete.addEventListener('click', () => {
  const c = current();
  if (!c.shared && !c.downloaded && !confirm('Delete this photo? It hasn’t been saved anywhere.')) return;
  URL.revokeObjectURL(c.url);
  state.captures.splice(state.reviewIndex, 1);
  if (!state.captures.length) return closeReview();
  state.reviewIndex = Math.min(state.reviewIndex, state.captures.length - 1);
  renderReview();
});

// ---------- Boot ----------

els.lookEra.textContent = state.look.era;
updateStampToggle();
updateThumb();

if (!window.isSecureContext) {
  showOverlay('Needs a secure link', 'The camera only works on an https:// page. Open the app from its https link.', null);
} else if (store.get('cameraGranted', false)) {
  startCamera();
} else {
  showOverlay(
    'Load the film',
    'This app uses your iPhone’s camera. Photos are made on the phone and stay on it. Nothing is uploaded.',
    'Open camera',
    startCamera,
  );
}
