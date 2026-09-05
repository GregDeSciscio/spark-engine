#!/usr/bin/env node
/**
 * One command from Blender to the showcase (ADR-008):
 *
 *   pnpm level:street            author in Blender, export, run the asset pipeline
 *   pnpm level:street --skip-blender   pipeline only, when the .glb is already exported
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
const SCRIPT = path.join(here, 'street.py');
const SRC = path.join(repoRoot, 'assets', 'source', 'levels');
const OUT = path.join(repoRoot, 'apps', 'showcase', 'public', 'levels');

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

const p = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'asset-pipeline', 'pipeline.mjs'), `--src=${SRC}`, `--out=${OUT}`, '--budget=prop'], { stdio: 'inherit' });
process.exit(p.status ?? 1);
