// Live camera via getUserMedia. Everything stays on the phone: the stream only feeds
// a <video> element that the film renderer reads from.

export class CameraError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

// Requested camera stream size. iOS picks the closest mode it supports.
export const QUALITY = { 720: [1280, 720], 1080: [1920, 1080], '4k': [3840, 2160] };

// Microphone for video mode, kept separate from the camera stream so switching
// cameras doesn't interrupt it.
export class Mic {
  constructor() {
    this.stream = null;
    this.denied = false;
  }

  get track() {
    const t = this.stream?.getAudioTracks()[0];
    return t && t.readyState === 'live' ? t : null;
  }

  async open() {
    if (this.track) return this.track;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        video: false,
      });
      this.denied = false;
      return this.track;
    } catch (err) {
      this.denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      this.error = err;
      return null;
    }
  }

  close() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this.onInterrupt = null; // ('ended' | 'muted' | 'unmuted') => void
    this.abort = null;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  get running() {
    return this.track?.readyState === 'live';
  }

  async start(facing = this.facing, quality = '1080') {
    if (!window.isSecureContext) throw new CameraError('InsecureContext', 'The camera needs an https:// page.');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('Unsupported', 'This browser has no camera access (getUserMedia).');

    this.stop(); // the iPhone only runs one camera at a time
    const [w, h] = QUALITY[quality] || QUALITY['1080'];
    const ideal = {
      facingMode: { ideal: facing },
      width: { ideal: w },
      height: { ideal: h },
      frameRate: { ideal: 30 },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: ideal, audio: false });
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotReadableError') throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    }

    this.stream = stream;
    const track = this.track;
    this.facing = track.getSettings?.().facingMode || facing;

    this.abort = new AbortController();
    const { signal } = this.abort;
    track.addEventListener('ended', () => this.onInterrupt?.('ended'), { signal });
    track.addEventListener('mute', () => this.onInterrupt?.('muted'), { signal });
    track.addEventListener('unmute', () => this.onInterrupt?.('unmuted'), { signal });

    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch { /* muted inline video normally autoplays; waitForVideo reports if it didn't */ }
    await waitForVideo(this.video);
  }

  // The back camera's LED, via the torch constraint. Only offered when the browser
  // reports it for this camera (never for the front camera).
  get hasTorch() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.hasTorch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  async cameraCount() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      return 2;
    }
  }
}

function waitForVideo(video, ms = 6000) {
  return new Promise((resolve, reject) => {
    const ready = () => video.videoWidth > 0 && video.readyState >= 2;
    if (ready()) return resolve();
    const check = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new CameraError('NoFrames', 'The camera opened but sent no picture.'));
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('resize', check);
      video.removeEventListener('playing', check);
    };
    video.addEventListener('loadeddata', check);
    video.addEventListener('resize', check);
    video.addEventListener('playing', check);
  });
}
