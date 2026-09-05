#!/usr/bin/env node
/**
 * Fetch CC0 models from Poly Haven into assets/source/props/ as self-contained
 * GLBs, ready for the asset pipeline:
 *
 *   node tools/asset-pipeline/fetch-polyhaven.mjs [--res=1k] [--force] <id> [<id> ...]
 *   node tools/asset-pipeline/fetch-polyhaven.mjs --kit=street     # the showcase's street kit
 *
 * Uses the public API (https://api.polyhaven.com): the files manifest names a
 * .gltf and the .bin and textures it includes; those are downloaded into a
 * temp folder, read with gltf-transform and written out as one .glb. Every
 * asset is CC0 (https://polyhaven.com/license); attribution is still recorded
 * in assets/source/props/SOURCES.md because it is the decent thing to do.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Props above this many triangles are decimated toward `SIMPLIFY_TARGET`. The
 * kickoff prop budget is 1k-50k, but these are street dressing seen from an
 * over-the-shoulder camera, never close-ups: 8k with 1k textures is plenty,
 * and a level places dozens of them.
 */
const SIMPLIFY_ABOVE = 12_000;
const SIMPLIFY_TARGET = 8_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const OUT = path.join(repoRoot, 'assets', 'source', 'props');
const API = 'https://api.polyhaven.com';

/** The showcase street's dressing: everything from Poly Haven's hidden-alley and lighthouse collections that belongs on a wet street. */
export const KITS = {
  street: [
    'fire_hydrant',
    'metal_trash_can',
    'trashbag',
    'barrel_03',
    'barrel_stove',
    'concrete_road_barrier',
    'old_tyre',
    'street_lamp_01',
    'utility_box_01',
    'water_manhole_cover',
    'cardboard_box_01',
    'plastic_crate_03',
    'power_box_01',
    'portable_generator',
  ],
};

function parseArgs(argv) {
  const args = { ids: [], res: '1k', force: false, kit: null };
  for (const raw of argv) {
    if (raw.startsWith('--res=')) args.res = raw.slice(6);
    else if (raw === '--force') args.force = true;
    else if (raw.startsWith('--kit=')) args.kit = raw.slice(6);
    else if (!raw.startsWith('--')) args.ids.push(raw);
  }
  if (args.kit) {
    const kit = KITS[args.kit];
    if (!kit) throw new Error(`unknown kit "${args.kit}"; kits: ${Object.keys(KITS).join(', ')}`);
    args.ids.push(...kit);
  }
  return args;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
}

export async function fetchModel(id, { res = '1k', force = false, log = console.log } = {}) {
  const outFile = path.join(OUT, `${id}.glb`);
  if (!force) {
    try {
      const s = await stat(outFile);
      if (s.size > 0) {
        log(`  ${id}: already fetched (${(s.size / 1024).toFixed(0)} KiB), skip (--force to refetch)`);
        return { id, file: outFile, skipped: true };
      }
    } catch {
      // not there yet
    }
  }
  const info = await fetchJson(`${API}/info/${id}`);
  const files = await fetchJson(`${API}/files/${id}`);
  const entry = files.gltf?.[res]?.gltf;
  if (!entry) throw new Error(`${id}: no gltf at ${res} (have ${Object.keys(files.gltf ?? {}).join(', ')})`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), `polyhaven-${id}-`));
  try {
    const gltfFile = path.join(tmp, path.basename(new URL(entry.url).pathname));
    await download(entry.url, gltfFile);
    let bytes = entry.size ?? 0;
    for (const [rel, part] of Object.entries(entry.include ?? {})) {
      await download(part.url, path.join(tmp, rel));
      bytes += part.size ?? 0;
    }
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(gltfFile);
    const triangles = countTriangles(doc);
    let simplified = '';
    if (triangles > SIMPLIFY_ABOVE) {
      await MeshoptSimplifier.ready;
      const ratio = SIMPLIFY_TARGET / triangles;
      // A loose error bound: these are decimated for distance, and 1 percent of the bounds is invisible from the street.
      await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }));
      simplified = `, simplified ${triangles.toLocaleString()} → ${countTriangles(doc).toLocaleString()} tris`;
    }
    doc.getRoot().setExtras({ ...(doc.getRoot().getExtras() ?? {}), 'spark.source': `Poly Haven ${id} (CC0)`, 'spark.budget': 'prop' });
    await mkdir(OUT, { recursive: true });
    const glb = await io.writeBinary(doc);
    await writeFile(outFile, glb);
    log(`  ${id}: ${info.name} by ${(info.authors ? Object.keys(info.authors) : []).join(', ') || 'Poly Haven'}; ${(bytes / 1024 / 1024).toFixed(1)} MiB fetched → ${(glb.byteLength / 1024).toFixed(0)} KiB glb${simplified}`);
    return { id, file: outFile, skipped: false, name: info.name, authors: info.authors ? Object.keys(info.authors) : [] };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += (idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
    }
  }
  return Math.round(n);
}

async function writeSources(results) {
  const file = path.join(OUT, 'SOURCES.md');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = '# Prop sources\n\nEvery model here is CC0 from [Poly Haven](https://polyhaven.com/models) (https://polyhaven.com/license), fetched by `tools/asset-pipeline/fetch-polyhaven.mjs`. Attribution is optional under CC0; listed anyway.\n\n| id | name | authors |\n| --- | --- | --- |\n';
  }
  const lines = results.filter((r) => !r.skipped).map((r) => `| ${r.id} | ${r.name ?? r.id} | ${(r.authors ?? []).join(', ') || 'Poly Haven'} |`);
  const missing = lines.filter((l) => !existing.includes(l.split(' | ')[0]));
  if (missing.length > 0) await writeFile(file, `${existing.trimEnd()}\n${missing.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ids.length === 0) {
    console.error('usage: fetch-polyhaven.mjs [--res=1k] [--force] --kit=street | <id> [<id> ...]');
    process.exit(1);
  }
  console.log(`fetching ${args.ids.length} model(s) at ${args.res} into ${path.relative(repoRoot, OUT)}`);
  const results = [];
  let failed = 0;
  for (const id of args.ids) {
    try {
      results.push(await fetchModel(id, { res: args.res, force: args.force }));
    } catch (error) {
      failed += 1;
      console.error(`  ${id}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await writeSources(results);
  console.log(`${results.length} ok, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
