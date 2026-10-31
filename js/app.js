import { Camera, Mic } from './camera.js';
import { FilmRenderer } from './renderer.js';
import { PROFILES, toUniforms, defaultAdjust } from './looks.js';
import { canShareFiles, shareFiles, downloadFile, isStandalone } from './share.js';
import { openStore, storageInfo } from './db.js';
import { Recording, videoSupport, pickType, extFor } from './recorder.js';
import { sound } from './sound.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { buildSettings } from './settings.js';

const VERSION = '0.3.1';
const MAX_LONG = { 720: 1280, 1080: 1920, '4k': 2880 };
const MAX_RECORD_SECONDS = 15 * 60;
const MIN_FREE_BYTES = 80e6;

const $ = (id) => document.getElementById(id);
const els = {
  video: $('cam'), out: $('out'), finderWindow: $('finderWindow'), flash: $('flash'),
  compareTag: $('compareTag'), recTimer: $('recTimer'), quick: $('quick'), quickOpen: $('quickOpen'), quickSave: $('quickSave'),
  overlay: $('overlay'), overlayTitle: $('overlayTitle'), overlayText: $('overlayText'), overlayBtn: $('overlayBtn'),
  powerLamp: $('powerLamp'), recLamp: $('recLamp'), lcdProfile: $('lcdProfile'), lcdMode: $('lcdMode'),
  stampToggle: $('stampToggle'), modeButtons: [...document.querySelectorAll('.mode [data-mode]')], menuBtn: $('menuBtn'),
  shutter: $('shutter'), flip: $('flip'), thumb: $('thumb'), thumbCount: $('thumbCount'), toast: $('toast'),
  review: $('review'), reviewImg: $('reviewImg'), reviewVideo: $('reviewVideo'), reviewMeta: $('reviewMeta'),
  reviewStatus: $('reviewStatus'), reviewCount: $('reviewCount'), reviewClose: $('reviewClose'),
  reviewDelete: $('reviewDelete'), reviewPrev: $('reviewPrev'), reviewNext: $('reviewNext'), reviewHint: $('reviewHint'),
  saveBtn: $('saveBtn'), saveAllBtn: $('saveAllBtn'), downloadBtn: $('downloadBtn'),
  settings: $('settings'), settingsBody: $('settingsBody'), settingsClose: $('settingsClose'),
};

const params = new URLSearchParams(location.search);
const prefs = loadPrefs();
const support = videoSupport();

const state = {
  wantCamera: false,
  starting: false,
  busy: false,
  comparing: false,
  recording: null,
  recTimer: 0,
  wakeLock: null,
  store: null,
  captures: [],      // { id, kind, blob, thumb, takenAt, zone, width, height, mime, duration, shared, downloaded, recovered, partial }
  reviewIndex: -1,
};

const camera = new Camera(els.video);
const mic = new Mic();
const renderer = new FilmRenderer(els.out, { prefer: params.get('renderer') === '2d' ? '2d' : 'webgl' });
renderer.onResize = (W, H) => {
  els.finderWindow.style.setProperty('--ar', `${W} / ${H}`);
  els.finderWindow.style.setProperty('--ar-num', String(W / H));
};
renderer.onModeChange = (mode, reason) => {
  if (reason) console.info(`Film renderer: ${mode} (${reason})`);
};

if (params.has('debug')) window.__cam = { camera, mic, renderer, state, prefs, drawFrame, support };

const look = () => toUniforms(prefs.profile, prefs.film[prefs.profile]);
let uniforms = look();

function applyLook() {
  uniforms = look();
  renderer.setLook(uniforms);
  renderer.setFormat({ aspect: prefs.aspect, maxLong: MAX_LONG[prefs.quality] || 1920 });
  updateLcd();
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePrefs(prefs), 250);
}

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

// Runs at the profile's frame rate (24 fps film, 30 fps video), not the screen's 60–120 Hz.
function tick(now) {
  raf = requestAnimationFrame(tick);
  const interval = 1000 / uniforms.fps;
  if (now - lastFrame < interval - 4) return;
  lastFrame = now - lastFrame > interval * 3 ? now : lastFrame + interval;
  drawFrame(now);
  // If frames get expensive, drop the decorative optics first so recording stays smooth.
  if (!renderer.lite && renderer.avgRenderMs > interval * 0.6) renderer.lite = true;
  else if (renderer.lite && renderer.avgRenderMs < interval * 0.25) renderer.lite = false;
}

function drawFrame(now = performance.now(), date = new Date()) {
  const rec = state.recording;
  return renderer.render(els.video, {
    mirror: camera.facing === 'user',
    date: prefs.stamp.on ? date : null,
    stamp: prefs.stamp,
    rec: !!rec && prefs.rec && rec.elapsed % 1 < 0.6,
    raw: state.comparing && !rec,
    now,
  });
}

// ---------- Camera lifecycle ----------

function explain(err) {
  switch (err.name) {
    case 'InsecureContext':
      return { title: 'Needs a secure link', text: 'The camera only works on an https:// page. Open the app from its https link.' };
    case 'Unsupported':
      return { title: 'No camera here', text: 'This browser can’t open the camera. Open the link in Safari instead.' };
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Camera access is off',
        text: 'In Safari, tap ᴀA in the address bar → Website Settings → Camera → Allow. Or use the Settings app → Apps → Safari → Camera. Then tap Try again.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', text: 'This device didn’t offer a matching camera. Try the other camera in MENU.' };
    case 'NotReadableError':
    case 'AbortError':
      return { title: 'Camera is busy', text: 'Another app or a call may be using the camera. Close it, then tap Try again.' };
    case 'NoFrames':
      return { title: 'No picture', text: 'The camera opened but showed no picture. Tap Try again.' };
    default:
      return { title: 'Camera didn’t start', text: `${err.message || err}. Tap Try again.` };
  }
}

async function startCamera() {
  if (state.starting || state.recording) return;
  state.starting = true;
  state.wantCamera = true;
  hideOverlay();
  setControls(false);
  try {
    await camera.start(prefs.facing, prefs.quality);
    try { localStorage.setItem('cameraGranted', 'true'); } catch { /* private mode */ }
    setControls(true);
    els.flip.disabled = (await camera.cameraCount()) < 2;
    lastFrame = 0;
    startLoop();
    if (prefs.mode === 'video') ensureMic();
  } catch (err) {
    camera.stop();
    stopLoop();
    const m = explain(err);
    showOverlay(m.title, m.text, 'Try again', startCamera);
  } finally {
    state.starting = false;
    updateLamps();
  }
}

function pauseCamera() {
  stopLoop();
  camera.stop();
  mic.close();
  sound.setSessionAmbient(true);
  setControls(false);
  updateLamps();
}

camera.onInterrupt = (kind) => {
  if (kind === 'muted') {
    if (state.recording) stopRecording('interrupted');
    showOverlay('Camera paused', 'iOS paused the camera (a call, Siri, or another app). It resumes on its own.', null);
  } else if (kind === 'unmuted') {
    hideOverlay();
  } else if (kind === 'ended' && !document.hidden) {
    if (state.recording) stopRecording('camera');
    pauseCamera();
    showOverlay('Camera stopped', 'The camera was turned off by the system.', 'Restart camera', startCamera);
  }
};

// iOS stops the camera when the app goes to the background and doesn't always bring
// it back, so finish any recording, release the camera on purpose and reopen on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.recording) stopRecording('background');
    if (camera.stream) pauseCamera();
  } else if (state.wantCamera && !camera.running) {
    startCamera();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.wantCamera && !camera.running) startCamera();
});

function setControls(on) {
  const rec = !!state.recording;
  els.shutter.disabled = !on;
  els.flip.disabled = !on || rec;
  for (const b of els.modeButtons) b.disabled = rec;
  els.menuBtn.disabled = rec;
  els.thumb.disabled = rec || !state.captures.length;
}

function updateLamps() {
  els.powerLamp.classList.toggle('on', camera.running);
  els.recLamp.classList.toggle('on', !!state.recording);
}

function updateLcd() {
  els.lcdProfile.textContent = PROFILES[prefs.profile].lcd;
  const rec = state.recording;
  els.lcdMode.classList.toggle('rec', !!rec);
  els.lcdMode.textContent = prefs.mode === 'photo' ? 'PHOTO' : rec ? `REC ${clock(rec.elapsed)}` : 'STBY';
}

function updateMode() {
  for (const b of els.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === prefs.mode));
  els.shutter.classList.toggle('photo', prefs.mode === 'photo');
  els.shutter.setAttribute('aria-label', prefs.mode === 'photo' ? 'Take photo' : 'Start recording');
  updateLcd();
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
function toast(msg, ms = 3400) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

// ---------- Controls ----------

function updateStampToggle() {
  els.stampToggle.setAttribute('aria-checked', String(prefs.stamp.on));
}

document.addEventListener('pointerdown', () => sound.unlock(), { capture: true });

els.stampToggle.addEventListener('click', () => {
  prefs.stamp.on = !prefs.stamp.on;
  persist();
  updateStampToggle();
  sound.play('key');
  settingsUI?.refresh();
});

for (const b of els.modeButtons) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}

async function setMode(mode) {
  if (state.recording || mode === prefs.mode) return;
  if (mode === 'video' && !support.available) {
    toast('This browser can’t record filtered video (no canvas capture or MediaRecorder).', 5000);
    return;
  }
  sound.play('key');
  prefs.mode = mode;
  persist();
  updateMode();
  if (mode === 'video') ensureMic();
  else {
    mic.close();
    sound.setSessionAmbient(true);
  }
}

async function ensureMic() {
  if (mic.track) return mic.track;
  sound.setSessionAmbient(false); // recording needs the normal audio session
  const track = await mic.open();
  if (!track) {
    toast(mic.denied
      ? 'Microphone is off, so videos will be silent. Allow it in Safari’s Website Settings to record sound.'
      : 'Couldn’t open the microphone. Videos will be silent.', 5000);
  }
  return track;
}

els.flip.addEventListener('click', () => {
  if (state.recording) return;
  sound.play('key');
  prefs.facing = camera.facing === 'user' ? 'environment' : 'user';
  persist();
  startCamera();
  settingsUI?.refresh();
});

els.shutter.addEventListener('click', () => {
  if (prefs.mode === 'photo') takePhoto();
  else if (state.recording) stopRecording('user');
  else startRecording();
});

// Press and hold the picture to see the plain camera image (before/after).
const finder = els.finderWindow;
const compare = (on) => {
  if (on && (state.recording || !camera.running)) return;
  state.comparing = on;
  els.compareTag.hidden = !on;
};
finder.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  compare(true);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) finder.addEventListener(ev, () => compare(false));
finder.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Photo ----------

async function takePhoto() {
  if (state.busy || !camera.running) return;
  state.busy = true;
  compare(false);
  sound.play('shutter');
  try {
    const takenAt = new Date();
    if (!drawFrame(performance.now(), takenAt)) throw new Error('no frame');
    const blob = await renderer.toBlob('image/jpeg', 0.93);
    if (!blob || !blob.size) throw new Error('encode failed');
    shutterBlink();
    const c = {
      id: newId(), kind: 'photo', blob, thumb: null, takenAt: takenAt.getTime(), zone: zoneLabel(takenAt),
      width: renderer.W, height: renderer.H, mime: 'image/jpeg', shared: false, downloaded: false,
    };
    const stored = addCapture(c);
    offerSave(c); // as soon as possible, while iOS still counts the shutter tap
    await stored;
  } catch (err) {
    console.error(err);
    toast('Couldn’t make that photo. The phone may be short on memory: close other apps and try again.', 5000);
  } finally {
    state.busy = false;
  }
}

function shutterBlink() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth; // restart the animation
  els.flash.classList.add('on');
}

let quickTimer = 0;
let quickCapture = null;
function showQuick(c, ms = 3500) {
  if (!c) return;
  quickCapture = c;
  els.quick.querySelector('img').src = urlFor(c, 'thumb');
  els.quickSave.hidden = !(canShareFiles([fileFor(c)]) || !isStandalone());
  updateQuickSave();
  els.quick.hidden = false;
  clearTimeout(quickTimer);
  quickTimer = setTimeout(() => { els.quick.hidden = true; }, ms);
}

function updateQuickSave() {
  const done = !!quickCapture && (quickCapture.shared || quickCapture.downloaded);
  els.quickSave.dataset.done = String(done);
  els.quickSave.textContent = done ? 'Sent' : 'Save';
}

els.quickOpen.addEventListener('click', () => {
  els.quick.hidden = true;
  openReview(state.captures.indexOf(quickCapture));
});

// One tap from the preview to the iOS Save sheet (or a download in a Safari tab).
els.quickSave.addEventListener('click', () => {
  const c = quickCapture;
  if (!c) return;
  clearTimeout(quickTimer);
  if (canShareFiles([fileFor(c)])) {
    shareFiles([fileFor(c)]).then(() => markShared(c), (err) => {
      if (err?.name !== 'AbortError') toast(`Sharing didn’t work (${err?.name || err}). Open the photo and try again.`, 5000);
    }).finally(() => { quickTimer = setTimeout(() => { els.quick.hidden = true; }, 2500); });
  } else {
    downloadFile(fileFor(c));
    c.downloaded = true;
    saveFlags(c);
    updateQuickSave();
    updateThumb();
    toast('Downloaded to the Files app (Downloads). From there, Share → Save to Photos.', 5000);
  }
});

function markShared(c) {
  c.shared = true;
  saveFlags(c);
  updateQuickSave();
  updateThumb();
  if (!els.review.hidden) renderReview();
  toast(`Done. If you chose ${c.kind === 'video' ? 'Save Video' : 'Save Image'}, it’s in Photos.`, 3500);
}

// Right after a capture, open the iOS Save sheet if the setting is on. iOS may refuse
// because the tap was too long ago (slow encoding); then the preview's SAVE button is
// one tap away. Nothing is ever saved without the user choosing Save in the sheet.
function offerSave(c, { fallback = 'quick' } = {}) {
  const showFallback = (ms) => (fallback === 'review' ? openReview(state.captures.indexOf(c)) : showQuick(c, ms));
  if (!prefs.autoSave || !canShareFiles([fileFor(c)])) return showFallback();
  let p;
  try {
    p = shareFiles([fileFor(c)]);
  } catch (err) {
    p = Promise.reject(err);
  }
  showQuick(c, 8000);
  p.then(() => markShared(c), (err) => {
    if (err?.name === 'AbortError') return;
    toast(`Tap SAVE to put it in Photos.`, 4000);
    showFallback(8000);
  });
}

// ---------- Video ----------

async function startRecording() {
  if (state.busy || state.recording || !camera.running) return;
  const type = pickType(prefs.videoFormat, support);
  if (!support.available || !type) {
    toast('This browser can’t record video here. Photo mode still works.', 5000);
    return;
  }
  state.busy = true;
  compare(false);
  try {
    const info = await storageInfo();
    if (info && info.free < MIN_FREE_BYTES) {
      toast('Not enough free storage to record. Save and delete some clips, or free up space on the iPhone.', 6000);
      return;
    }
    const audio = await ensureMic();
    const takenAt = new Date();
    drawFrame(performance.now(), takenAt);
    const poster = await renderer.toBlob('image/jpeg', 0.7);
    const id = newId();
    const meta = {
      id, kind: 'video', takenAt: takenAt.getTime(), zone: zoneLabel(takenAt),
      width: renderer.W, height: renderer.H, mime: type,
    };
    sound.play('rec');
    renderer.lock(true);
    await state.store.beginRecording({ ...meta, thumb: poster });
    const bitrate = Math.round(Math.min(12e6, Math.max(2.5e6, renderer.W * renderer.H * uniforms.fps * 0.12)));
    const rec = new Recording({
      canvas: els.out, fps: uniforms.fps, audioTracks: audio ? [audio] : [], type, bitrate, store: state.store, id,
    });
    rec.meta = meta;
    rec.poster = poster;
    rec.hasAudio = !!audio;
    rec.maxBytes = info ? Math.min(2e9, info.free - MIN_FREE_BYTES) : 2e9;
    rec.recorder.addEventListener('error', () => stopRecording('error'));
    rec.start();
    state.recording = rec;
    sound.muted = true;
    keepAwake(true);
    els.shutter.classList.add('recording');
    els.shutter.setAttribute('aria-label', 'Stop recording');
    els.recTimer.hidden = false;
    setControls(true);
    updateLamps();
    state.recTimer = setInterval(recordingTick, 250);
    recordingTick();
  } catch (err) {
    console.error(err);
    renderer.lock(false);
    toast(`Recording couldn’t start (${err.name || err.message}). Photo mode still works.`, 6000);
  } finally {
    state.busy = false;
  }
}

function recordingTick() {
  const rec = state.recording;
  if (!rec) return;
  els.recTimer.textContent = clock(rec.elapsed);
  updateLcd();
  if (rec.elapsed >= MAX_RECORD_SECONDS) stopRecording('time');
  else if (rec.bytes >= rec.maxBytes) stopRecording('storage');
}

const STOP_MESSAGES = {
  background: 'Recording stopped because the app left the screen. The clip was kept.',
  interrupted: 'Recording stopped because iOS paused the camera. The clip was kept.',
  camera: 'Recording stopped because the camera turned off. The clip was kept.',
  error: 'Recording hit an error. Everything up to that point was kept.',
  time: 'Recording stopped at the 15-minute limit. The clip was kept.',
  storage: 'Recording stopped because storage is nearly full. The clip was kept.',
};

async function stopRecording(reason = 'user') {
  const rec = state.recording;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(state.recTimer);
  let blob = null;
  try {
    blob = await rec.stop();
  } catch (err) {
    console.error(err);
  }
  state.recording = null;
  renderer.lock(false);
  sound.muted = false;
  keepAwake(false);
  els.shutter.classList.remove('recording');
  els.recTimer.hidden = true;
  updateMode();
  updateLamps();
  setControls(camera.running);

  if (!blob || !blob.size) {
    // Leave any chunks in place so the next launch can try to recover them.
    toast('The recording came out empty. This browser may not support recording here.', 6000);
    return;
  }
  const capture = {
    ...rec.meta, blob, thumb: rec.poster, mime: blob.type, duration: rec.elapsed,
    shared: false, downloaded: false, partial: !!rec.error, silent: !rec.hasAudio,
  };
  try {
    await state.store.finishRecording(rec.id, capture);
  } catch (err) {
    console.warn('Could not store the finished video; keeping it in memory:', err);
  }
  addCapture(capture, { stored: true });
  sound.play('rec');
  if (reason === 'user') {
    if (prefs.autoSave) offerSave(capture, { fallback: 'review' });
    else openReview(state.captures.length - 1);
  } else toast(STOP_MESSAGES[reason] || 'Recording stopped. The clip was kept.', 6000);
}

async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch { /* the screen may dim; recording continues */ }
}

// ---------- Captures and gallery ----------

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clock = (s) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function zoneLabel(date) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  let short = '';
  try {
    short = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { /* older engines */ }
  return short ? `${zone} (${short})` : zone;
}

function fileName(c) {
  const d = new Date(c.takenAt);
  const p = (n) => String(n).padStart(2, '0');
  const ext = c.kind === 'photo' ? 'jpg' : extFor(c.mime);
  return `vintage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

const urls = new Map();
function urlFor(c, which = 'blob') {
  const blob = which === 'thumb' ? c.thumb || c.blob : c.blob;
  const key = `${c.id}:${which === 'thumb' && c.thumb ? 'thumb' : 'blob'}`;
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

function revoke(c) {
  for (const k of [`${c.id}:blob`, `${c.id}:thumb`]) {
    if (urls.has(k)) URL.revokeObjectURL(urls.get(k));
    urls.delete(k);
  }
}

const fileFor = (c) => new File([c.blob], fileName(c), { type: c.mime || c.blob.type, lastModified: c.takenAt });

async function addCapture(c, { stored = false } = {}) {
  state.captures.push(c);
  updateThumb();
  if (!stored) {
    try {
      await state.store.putCapture(c);
    } catch (err) {
      console.warn('Could not store capture; it stays in memory for this session:', err);
      toast('Storage is full: this one is kept only until the app closes. Save it now.', 5000);
    }
  }
}

function saveFlags(c) {
  state.store.putCapture(c).catch(() => {});
}

const unsaved = () => state.captures.filter((c) => !c.shared && !c.downloaded);

function updateThumb() {
  const last = state.captures.at(-1);
  els.thumb.style.backgroundImage = last ? `url("${urlFor(last, 'thumb')}")` : '';
  const n = unsaved().length;
  els.thumbCount.hidden = n === 0;
  els.thumbCount.textContent = String(n);
  els.thumb.setAttribute('aria-label', last ? `Gallery (${n} not saved to Photos yet)` : 'No photos or videos yet');
  setControls(camera.running);
}

els.thumb.addEventListener('click', () => {
  sound.play('key');
  openReview(state.captures.length - 1);
});

function openReview(i) {
  if (!state.captures.length) return;
  state.reviewIndex = Math.max(0, Math.min(i, state.captures.length - 1));
  els.review.hidden = false;
  renderReview();
}

function closeReview() {
  els.reviewVideo.pause();
  els.reviewVideo.removeAttribute('src');
  els.reviewVideo.load();
  els.review.hidden = true;
  state.reviewIndex = -1;
  updateThumb();
}

const current = () => state.captures[state.reviewIndex];

function renderReview(message) {
  const c = current();
  if (!c) return closeReview();
  const total = state.captures.length;
  const isVideo = c.kind === 'video';
  const when = new Date(c.takenAt);

  els.reviewImg.hidden = isVideo;
  els.reviewVideo.hidden = !isVideo;
  if (isVideo) {
    els.reviewVideo.poster = c.thumb ? urlFor(c, 'thumb') : '';
    if (els.reviewVideo.dataset.id !== c.id) {
      els.reviewVideo.src = urlFor(c);
      els.reviewVideo.dataset.id = c.id;
    }
  } else {
    els.reviewVideo.pause();
    els.reviewImg.src = urlFor(c);
    els.reviewImg.alt = `Photo taken ${when.toLocaleString()}`;
  }

  els.reviewCount.textContent = `${state.reviewIndex + 1} / ${total}`;
  els.reviewPrev.hidden = state.reviewIndex === 0;
  els.reviewNext.hidden = state.reviewIndex === total - 1;

  const stamp = when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const parts = [stamp, c.zone, `${c.width}×${c.height}`];
  if (isVideo) parts.push(clock(c.duration || 0), extFor(c.mime).toUpperCase(), c.silent ? 'no sound' : 'with sound');
  parts.push(`${(c.blob.size / 1e6).toFixed(1)} MB`);
  els.reviewMeta.textContent = parts.join(' · ');

  const notes = [];
  if (c.recovered) notes.push('Recovered after the app closed mid-recording; the end may be cut off.');
  if (c.partial) notes.push('Recording was interrupted by an error.');
  els.reviewStatus.textContent = message ?? ([
    c.shared ? 'Sent through the share sheet. If you picked Save, it’s in Photos.'
      : c.downloaded ? 'Downloaded to the Files app (Downloads), not to Photos.'
        : 'Kept in this app only. Not in Photos yet.',
    ...notes,
  ].join(' '));
  els.reviewStatus.dataset.saved = String(c.shared || c.downloaded);

  const sharable = canShareFiles([fileFor(c)]);
  els.saveBtn.hidden = !sharable;
  // Downloads reportedly fail silently in Home Screen apps, so only offer them in a tab.
  els.downloadBtn.hidden = isStandalone() && sharable;
  els.downloadBtn.classList.toggle('primary', !sharable);

  const pending = unsaved();
  els.saveAllBtn.hidden = !(sharable && pending.length > 1 && canShareFiles(pending.map(fileFor)));
  els.saveAllBtn.textContent = `Save / Share all ${pending.length} unsaved`;

  const save = isVideo ? 'Save Video' : 'Save Image';
  els.reviewHint.textContent = sharable
    ? `In the share sheet, choose ${save} to put it in Photos.${isVideo ? '' : ' If it isn’t listed, close the sheet, press and hold the photo, and choose Save to Photos.'}`
    : isVideo ? 'Use Download, then save it from the Files app.' : 'Press and hold the photo and choose Save to Photos, or use Download.';
}

// No await before shareFiles(): iOS only allows the share sheet during the tap itself.
function shareCaptures(list) {
  let p;
  try {
    p = shareFiles(list.map(fileFor));
  } catch (err) {
    p = Promise.reject(err);
  }
  p.then(() => {
    for (const c of list) {
      c.shared = true;
      saveFlags(c);
    }
    renderReview();
  }).catch((err) => {
    if (err?.name === 'AbortError') renderReview('Share sheet closed. Nothing was saved.');
    else renderReview(`Sharing didn’t work (${err?.name || err}). Try Download${current()?.kind === 'photo' ? ' or press and hold the photo' : ''}.`);
  });
}

els.saveBtn.addEventListener('click', () => shareCaptures([current()]));
els.saveAllBtn.addEventListener('click', () => shareCaptures(unsaved()));
els.downloadBtn.addEventListener('click', () => {
  const c = current();
  downloadFile(fileFor(c));
  c.downloaded = true;
  saveFlags(c);
  renderReview('Download started. On iPhone it goes to the Files app (Downloads), not Photos.');
});

els.reviewClose.addEventListener('click', closeReview);
els.reviewPrev.addEventListener('click', () => { state.reviewIndex--; renderReview(); });
els.reviewNext.addEventListener('click', () => { state.reviewIndex++; renderReview(); });
els.reviewDelete.addEventListener('click', async () => {
  const c = current();
  const what = c.kind === 'video' ? 'video' : 'photo';
  if (!c.shared && !c.downloaded && !confirm(`Delete this ${what}? It hasn’t been saved anywhere else.`)) return;
  els.reviewVideo.pause();
  revoke(c);
  state.captures.splice(state.reviewIndex, 1);
  await state.store.deleteCapture(c.id).catch(() => {});
  if (!state.captures.length) return closeReview();
  state.reviewIndex = Math.min(state.reviewIndex, state.captures.length - 1);
  renderReview();
});

// ---------- Settings ----------

let settingsUI = null;

function openSettings() {
  if (state.recording) return;
  sound.play('key');
  compare(false);
  if (!settingsUI) {
    settingsUI = buildSettings(els.settingsBody, {
      prefs, support, onChange: settingChanged, onAction: settingAction, getInfo,
    });
  }
  settingsUI.refresh(true);
  els.settings.hidden = false;
}

function settingChanged(path) {
  persist();
  if (path === 'facing') return startCamera();
  if (path === 'quality') {
    applyLook();
    return startCamera();
  }
  if (path === 'sounds') sound.enabled = prefs.sounds;
  if (path.startsWith('stamp')) updateStampToggle();
  applyLook();
}

function settingAction(id) {
  if (id === 'resetProfile') {
    prefs.film[prefs.profile] = defaultAdjust(prefs.profile);
    persist();
    applyLook();
    settingsUI.refresh();
    toast(`${PROFILES[prefs.profile].name} reset to its defaults`, 1800);
  } else if (id === 'openGallery') {
    els.settings.hidden = true;
    if (state.captures.length) openReview(state.captures.length - 1);
    else toast('Nothing in the gallery yet.');
  }
}

async function getInfo(id) {
  if (id === 'zone') return `Time zone: ${zoneLabel(new Date())}. The stamp follows the iPhone’s clock automatically.`;
  if (id === 'videoSupport') {
    if (!support.available) return 'Video recording isn’t available in this browser.';
    const t = pickType(prefs.videoFormat, support);
    return `Recording format: ${t}.${support.webm ? '' : ' WebM not offered here.'}`;
  }
  if (id === 'version') return `Version ${VERSION} · on-device only · no analytics`;
  if (id === 'storage') {
    const bytes = state.captures.reduce((n, c) => n + c.blob.size + (c.thumb?.size || 0), 0);
    const info = await storageInfo();
    const keep = state.store?.persistent ? 'kept between launches' : 'kept only until the app closes';
    let text = `Gallery: ${state.captures.length} item${state.captures.length === 1 ? '' : 's'}, ${(bytes / 1e6).toFixed(1)} MB (${keep}). ${unsaved().length} not saved to Photos yet.`;
    if (info) text += ` Space available to this app: about ${(info.free / 1e9).toFixed(1)} GB.`;
    return text;
  }
  return '';
}

els.menuBtn.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', () => {
  sound.play('key');
  els.settings.hidden = true;
});

// ---------- Boot ----------

async function boot() {
  sound.enabled = prefs.sounds;
  sound.setSessionAmbient(prefs.mode === 'photo'); // video mode needs the normal session for the mic
  applyLook();
  updateMode();
  updateStampToggle();

  state.store = await openStore();
  try {
    // Rebuild any recording that was cut off when the app last closed.
    for (const meta of await state.store.pendingRecordings()) {
      const parts = await state.store.chunks(meta.id);
      const blob = parts.length ? new Blob(parts, { type: meta.mime }) : null;
      const capture = blob && {
        ...meta, blob, mime: meta.mime, duration: parts.length, recovered: true, shared: false, downloaded: false,
      };
      await state.store.finishRecording(meta.id, capture);
      if (capture) toast('A video that was interrupted last time was recovered. It’s in the gallery.', 6000);
    }
    state.captures = await state.store.listCaptures();
  } catch (err) {
    console.warn('Gallery load failed:', err);
  }
  updateThumb();

  if (!window.isSecureContext) {
    showOverlay('Needs a secure link', 'The camera only works on an https:// page. Open the app from its https link.', null);
  } else if (localStorage.getItem('cameraGranted') === 'true') {
    startCamera();
  } else {
    showOverlay(
      'Insert tape',
      'This camcorder uses your iPhone’s camera (and the microphone for video). Everything stays on your phone. Nothing is uploaded.',
      'Turn on camera',
      startCamera,
    );
  }

  if ('serviceWorker' in navigator && window.isSecureContext && !params.has('nosw')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable:', err));
  }
}

boot();
