// User preferences, saved on the phone (localStorage).

import { DEFAULT_PROFILE, PROFILE_ORDER, defaultAdjust } from './looks.js';
import { STAMP_DEFAULTS } from './overlay.js';

const KEY = 'prefs-v2';

export function defaultPrefs() {
  return {
    profile: DEFAULT_PROFILE,
    film: Object.fromEntries(PROFILE_ORDER.map((id) => [id, defaultAdjust(id)])),
    stamp: { ...STAMP_DEFAULTS },
    rec: true,             // burn the REC indicator into videos
    mode: 'photo',
    facing: 'environment',
    quality: '1080',
    aspect: '4:3',
    videoFormat: 'auto',
    sounds: true,
  };
}

function read(key) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
}

export function loadPrefs() {
  const d = defaultPrefs();
  const saved = read(KEY) ?? {};
  const p = { ...d, ...saved, stamp: { ...d.stamp, ...saved.stamp }, film: { ...d.film } };
  for (const id of PROFILE_ORDER) p.film[id] = { ...d.film[id], ...saved.film?.[id] };
  if (!PROFILE_ORDER.includes(p.profile)) p.profile = DEFAULT_PROFILE;
  // Carry over the two settings the first version stored.
  if (saved.stamp?.on === undefined && read('stampOn') !== undefined) p.stamp.on = !!read('stampOn');
  if (!saved.facing && read('facing')) p.facing = read('facing');
  return p;
}

export function savePrefs(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* private mode or full: settings just won't persist */ }
}
