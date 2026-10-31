// Offline support: caches the app shell so the camera opens without a connection.
// Photos and videos never pass through here; they stay in the app's own storage.
// Bump VERSION with every release so phones pick up the new files.

const VERSION = 'vintage-cam-0.3.2';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/camera.js',
  './js/db.js',
  './js/looks.js',
  './js/overlay.js',
  './js/prefs.js',
  './js/recorder.js',
  './js/renderer.js',
  './js/settings.js',
  './js/share.js',
  './js/sound.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first, refreshed in the background. Navigations always get the cached
// index.html directly (no redirects, which iOS has had trouble serving offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const refresh = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic' && !res.redirected) cache.put(key, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(refresh.catch(() => {}));
        return cached;
      }
      return refresh;
    }),
  );
});
