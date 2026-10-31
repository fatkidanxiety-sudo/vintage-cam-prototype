// The MENU sheet. Built from a schema so every visible control maps to a real setting.
// Paths: "adj.x" is the current profile's adjustment, anything else is a prefs key
// (dots for nesting, e.g. "stamp.clock").

import { PROFILES, PROFILE_ORDER } from './looks.js';
import { DATE_FORMATS } from './overlay.js';

const SAMPLE = new Date(2026, 9, 30, 19, 40);

export function schema(support) {
  const fmt = (id) => [id, DATE_FORMATS[id](SAMPLE)];
  return [
    { title: 'Film', items: [
      { path: 'profile', type: 'segment', options: PROFILE_ORDER.map((id) => [id, PROFILES[id].name]) },
      { path: 'adj.warmth', type: 'range', label: 'Warmth (− cool, + warm)', min: -100, max: 100 },
      { path: 'adj.grain', type: 'range', label: 'Grain', min: 0, max: 100 },
      { path: 'adj.saturation', type: 'range', label: 'Saturation', min: 0, max: 150, unit: '%' },
      { path: 'adj.softness', type: 'range', label: 'Softness', min: 0, max: 100 },
      { path: 'adj.vignette', type: 'range', label: 'Vignette', min: 0, max: 100 },
      { path: 'adj.tracking', type: 'range', label: 'Tracking distortion', min: 0, max: 100 },
      { path: 'adj.leaks', type: 'toggle', label: 'Light leaks' },
      { path: 'adj.scratches', type: 'toggle', label: 'Scratches and dust' },
      { type: 'note', text: 'Press and hold the picture to compare with the original camera image.' },
      { type: 'action', id: 'resetProfile', label: 'Reset this profile' },
    ] },
    { title: 'Date and time', items: [
      { path: 'stamp.on', type: 'toggle', label: 'Show date and time' },
      { path: 'stamp.clock', type: 'segment', options: [['12', '12-hour'], ['24', '24-hour']] },
      { path: 'stamp.dateFormat', type: 'select', label: 'Date format', options: Object.keys(DATE_FORMATS).map(fmt) },
      { path: 'stamp.position', type: 'select', label: 'Position', options: [['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']] },
      { path: 'stamp.size', type: 'segment', label: 'Size', options: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] },
      { path: 'stamp.color', type: 'segment', label: 'Colour', options: [['white', 'Off-white'], ['orange', 'Pale orange']] },
      { path: 'stamp.shadow', type: 'toggle', label: 'Shadow for readability' },
      { path: 'rec', type: 'toggle', label: 'REC indicator in videos' },
      { type: 'info', id: 'zone' },
    ] },
    { title: 'Camera', items: [
      { path: 'facing', type: 'segment', label: 'Camera', options: [['environment', 'Back'], ['user', 'Front']] },
      { path: 'quality', type: 'segment', label: 'Resolution', options: [['720', '720p'], ['1080', '1080p'], ['4k', '4K']] },
      { type: 'note', text: '4K gives sharper photos but may run slowly, especially while recording.' },
      { path: 'aspect', type: 'segment', label: 'Frame', options: [['4:3', '4:3 classic'], ['16:9', '16:9 wide']] },
      { path: 'videoFormat', type: 'segment', label: 'Video file', options: [
        ['auto', 'Auto'],
        ['mp4', support.mp4 ? 'MP4' : 'MP4 (n/a)'],
        ['webm', support.webm ? 'WebM' : 'WebM (n/a)'],
      ] },
      { type: 'info', id: 'videoSupport' },
    ] },
    { title: 'Sound', items: [
      { path: 'sounds', type: 'toggle', label: 'Button clicks (follows the silent switch)' },
    ] },
    { title: 'Saving', items: [
      { path: 'autoSave', type: 'toggle', label: 'Open the Save sheet after each capture' },
      { type: 'note', text: 'Web apps can’t put files in your camera roll silently. iOS needs one tap: choose Save Image or Save Video in the sheet. If the sheet doesn’t open by itself, tap SAVE on the preview.' },
    ] },
    { title: 'Storage', items: [
      { type: 'info', id: 'storage' },
      { type: 'action', id: 'openGallery', label: 'Open gallery' },
      { type: 'note', text: 'Photos and videos are kept in this app on your iPhone until you save or share them. Nothing is uploaded.' },
      { type: 'info', id: 'version' },
    ] },
  ];
}

export function buildSettings(root, { prefs, support, onChange, onAction, getInfo }) {
  const get = (path) => {
    if (path.startsWith('adj.')) return prefs.film[prefs.profile][path.slice(4)];
    return path.split('.').reduce((o, k) => o?.[k], prefs);
  };
  const set = (path, value) => {
    if (path.startsWith('adj.')) prefs.film[prefs.profile][path.slice(4)] = value;
    else {
      const keys = path.split('.');
      const last = keys.pop();
      keys.reduce((o, k) => o[k], prefs)[last] = value;
    }
    onChange(path, value);
    refresh();
  };

  const refreshers = [];
  const infos = [];
  root.textContent = '';
  let uid = 0;

  for (const section of schema(support)) {
    const sec = el('section', 'set-section');
    sec.append(el('h3', 'set-title', section.title));
    for (const item of section.items) {
      const row = el('div', `set-row set-${item.type}`);
      const id = `set-${uid++}`;
      if (item.type === 'range') {
        const label = el('label', 'set-label', item.label);
        label.htmlFor = id;
        const value = el('output', 'set-value');
        const input = el('input');
        Object.assign(input, { type: 'range', id, min: item.min, max: item.max, step: 1 });
        input.addEventListener('input', () => set(item.path, Number(input.value)));
        row.append(label, value, input);
        refreshers.push(() => {
          input.value = get(item.path);
          value.textContent = `${get(item.path)}${item.unit ?? ''}`;
        });
      } else if (item.type === 'toggle') {
        const btn = el('button', 'set-toggle');
        btn.type = 'button';
        btn.setAttribute('role', 'switch');
        btn.append(el('span', 'set-label', item.label), el('span', 'switch-track'));
        btn.addEventListener('click', () => set(item.path, !get(item.path)));
        row.append(btn);
        refreshers.push(() => btn.setAttribute('aria-checked', String(!!get(item.path))));
      } else if (item.type === 'segment') {
        if (item.label) row.append(el('span', 'set-label', item.label));
        const group = el('div', 'segment');
        group.setAttribute('role', 'radiogroup');
        if (item.label) group.setAttribute('aria-label', item.label);
        const buttons = item.options.map(([value, text]) => {
          const b = el('button', null, text);
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.dataset.value = value;
          if (item.path === 'videoFormat' && value !== 'auto' && !support[value]) b.disabled = true;
          b.addEventListener('click', () => set(item.path, value));
          group.append(b);
          return b;
        });
        row.append(group);
        refreshers.push(() => {
          for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(get(item.path))));
        });
      } else if (item.type === 'select') {
        const label = el('label', 'set-label', item.label);
        label.htmlFor = id;
        const select = el('select');
        select.id = id;
        for (const [value, text] of item.options) select.append(new Option(text, value));
        select.addEventListener('change', () => set(item.path, select.value));
        row.append(label, select);
        refreshers.push(() => { select.value = get(item.path); });
      } else if (item.type === 'action') {
        const b = el('button', 'btn', item.label);
        b.type = 'button';
        b.addEventListener('click', () => onAction(item.id));
        row.append(b);
      } else if (item.type === 'note') {
        row.append(el('p', 'set-note', item.text));
      } else if (item.type === 'info') {
        const p = el('p', 'set-note');
        row.append(p);
        infos.push(async () => { p.textContent = await getInfo(item.id); });
      }
      sec.append(row);
    }
    root.append(sec);
  }

  // Info lines (storage, time zone) are only re-read when asked, not on every slider tick.
  function refresh(withInfo = false) {
    for (const r of refreshers) r();
    if (withInfo) for (const r of infos) r();
  }
  refresh(true);
  return { refresh };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
