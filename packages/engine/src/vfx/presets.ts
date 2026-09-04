import type { ParticleEmitterDescriptorInput } from './descriptor';

/**
 * Plain descriptor objects. Scenes spread and tweak them:
 * `vfx.spawnEmitter(eid, { ...PARTICLE_PRESETS.sparks, capacity: 2048 })`
 * or pass the preset name and override fields as the third argument.
 */
export const PARTICLE_PRESETS = {
  /**
   * Rain: a wrapping volume of velocity-stretched streaks centred on the
   * emitter. Move the emitter entity with the camera target; the volume
   * follows and the streaks wrap. No splashes.
   */
  rain: {
    capacity: 100_000,
    rate: 0,
    prewarm: true,
    wrap: { size: [40, 24, 40] },
    lifetime: [1e6, 1e6],
    shape: { kind: 'box', size: [40, 24, 40] },
    space: 'world',
    direction: [0.05, -1, 0.02],
    speed: [14, 20],
    spread: 0.01,
    gravity: 0,
    drag: 0,
    wind: [0, 0, 0],
    size: [0.02, 0.03],
    sizeOverLife: [[0, 1], [1, 1]],
    colorOverLife: [
      [0, 0.72, 0.8, 1.0, 0.26],
      [1, 0.72, 0.8, 1.0, 0.26],
    ],
    render: { kind: 'sprite', blend: 'alpha', shape: 'streak', stretch: 0.018, fog: true },
    seed: 11,
  },

  /** Sparks: burst-driven, gravity, additive, short-lived, velocity streaks. */
  sparks: {
    capacity: 1024,
    rate: 0,
    lifetime: [0.35, 0.9],
    shape: { kind: 'cone', radius: 0.03, angle: 0.55 },
    space: 'world',
    direction: 'shape',
    speed: [4, 11],
    spread: 0.15,
    gravity: -14,
    drag: 0.8,
    size: [0.03, 0.05],
    sizeOverLife: [[0, 1], [0.7, 0.9], [1, 0.2]],
    colorOverLife: [
      [0, 12, 8, 3, 1],
      [0.3, 8, 3.2, 0.6, 1],
      [1, 2.4, 0.5, 0.05, 0],
    ],
    render: { kind: 'sprite', blend: 'additive', shape: 'streak', stretch: 0.012, fog: false },
    seed: 23,
  },

  /** Smoke: slow, alpha-blended, grows and fades, curls with noise. Soft against geometry. */
  smoke: {
    capacity: 384,
    rate: 26,
    lifetime: [3.5, 5.5],
    shape: { kind: 'sphere', radius: 0.18 },
    space: 'world',
    direction: [0, 1, 0],
    speed: [0.7, 1.2],
    spread: 0.25,
    gravity: 0,
    drag: 0.35,
    wind: [0.35, 0.9, 0.1],
    noise: { strength: 1.4, frequency: 0.6, speed: 0.25 },
    size: [0.7, 1.1],
    sizeOverLife: [[0, 0.35], [0.4, 1.0], [1, 2.6]],
    colorOverLife: [
      [0, 0.22, 0.22, 0.24, 0],
      [0.12, 0.26, 0.26, 0.28, 0.42],
      [0.6, 0.2, 0.2, 0.22, 0.2],
      [1, 0.16, 0.16, 0.18, 0],
    ],
    rotation: [0.2, 0.6],
    render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 0.8, fog: true },
    seed: 37,
  },

  /** Steam: like smoke but brighter, faster and shorter. */
  steam: {
    capacity: 256,
    rate: 32,
    lifetime: [2.2, 3.4],
    shape: { kind: 'cone', radius: 0.12, angle: 0.35 },
    space: 'world',
    direction: 'shape',
    speed: [1.6, 2.6],
    spread: 0.15,
    gravity: 0,
    drag: 0.9,
    wind: [0.25, 1.1, 0.05],
    noise: { strength: 1.8, frequency: 0.9, speed: 0.4 },
    size: [0.35, 0.55],
    sizeOverLife: [[0, 0.3], [0.35, 1.0], [1, 2.2]],
    colorOverLife: [
      [0, 0.6, 0.66, 0.78, 0],
      [0.1, 0.62, 0.68, 0.8, 0.5],
      [0.55, 0.55, 0.6, 0.72, 0.28],
      [1, 0.5, 0.55, 0.66, 0],
    ],
    rotation: [0.4, 1.2],
    render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 0.6, fog: true },
    seed: 41,
  },

  /** Embers: slow drifting additive motes rising from a source, curling in noise. */
  embers: {
    capacity: 512,
    rate: 55,
    lifetime: [3.5, 7],
    shape: { kind: 'sphere', radius: 0.45 },
    space: 'world',
    direction: [0, 1, 0],
    speed: [0.4, 1.3],
    spread: 0.35,
    gravity: 0.15,
    drag: 0.4,
    wind: [0.3, 1.0, 0.15],
    noise: { strength: 2.2, frequency: 1.1, speed: 0.6 },
    size: [0.035, 0.07],
    sizeOverLife: [[0, 0.6], [0.2, 1.0], [1, 0.3]],
    colorOverLife: [
      [0, 6, 2.2, 0.4, 0],
      [0.1, 7, 2.6, 0.5, 1],
      [0.6, 4, 1.0, 0.15, 0.9],
      [1, 1.2, 0.2, 0.02, 0],
    ],
    render: { kind: 'sprite', blend: 'additive', shape: 'disc', fog: true },
    seed: 53,
  },

  /** Muzzle flash: one-shot burst of a few large, very short additive sprites. `burst()` it. */
  muzzleFlash: {
    capacity: 64,
    rate: 0,
    lifetime: [0.05, 0.09],
    shape: { kind: 'cone', radius: 0.02, angle: 0.5 },
    space: 'local',
    direction: 'shape',
    speed: [2, 9],
    spread: 0.2,
    gravity: 0,
    drag: 6,
    size: [0.25, 0.55],
    sizeOverLife: [[0, 0.4], [0.3, 1.0], [1, 1.4]],
    colorOverLife: [
      [0, 14, 9, 4, 1],
      [0.5, 10, 5, 1.5, 0.8],
      [1, 4, 1.5, 0.3, 0],
    ],
    rotation: [2, 8],
    render: { kind: 'sprite', blend: 'additive', shape: 'disc', fog: false },
    seed: 67,
  },
} as const satisfies Record<string, ParticleEmitterDescriptorInput>;

export type ParticlePresetName = keyof typeof PARTICLE_PRESETS;

export const PARTICLE_PRESET_NAMES: readonly ParticlePresetName[] = Object.keys(PARTICLE_PRESETS) as ParticlePresetName[];

export function isParticlePresetName(name: string): name is ParticlePresetName {
  return Object.prototype.hasOwnProperty.call(PARTICLE_PRESETS, name);
}
