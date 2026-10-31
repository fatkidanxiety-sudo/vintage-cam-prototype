// Film profiles. Each profile has:
//   adjust: the user-facing settings (0–100 sliders, saturation in %), editable in MENU
//   base:   fixed character of the profile (curves, chroma, motion) that the sliders sit on
// toUniforms() turns both into shader values. The grade starts neutral: the vintage feel
// comes from texture, softness, roll-off and small imperfections, not from a colour cast.

export const ADJUST_KEYS = ['warmth', 'grain', 'saturation', 'softness', 'vignette', 'tracking', 'leaks', 'scratches'];

export const PROFILES = {
  home: {
    id: 'home',
    name: 'Home Movie',
    lcd: 'HOME MOVIE',
    era: '1980s camcorder',
    fps: 30,
    adjust: { warmth: 8, grain: 22, saturation: 88, softness: 12, vignette: 14, tracking: 3, leaks: false, scratches: false },
    base: {
      black: [0.032, 0.03, 0.034],  // shadows lifted only slightly: still rich
      white: [0.99, 0.988, 0.982],  // whites stay white
      knee: 0.72, shoulder: 0.12,   // gentle highlight roll-off
      contrast: 0.12,
      halation: 0.05,
      grainClump: 0.15,             // video noise: mostly fine, per pixel
      chromaNoise: 0.45,
      chromaShift: 0.6, chromaBleed: 1.6,
      weave: 0, flicker: 0.006, corner: 0,
      leakRate: 0.05, scratchRate: 0.3, dustRate: 1.5,
    },
  },
  super8: {
    id: 'super8',
    name: 'Super 8',
    lcd: 'SUPER 8',
    era: '1970s film',
    fps: 24,
    adjust: { warmth: 16, grain: 40, saturation: 84, softness: 24, vignette: 32, tracking: 0, leaks: true, scratches: true },
    base: {
      black: [0.05, 0.043, 0.04],
      white: [0.975, 0.965, 0.94],
      knee: 0.55, shoulder: 0.3,
      contrast: 0.3,
      halation: 0.14,
      grainClump: 0.7,              // film grain: clumpy, organic
      chromaNoise: 0.15,
      chromaShift: 0, chromaBleed: 0,
      weave: 1, flicker: 0.03, corner: 0.03,
      leakRate: 0.05, scratchRate: 0.3, dustRate: 1.6,
    },
  },
  vhs: {
    id: 'vhs',
    name: 'VHS',
    lcd: 'VHS',
    era: 'late-80s tape',
    fps: 30,
    adjust: { warmth: 4, grain: 30, saturation: 80, softness: 36, vignette: 10, tracking: 22, leaks: false, scratches: false },
    base: {
      black: [0.045, 0.042, 0.05],
      white: [0.97, 0.97, 0.965],
      knee: 0.68, shoulder: 0.2,
      contrast: 0.08,
      halation: 0.04,
      grainClump: 0.05,
      chromaNoise: 0.8,
      chromaShift: 2.4, chromaBleed: 4.5,  // smeared, misregistered colour
      weave: 0, flicker: 0.01, corner: 0,
      leakRate: 0.05, scratchRate: 0.25, dustRate: 0,
    },
  },
};

export const PROFILE_ORDER = ['home', 'super8', 'vhs'];
export const DEFAULT_PROFILE = 'home';

export function defaultAdjust(id) {
  return { ...PROFILES[id].adjust };
}

// Shader and motion values for a profile plus the user's adjustments.
export function toUniforms(id, adjust) {
  const p = PROFILES[id];
  const a = { ...p.adjust, ...adjust };
  const b = p.base;
  const w = a.warmth / 100;
  const soft = a.softness / 100;
  return {
    fps: p.fps,
    wb: [1 + 0.1 * w, 1 + 0.015 * w, 1 - 0.14 * w],  // tiny white-balance shift, not an overlay
    saturation: a.saturation / 100,
    contrast: b.contrast,
    knee: b.knee,
    shoulder: b.shoulder,
    black: b.black,
    white: b.white,
    softRadius: 0.6 + soft * 4,
    softMix: Math.min(1, soft * 2.5),
    halation: b.halation,
    halationRadius: 7,
    grain: (a.grain / 100) * 0.12,
    grainClump: b.grainClump,
    grainSize: 1.6,
    chromaNoise: b.chromaNoise,
    chromaShift: b.chromaShift,
    chromaBleed: b.chromaBleed,
    vignette: (a.vignette / 100) * 0.8,
    corner: b.corner,
    tracking: a.tracking / 100,
    weave: b.weave,
    flicker: b.flicker,
    leakRate: a.leaks ? b.leakRate : 0,
    scratchRate: a.scratches ? b.scratchRate : 0,
    dustRate: a.scratches ? b.dustRate : 0,
  };
}
