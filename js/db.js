// On-device storage for captures (IndexedDB). Nothing here leaves the phone.
// Recordings are written chunk by chunk while they happen, so a video survives the
// app being closed mid-recording and is rebuilt on the next launch.
// Falls back to memory only (lost on close) if IndexedDB is unavailable.

const NAME = 'vintage-cam';
const VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

class IdbStore {
  constructor(db) {
    this.db = db;
    this.persistent = true;
  }

  tx(stores, mode = 'readonly') {
    return this.db.transaction(stores, mode);
  }

  async listCaptures() {
    const all = await req(this.tx('captures').objectStore('captures').getAll());
    return all.sort((a, b) => a.takenAt - b.takenAt);
  }

  async putCapture(c) {
    const tx = this.tx('captures', 'readwrite');
    tx.objectStore('captures').put(c);
    await done(tx);
  }

  async deleteCapture(id) {
    const tx = this.tx('captures', 'readwrite');
    tx.objectStore('captures').delete(id);
    await done(tx);
  }

  async beginRecording(meta) {
    const tx = this.tx('recordings', 'readwrite');
    tx.objectStore('recordings').put(meta);
    await done(tx);
  }

  async putChunk(rec, seq, blob) {
    const tx = this.tx('chunks', 'readwrite');
    tx.objectStore('chunks').put({ rec, seq, blob });
    await done(tx);
  }

  async chunks(rec) {
    const range = IDBKeyRange.bound([rec, 0], [rec, Infinity]);
    const rows = await req(this.tx('chunks').objectStore('chunks').getAll(range));
    return rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob);
  }

  // Store the finished video and drop its chunks in one transaction.
  async finishRecording(rec, capture) {
    const tx = this.tx(['captures', 'chunks', 'recordings'], 'readwrite');
    if (capture) tx.objectStore('captures').put(capture);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([rec, 0], [rec, Infinity]));
    tx.objectStore('recordings').delete(rec);
    await done(tx);
  }

  pendingRecordings() {
    return req(this.tx('recordings').objectStore('recordings').getAll());
  }
}

class MemoryStore {
  constructor() {
    this.persistent = false;
    this.caps = new Map();
    this.chunkMap = new Map();
  }

  async listCaptures() { return [...this.caps.values()].sort((a, b) => a.takenAt - b.takenAt); }
  async putCapture(c) { this.caps.set(c.id, c); }
  async deleteCapture(id) { this.caps.delete(id); }
  async beginRecording(meta) { this.chunkMap.set(meta.id, []); }
  async putChunk(rec, seq, blob) { this.chunkMap.get(rec)?.push(blob); }
  async chunks(rec) { return this.chunkMap.get(rec) ?? []; }
  async finishRecording(rec, capture) {
    if (capture) this.caps.set(capture.id, capture);
    this.chunkMap.delete(rec);
  }
  async pendingRecordings() { return []; }
}

export async function openStore() {
  try {
    if (!window.indexedDB) throw new Error('no IndexedDB');
    const open = indexedDB.open(NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('captures', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['rec', 'seq'] });
      db.createObjectStore('recordings', { keyPath: 'id' });
    };
    const db = await req(open);
    navigator.storage?.persist?.().catch(() => {});
    return new IdbStore(db);
  } catch (err) {
    console.warn('Local gallery unavailable, keeping captures in memory:', err);
    return new MemoryStore();
  }
}

export async function storageInfo() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return quota ? { usage, quota, free: quota - usage, persisted } : null;
  } catch {
    return null;
  }
}
