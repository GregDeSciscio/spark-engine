import type { DestructionSoundName, DestructionSounds } from '@spark/engine';

/**
 * The destruction sandbox's sound takes (ElevenLabs takes layered and leveled
 * by apps/destruction/tools/prepare_sfx.py), served at /sfx by vite.config.ts
 * rather than copied. The engine knows how each plays; the game owns the files.
 */
const TAKES: Record<DestructionSoundName, number> = { boom: 4, collapse: 4, crumble: 4, crack: 3, creak: 4, thud: 4, clang: 3 };

export const SOUNDS: DestructionSounds = {
  takes: Object.fromEntries((Object.keys(TAKES) as DestructionSoundName[]).map((name) => [name, Array.from({ length: TAKES[name] }, (_, i) => `${import.meta.env.BASE_URL}sfx/${name}-${i + 1}.mp3`)])),
  // Wind and a far-off city under everything: silence between blasts reads as broken.
  air: { url: `${import.meta.env.BASE_URL}sfx/air.wav`, volume: 0.08 },
};
