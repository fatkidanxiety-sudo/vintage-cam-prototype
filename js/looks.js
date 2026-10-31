// Film profiles. Each profile has:
//   adjust: the user-facing settings (sliders, saturation in %, warmth −100…100), editable in MENU
//   base:   fixed character of the profile (curves, chroma, motion) that the sliders sit on
// toUniforms() turns both into shader values.
// Home Movie is matched to real 1980s camcorder footage: cool white balance, lifted
// blue-grey shadows, low tape resolution (softer sideways than vertically), cool
// bloom on whites and colour bleeding past edges.

// Bump when profile defaults change so phones drop the old saved slider values.
export const LOOKS_VERSION = 2;

export const ADJUST_KEYS = ['warmth', 'grain', 'saturation', 'softness', 'vignette', 'tracking', 'leaks', 'scratches'];

export const PROFILES = {
  home: {
    id: 'home',
    name: 'Home Movie',
    lcd: 'HOME MOVIE',
    era: '1980s camcorder',
    fps: 30,
    adjust: { warmth: -50, grain: 20, saturation: 98, softness: 68, vignette: 10, tracking: 5, leaks: false, scratches: false },
    base: {
      black: [0.085, 0.095, 0.125], // lifted, bluish shadows (measured ~93,104,127 in the reference)
      white: [0.94, 0.93, 1.0],     // whites lean lavender/blue
      knee: 0.68, shoulder: 0.28,   // soft, glowing highlight roll-off
      contrast: 0,
      halation: 0.14,               // cool bloom around whites
      halationColor: [0.9, 0.95, 1.0],
      softV: 0.45,                  // tape loses more detail sideways than vertically
      grainClump: 0.1,              // video noise: mostly fine, per pixel
      chromaNoise: 0.5,
      chromaShift: 1.2, chromaBleed: 3.2,
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
      halationColor: [1.0, 0.82, 0.7],
      softV: 1,
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
      halationColor: [1.0, 0.95, 0.9],
      softV: 0.5,
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
    wb: [1 + 0.1 * w, 1 + 0.015 * w, 1 - 0.14 * w],  // white-balance shift; negative warmth = cooler
    saturation: a.saturation / 100,
    contrast: b.contrast,
    knee: b.knee,
    shoulder: b.shoulder,
    black: b.black,
    white: b.white,
    softRadius: 0.6 + soft * 4,
    softMix: Math.min(1, soft * 2.5),
    halation: b.halation,
    halationColor: b.halationColor,
    halationRadius: 7,
    softV: b.softV,
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
