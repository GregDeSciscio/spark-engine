import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AIR, soundUrls, VOICES, type SoundName } from '../src/sounds';

describe('sounds', () => {
  it('plays every take in public/sfx, and only those', () => {
    // A take missing from the folder fails to load in the background, logged once and otherwise silent.
    const files = readdirSync(fileURLToPath(new URL('../public/sfx', import.meta.url))).sort();
    const urls = [...(Object.keys(VOICES) as SoundName[]).flatMap((name) => soundUrls(name)), AIR.url];
    const played = urls.map((url) => url.split('/').pop()!).sort();
    expect(played).toEqual(files);
  });
});
