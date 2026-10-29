import { DESTRUCTION_VOICES, type DestructionSoundName, type DestructionSounds } from '@spark/engine';

/**
 * The sandbox's sound files: ElevenLabs sound-effect takes, layered, trimmed
 * to their onset and leveled by tools/prepare_sfx.py into public/sfx (the
 * recipe and the generation flow are in assets/sfx/takes.json). The engine
 * knows the sounds and how each plays (`DESTRUCTION_VOICES`); the game owns
 * the files. Each has a few takes, played round-robin.
 */

export type SoundName = DestructionSoundName;

/** How each sound plays (volume, pitch variance, instances, reach): the engine's mix. */
export const VOICES = DESTRUCTION_VOICES;

/** How many takes each sound has: public/sfx/<sound>-1.mp3 onward. */
export const TAKES: Record<SoundName, number> = { boom: 4, collapse: 4, crumble: 4, crack: 3, creak: 4, thud: 4, clang: 3 };

/** The takes' URLs, under the app's base path. */
export function soundUrls(name: SoundName): string[] {
  return Array.from({ length: TAKES[name] }, (_, i) => `${import.meta.env.BASE_URL}sfx/${name}-${i + 1}.mp3`);
}

/** The arena's air: wind and a far-off city, looped under everything (silence between blasts read as broken). */
export const AIR = { url: `${import.meta.env.BASE_URL}sfx/air.wav`, volume: 0.08 };

/** What `Destruction` is given. */
export const SOUNDS: DestructionSounds = {
  takes: Object.fromEntries((Object.keys(TAKES) as SoundName[]).map((name) => [name, soundUrls(name)])),
  air: AIR,
};
