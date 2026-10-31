// Records the film canvas (effects and date stamp already burned in) plus the
// microphone, using MediaRecorder. Chunks go to the on-device store as they arrive
// so a recording is never silently lost.

const TYPES = {
  mp4: ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs=avc1', 'video/mp4'],
  webm: ['video/webm;codecs="vp8,opus"', 'video/webm;codecs=vp9,opus', 'video/webm'],
};

export function videoSupport() {
  const canvas = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  const recorder = typeof MediaRecorder !== 'undefined';
  const ok = (t) => recorder && MediaRecorder.isTypeSupported?.(t);
  return {
    available: canvas && recorder,
    canvas,
    recorder,
    mp4: TYPES.mp4.find(ok) ?? null,
    webm: TYPES.webm.find(ok) ?? null,
  };
}

// 'auto' prefers MP4: the iPhone Photos app can save it, and it may not take WebM.
export function pickType(pref, support = videoSupport()) {
  if (pref === 'webm') return support.webm ?? support.mp4;
  if (pref === 'mp4') return support.mp4 ?? support.webm;
  return support.mp4 ?? support.webm;
}

export const extFor = (type) => (type.startsWith('video/webm') ? 'webm' : 'mp4');

export class Recording {
  constructor({ canvas, fps, audioTracks = [], type, bitrate, store, id }) {
    this.id = id;
    this.store = store;
    this.type = type;
    this.seq = 0;
    this.bytes = 0;
    this.memory = [];      // used only when the store isn't persistent
    this.writes = Promise.resolve();
    this.error = null;
    this.startedAt = 0;
    this.stoppedAt = 0;

    this.videoTrack = canvas.captureStream(fps).getVideoTracks()[0];
    const stream = new MediaStream([this.videoTrack, ...audioTracks]);
    this.recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 128000,
    });
    this.recorder.ondataavailable = (e) => this.onData(e.data);
    this.recorder.onerror = (e) => {
      this.error = e.error || new Error('Recording error');
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    };
    this.stopped = new Promise((resolve) => {
      this.recorder.onstop = () => {
        this.stoppedAt = performance.now();
        this.videoTrack.stop();
        resolve();
      };
    });
  }

  onData(blob) {
    if (!blob || !blob.size) return;
    const seq = this.seq++;
    this.bytes += blob.size;
    if (!this.store.persistent) {
      this.memory.push(blob);
      return;
    }
    // Keep writes in order; if the store fails, fall back to memory for the rest.
    this.writes = this.writes.then(() => this.store.putChunk(this.id, seq, blob)).catch((err) => {
      console.warn('Chunk write failed, keeping in memory:', err);
      this.memory.push(blob);
      this.writeFailed = true;
    });
  }

  start() {
    // 1 s slices: small enough to lose little on a crash, large enough to avoid
    // the empty-chunk problem reported for very short slices on iOS.
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  get elapsed() {
    return ((this.stoppedAt || performance.now()) - this.startedAt) / 1000;
  }

  // Resolves with the finished Blob (possibly partial if an error interrupted it).
  async stop() {
    if (this.recorder.state !== 'inactive') {
      try { this.recorder.requestData?.(); } catch { /* not all engines */ }
      this.recorder.stop();
    }
    await this.stopped;
    await this.writes;
    const type = this.recorder.mimeType || this.type;
    const parts = this.store.persistent && !this.writeFailed ? await this.store.chunks(this.id) : this.memory;
    return new Blob(parts, { type });
  }
}
