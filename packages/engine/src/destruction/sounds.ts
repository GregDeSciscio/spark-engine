/**
 * What destruction sounds like, as data. The engine ships no audio: a game
 * hands `Destruction` the URLs of its takes (`DestructionOptions.sounds`), and
 * with none it is silent. The sounds are a blast, the crumble of a chunk
 * coming apart, the crack of glue letting go, the groan of a structure near
 * its limit (THE FINALS' "creaking" tell), the thud of rubble landing, the
 * roar of a lot of it coming down at once, and the clang of something slung
 * on ropes hitting something. Each has a few takes, played round-robin.
 */

export const DESTRUCTION_SOUND_NAMES = ['boom', 'crumble', 'crack', 'creak', 'thud', 'collapse', 'clang'] as const;

export type DestructionSoundName = (typeof DESTRUCTION_SOUND_NAMES)[number];

/**
 * How one sound plays: base volume (takes are expected to be leveled alike,
 * so these are the balance), ± semitones of pitch per play, how many may
 * sound at once, and its reach: the distance (m) it is heard at full volume,
 * falling off as reach / distance past it.
 */
export interface DestructionVoice {
  readonly volume: number;
  readonly pitchVariance: number;
  readonly maxInstances: number;
  readonly reach: number;
}

/**
 * The mix. A destruction scene is watched from 15–40 m, and a building coming
 * down is not a point 1 m across (the engine's default reference distance),
 * so reach goes with how big the source is: at 1 m a blast 20 m away sat at
 * −26 dB in the first measured mix.
 */
export const DESTRUCTION_VOICES: Readonly<Record<DestructionSoundName, DestructionVoice>> = {
  boom: { volume: 2, pitchVariance: 1, maxInstances: 4, reach: 14 },
  collapse: { volume: 1.4, pitchVariance: 1, maxInstances: 2, reach: 30 },
  crumble: { volume: 1, pitchVariance: 2, maxInstances: 6, reach: 10 },
  crack: { volume: 0.9, pitchVariance: 2, maxInstances: 6, reach: 8 },
  creak: { volume: 0.8, pitchVariance: 1.5, maxInstances: 2, reach: 12 },
  thud: { volume: 1.2, pitchVariance: 2, maxInstances: 8, reach: 10 },
  clang: { volume: 1.3, pitchVariance: 1.5, maxInstances: 3, reach: 14 },
};

/** The game's sound files for `Destruction`. */
export interface DestructionSounds {
  /** Each sound's takes, played round-robin. A sound with none stays silent. */
  readonly takes: Partial<Record<DestructionSoundName, readonly string[]>>;
  /**
   * A looped bed under everything, on the ambience bus (wind, a far-off city:
   * silence between blasts read as broken). Starts with the scene; the engine
   * holds it until audio unlocks on the first gesture.
   */
  readonly air?: { readonly url: string; readonly volume: number } | undefined;
}
