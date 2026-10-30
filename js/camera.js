// Live camera via getUserMedia. Everything stays on the phone: the stream only feeds
// a <video> element that the film renderer reads from.

export class CameraError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
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

  async start(facing = this.facing) {
    if (!window.isSecureContext) throw new CameraError('InsecureContext', 'The camera needs an https:// page.');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('Unsupported', 'This browser has no camera access (getUserMedia).');

    this.stop(); // the iPhone only runs one camera at a time
    const ideal = {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
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
