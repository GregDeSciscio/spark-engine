/**
 * Load a game's audio manifest module for the tools. The manifest is an ES
 * module exporting `CUES` (see apps/showcase/audio/manifest.mjs for the
 * shape), and optionally `LUFS`, `VOICE_SEARCH` and `PATHS` ({ raw, out },
 * repo-relative). `--manifest=<path>` on either tool selects it; the default
 * is the showcase's.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const DEFAULT_MANIFEST = 'apps/showcase/audio/manifest.mjs';

const DEFAULT_LUFS = { sfx: -18, ui: -20, ambience: -26, voice: -19, music: -16 };
const DEFAULT_VOICE_SEARCH = { gender: 'male', keywords: ['deep'] };

export function manifestArg(argv) {
  const flag = argv.find((a) => a.startsWith('--manifest='));
  return flag ? flag.slice(11) : DEFAULT_MANIFEST;
}

export function pathArg(argv, name) {
  const flag = argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : null;
}

/** Import the manifest and resolve its paths; `overrides` are the --raw / --out flags. */
export async function loadManifest(manifestPath = DEFAULT_MANIFEST, overrides = {}) {
  const file = path.resolve(repoRoot, manifestPath);
  const mod = await import(pathToFileURL(file).href);
  if (!Array.isArray(mod.CUES)) throw new Error(`${manifestPath}: expected an exported CUES array`);
  const paths = mod.PATHS ?? {};
  const raw = path.resolve(repoRoot, overrides.raw ?? paths.raw ?? 'assets/source/audio/raw');
  const out = path.resolve(repoRoot, overrides.out ?? paths.out ?? path.join(path.dirname(manifestPath), 'public', 'audio'));
  return {
    file,
    cues: mod.CUES,
    lufs: { ...DEFAULT_LUFS, ...(mod.LUFS ?? {}) },
    voiceSearch: mod.VOICE_SEARCH ?? DEFAULT_VOICE_SEARCH,
    raw,
    out,
  };
}
