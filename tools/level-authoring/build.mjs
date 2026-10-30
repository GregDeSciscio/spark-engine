#!/usr/bin/env node
/**
 * One command from Blender to an app (ADR-008):
 *
 *   pnpm level:street                  author the showcase's street in Blender, export, run the asset pipeline
 *   pnpm level:yard                    the same for the destruction slice's yard
 *   ... --skip-blender                 pipeline only, when the .glb is already exported
 *
 * Finds Blender through `blender.mjs` ($BLENDER, PATH, the usual Windows
 * install folder). The pipeline step bakes the navmesh beside the level (ADR-009).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from './blender.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
/** Each level: the Blender script that authors it, and the app folder it lands in. */
const LEVELS = {
  street: { script: 'street.py', out: path.join('apps', 'showcase', 'public', 'levels') },
  yard: { script: 'yard.py', out: path.join('apps', 'slice', 'public', 'levels') },
};
const name = process.argv.find((a) => a.startsWith('--level='))?.split('=')[1] ?? 'street';
const level = LEVELS[name];
if (!level) {
  console.error(`unknown level "${name}" (one of ${Object.keys(LEVELS).join(', ')})`);
  process.exit(1);
}
const SCRIPT = path.join(here, level.script);
const SRC = path.join(repoRoot, 'assets', 'source', 'levels');
const OUT = path.join(repoRoot, level.out);

const skipBlender = process.argv.includes('--skip-blender');
if (!skipBlender) {
  const blender = findBlender();
  if (!blender) {
    console.error('Blender not found: set $BLENDER or put blender on PATH, or pass --skip-blender to run the pipeline on an existing export.');
    process.exit(1);
  }
  console.log(`blender: ${blender}`);
  const r = spawnSync(blender, ['--background', '--python', SCRIPT, '--', SRC], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Only this level: the source folder holds every level, and each lands in its own app.
const p = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'asset-pipeline', 'pipeline.mjs'), `--src=${SRC}`, `--out=${OUT}`, `--only=${name}`, '--budget=prop'], { stdio: 'inherit' });
process.exit(p.status ?? 1);
