# vintage-cam-prototype

Temporary working name. A free, on-device vintage film camera for iPhone, built as a
plain web app (no build step, no dependencies, no server code).

- Takes real photos with your iPhone's camera through `getUserMedia`.
- Applies the film look in WebGL and bakes it, plus the optional orange date stamp, into the saved file.
- Never uploads anything. Photos stay in the app's memory until you save or share them.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Camera preview, Super 8 look, live date/time, photo capture and export | Built, tested in desktop Chromium only |
| 2 | Video with microphone, effects and timestamp baked into the recording | Not started |
| 3 | Faded Home Movie and VHS looks, settings, offline PWA | Not started |

## Files

```
index.html        page and controls
css/app.css       camera-body styling, portrait and landscape
js/app.js         UI, camera lifecycle, capture, review and save
js/camera.js      getUserMedia start/stop and interruption events
js/renderer.js    WebGL film shader, 2D fallback, 4:3 crop
js/looks.js       film look settings
js/stamp.js       seven-segment date imprint (no font files)
js/share.js       share sheet and download helpers
tests/smoke.cjs   headless Chromium smoke test with a fake camera
```

## Running it

The camera only works over `https://` (or `http://localhost`). Any static host works:
GitHub Pages, Cloudflare Pages, Netlify. Locally:

```
python3 -m http.server 8123
FAKE_VIDEO=scene.y4m node tests/smoke.cjs     # optional fake camera feed
```

## Saving photos on iPhone

1. **Save / Share** opens the iOS share sheet. Choose **Save Image** to put the photo in Photos.
2. If Save Image isn't listed (reported on some iOS versions), press and hold the photo in the
   review screen and choose **Save to Photos**.
3. **Download** (Safari tab only) saves to Files › Downloads, not Photos.

The app never says a photo is in Photos. It can only tell that the share sheet finished,
not which option you picked.

## Known limits (iPhone)

- Photo resolution follows the live camera stream (about 1080×1440), not the 12–48 MP camera.
- Photos have no EXIF date, so Photos files them by the date you save them.
- Unsaved photos are lost if iOS closes the app. Save as you go.
- If your phone changes time zone while the app is open, close and reopen the app.
