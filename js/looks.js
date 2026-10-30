// Film looks. Each value feeds the shader or the per-frame film motion in renderer.js.
// Phase 1 ships one look; Faded Home Movie and VHS arrive in Phase 3.

export const LOOKS = {
  super8: {
    id: 'super8',
    name: 'Super 8',
    era: '1970s',
    fps: 24,

    // Colour
    saturation: 0.8,
    contrast: 0.35,               // amount of gentle S-curve
    gamma: [0.9, 0.98, 1.14],     // per channel: below 1 lifts a channel, above 1 lowers it
    black: [0.08, 0.055, 0.045],  // where pure black lands (lifted, warm)
    white: [0.98, 0.93, 0.8],     // where pure white lands (creamy)

    // Optics
    softness: 1.1,                // lens blur radius, in source pixels
    halation: 0.22,               // orange glow bleeding from highlights
    halationColor: [1.0, 0.42, 0.18],
    halationRadius: 7,

    // Film stock
    grain: 0.075,
    grainSize: 1.7,               // clump size, in output pixels
    vignette: 0.5,
    cornerRadius: 0.035,          // rounded projector gate, fraction of the short side

    // Motion
    weave: 1.0,                   // gate weave (frame jitter) strength
    flicker: 0.035,               // exposure flicker per frame
    leakRate: 0.06,               // light leaks per second
    scratchRate: 0.35,            // new scratches per second
    dustRate: 2.0,                // dust specks per second
  },
};

export const DEFAULT_LOOK = 'super8';
