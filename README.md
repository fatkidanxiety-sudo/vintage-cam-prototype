# vintage-cam-prototype

Temporary working name. A free, on-device 1980s camcorder for iPhone, built as a plain
web app (no build step, no dependencies, no server code, no analytics).

- Real photos and videos from the iPhone camera and microphone (`getUserMedia`).
- Film/video looks rendered in WebGL and burned into the saved files, together with the
  dot-matrix date/time stamp and blinking REC indicator.
- Nothing is uploaded. Captures stay in the app's on-device storage until you save or share them.

## Profiles

| Profile | Character | Defaults |
| --- | --- | --- |
| Home Movie (default) | 1980s camcorder: natural colour, fine video noise, slight chroma bleed | warmth 8, grain 22, saturation 88%, softness 12, vignette 14, tracking 3, leaks off, scratches off |
| Super 8 | 1970s film: clumpy grain, gate weave, flicker, rounded gate, occasional leaks/scratches | warmth 16, grain 40, saturation 84%, softness 24, vignette 32 |
| VHS | late-80s tape: smeared, misregistered colour, tracking wobble, head-switching noise | warmth 4, grain 30, saturation 80%, softness 36, tracking 22 |

All sliders are in MENU and saved per profile. Press and hold the viewfinder to compare with
the original camera image.

## Files

```
index.html             camcorder layout
css/app.css            styling, portrait and landscape
js/app.js              UI, camera lifecycle, photo/video capture, gallery, settings wiring
js/camera.js           camera and microphone streams
js/renderer.js         WebGL shader, 2D fallback, crop/aspect, raw compare
js/looks.js            the three profiles and slider → shader mapping
js/overlay.js          dot-matrix date/time stamp and REC indicator (canvas, no fonts)
js/recorder.js         MediaRecorder on the canvas + mic, format selection
js/db.js               on-device gallery (IndexedDB), crash-safe recording chunks
js/settings.js         MENU sheet
js/prefs.js            saved preferences
js/share.js            share sheet / download helpers
js/sound.js            synthesised button clicks
sw.js, manifest.webmanifest, icons/   offline Home Screen app
tests/smoke.cjs        end-to-end checks in headless Chromium
```

## Running and testing

Needs `https://` (or `http://localhost`). Any static host works; the live copy is GitHub Pages
from `main`.

```
python3 -m http.server 8123
CHECKER=checker.y4m CHECKER_JSON=checker.json SCENE=scene.y4m OUT=/tmp/out node tests/smoke.cjs
```

The tests use Chromium with fake camera/mic feeds. They prove the app's logic, not iPhone
Safari behaviour.

## Saving on iPhone

- **Save / Share** opens the iOS share sheet: choose **Save Image** / **Save Video** for Photos.
- If Save Image is missing, press and hold the photo and choose **Save to Photos**.
- **Download** (Safari tab only) goes to Files › Downloads, not Photos.
- The app never says something is in Photos; it can only tell the share sheet finished.

## Known limits

- Photo resolution follows the live stream (1080p: 1440×1080; 4K setting: up to 2880×2160), not the 12–48 MP camera.
- No EXIF date in files, so Photos files them by the day you save them.
- Video is recorded from the canvas at 24–30 fps; iOS MP4 recording has reported bugs (see report).
- Recordings stop when the app leaves the screen; the clip is kept. Max 15 minutes per clip.
