#!/usr/bin/env node
/**
 * Offline asset pipeline (kickoff section 4). Every .glb/.gltf in assets/source/
 * goes through:
 *
 *   normalize   dedup, prune (extras kept), weld, resample, unit-scale / Y-up bake where detectable
 *   meshopt     EXT_meshopt_compression + KHR_mesh_quantization via meshoptimizer's encoder
 *   ktx2        Basis Universal textures via `toktx` when KTX-Software is on PATH (else warn + skip)
 *   validate    triangle counts and texture sizes against the kickoff budgets (section 21),
 *               plus a listing of every node carrying spark.* extras and COL_ collision nodes
 *
 * and lands in apps/benchmark/public/models/<name>.glb. The Basis transcoder
 * three needs at runtime is copied into apps/benchmark/public/libs/basis/.
 *
 *   pnpm assets [--only=<name>] [--dry-run] [--verbose] [--budget=hero|enemy|prop]
 *               [--src=assets/source] [--out=apps/benchmark/public/models]
 *
 * Exit code 1 if any file failed to process. Budget violations are reported,
 * never fatal: the budgets are guidelines (section 21), and an asset can be
 * over budget on purpose while a real one is on the way.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { clearNodeTransform, dedup, getBounds, getTextureColorSpace, inspect, listTextureSlots, meshopt, prune, resample, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export const DEFAULT_SRC = path.join(repoRoot, 'assets', 'source');
export const DEFAULT_OUT = path.join(repoRoot, 'apps', 'benchmark', 'public', 'models');
export const BASIS_SRC = path.join(repoRoot, 'packages', 'engine', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
export const BASIS_OUT = path.join(repoRoot, 'apps', 'benchmark', 'public', 'libs', 'basis');
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

/** Kickoff section 21. Triangle counts are per rendered scene; texture sizes are the longest edge. */
export const BUDGETS = {
  hero: { triangles: [60_000, 150_000], texture: [2048, 4096] },
  enemy: { triangles: [20_000, 60_000], texture: [1024, 2048] },
  prop: { triangles: [1_000, 50_000], texture: [512, 2048] },
};

/** Uniform root scales that mean "the exporter used the wrong unit". */
const UNIT_SCALES = [0.01, 0.001, 0.0254, 100, 1000];

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

// ---- tools ---------------------------------------------------------------------

export function detectToktx() {
  try {
    const result = spawnSync('toktx', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || 'toktx';
  } catch {
    return null;
  }
}

/** Copy the Basis transcoder three's KTX2Loader fetches at runtime. Idempotent (size compare). */
export async function copyBasisTranscoder(log) {
  await mkdir(BASIS_OUT, { recursive: true });
  let copied = 0;
  for (const file of BASIS_FILES) {
    const src = path.join(BASIS_SRC, file);
    const dst = path.join(BASIS_OUT, file);
    const srcStat = await stat(src);
    const dstStat = await stat(dst).catch(() => null);
    if (dstStat && dstStat.size === srcStat.size) continue;
    await copyFile(src, dst);
    copied++;
  }
  log(`basis transcoder: ${copied ? `copied ${copied} file(s)` : 'up to date'} -> ${rel(BASIS_OUT)}`);
}

// ---- transforms ---------------------------------------------------------------

function rel(p) {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

/**
 * Bake obvious exporter artefacts on root nodes into the geometry:
 * a ±90° rotation about X (Z-up scene exported without conversion) and a
 * uniform unit scale. Anything else is a deliberate transform and stays.
 */
function normalizeRoots(doc) {
  const notes = [];
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      const [sx, sy, sz] = node.getScale();
      const [qx, qy, qz, qw] = node.getRotation();
      const uniform = approx(sx, sy) && approx(sy, sz);
      const unitScale = uniform && UNIT_SCALES.some((u) => approx(sx, u, u * 0.01));
      const zUpBake = approx(Math.abs(qx), Math.SQRT1_2, 1e-3) && approx(qy, 0, 1e-3) && approx(qz, 0, 1e-3) && approx(Math.abs(qw), Math.SQRT1_2, 1e-3);
      if (!unitScale && !zUpBake) continue;
      const what = [unitScale ? `unit scale ${sx}` : null, zUpBake ? 'Z-up rotation' : null].filter(Boolean).join(' + ');
      clearNodeTransform(node);
      notes.push(`baked ${what} on root node "${node.getName() || '(unnamed)'}"`);
    }
  }
  return notes;
}

/** Encode PNG/JPEG textures to KTX2 with toktx. Normal/metal-rough maps get UASTC, colour maps ETC1S. */
async function encodeKTX2(doc, log, verbose) {
  const textures = doc.getRoot().listTextures().filter((t) => /^image\/(png|jpeg)$/.test(t.getMimeType()));
  if (textures.length === 0) return { encoded: 0, skipped: 0 };
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spark-ktx2-'));
  let encoded = 0;
  let skipped = 0;
  try {
    const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
    for (const texture of textures) {
      const slots = listTextureSlots(texture);
      const isData = slots.some((s) => /normal|metallicRoughness|occlusion/i.test(s));
      const mode = isData ? 'uastc' : 'etc1s';
      const srgb = getTextureColorSpace(texture) === 'srgb';
      const name = (texture.getName() || `texture_${encoded + skipped}`).replace(/[^\w.-]/g, '_');
      const input = path.join(tmp, `${name}.${texture.getMimeType() === 'image/png' ? 'png' : 'jpg'}`);
      const output = path.join(tmp, `${name}.ktx2`);
      await writeFile(input, texture.getImage());
      const args = ['--t2', '--genmipmap', '--encode', mode, '--assign_oetf', srgb ? 'srgb' : 'linear'];
      if (mode === 'uastc') args.push('--uastc_quality', '2', '--zcmp', '18');
      else args.push('--clevel', '1', '--qlevel', '128');
      args.push(output, input);
      const result = spawnSync('toktx', args, { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) {
        log(`  warn: toktx failed for ${name} (${(result.stderr || '').trim().split(/\r?\n/)[0]}), leaving ${texture.getMimeType()}`);
        skipped++;
        continue;
      }
      texture.setImage(new Uint8Array(await readFile(output))).setMimeType('image/ktx2');
      if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.(png|jpe?g)$/i, '.ktx2'));
      encoded++;
      if (verbose) log(`  ktx2: ${name} -> ${mode} (${srgb ? 'srgb' : 'linear'}, slots ${slots.join(',') || 'none'})`);
    }
    if (encoded === 0) basisu.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { encoded, skipped };
}

// ---- validation -----------------------------------------------------------------

function findBudgetExtra(doc) {
  for (const node of doc.getRoot().listNodes()) {
    const value = node.getExtras()['spark.budget'];
    if (typeof value === 'string' && value in BUDGETS) return value;
  }
  for (const scene of doc.getRoot().listScenes()) {
    const value = scene.getExtras()['spark.budget'];
    if (typeof value === 'string' && value in BUDGETS) return value;
  }
  return null;
}

export function chooseBudget(doc, name, flag) {
  if (flag && flag in BUDGETS) return { budget: flag, source: '--budget flag' };
  const extra = findBudgetExtra(doc);
  if (extra) return { budget: extra, source: 'spark.budget extra' };
  if (/^hero[-_]/i.test(name)) return { budget: 'hero', source: 'file name prefix' };
  if (/^enemy[-_]/i.test(name)) return { budget: 'enemy', source: 'file name prefix' };
  return { budget: 'prop', source: 'default' };
}

function budgetStatus(value, [min, max]) {
  if (value > max) return 'OVER';
  if (value < min) return 'LOW';
  return 'OK';
}

function nodePath(node) {
  const parts = [node.getName() || '(unnamed)'];
  let parent = node.getParentNode();
  while (parent) {
    parts.unshift(parent.getName() || '(unnamed)');
    parent = parent.getParentNode();
  }
  return parts.join('/');
}

export function validate(doc, { name, budget, budgetSource }) {
  const report = inspect(doc);
  const lines = [];
  const warnings = [];
  const budgets = BUDGETS[budget];

  // Triangles: unique per mesh and as rendered (× instances).
  let uniqueTriangles = 0;
  let sceneTriangles = 0;
  let vertices = 0;
  for (const mesh of report.meshes.properties) {
    const tris = mesh.mode.every((m) => m === 'TRIANGLES' || m === 'TRIANGLE_STRIP' || m === 'TRIANGLE_FAN') ? mesh.glPrimitives : 0;
    uniqueTriangles += tris;
    sceneTriangles += tris * Math.max(1, mesh.instances);
    vertices += mesh.vertices;
  }
  const triStatus = budgetStatus(sceneTriangles, budgets.triangles);
  lines.push(
    `  triangles: ${fmt(sceneTriangles)} rendered (${fmt(uniqueTriangles)} unique, ${fmt(vertices)} vertices) vs ${budget} budget ${fmt(budgets.triangles[0])}-${fmt(budgets.triangles[1])} [${triStatus}]`,
  );
  if (triStatus === 'OVER') warnings.push(`triangles over ${budget} budget: ${fmt(sceneTriangles)} > ${fmt(budgets.triangles[1])}`);

  for (const mesh of report.meshes.properties) {
    lines.push(`    mesh ${mesh.name || '(unnamed)'}: ${fmt(mesh.glPrimitives)} prims, ${fmt(mesh.vertices)} verts, x${mesh.instances}, ${kib(mesh.size)}, [${mesh.attributes.join(' ')}]`);
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const flipped of checkWinding(mesh)) warnings.push(flipped);
  }

  // Textures.
  if (report.textures.properties.length === 0) {
    lines.push('  textures: none');
  } else {
    lines.push(`  textures: ${report.textures.properties.length} vs ${budget} budget ${budgets.texture[0]}-${budgets.texture[1]} px`);
    for (const tex of report.textures.properties) {
      const [w, h] = tex.resolution.split('x').map(Number);
      const edge = Math.max(w || 0, h || 0);
      const status = budgetStatus(edge, budgets.texture);
      lines.push(`    ${tex.name || tex.uri || '(unnamed)'}: ${tex.resolution} ${tex.mimeType} ${kib(tex.size)} slots=[${tex.slots.join(',')}] [${status}]`);
      if (status === 'OVER') warnings.push(`texture ${tex.name || tex.uri} over ${budget} budget: ${edge}px > ${budgets.texture[1]}px`);
      if (!tex.mimeType.includes('ktx2')) warnings.push(`texture ${tex.name || tex.uri} is ${tex.mimeType}, not KTX2 (toktx unavailable or skipped)`);
    }
  }

  // Materials, animations.
  lines.push(`  materials: ${report.materials.properties.length}, animations: ${report.animations.properties.length}${report.animations.properties.length ? ` (${report.animations.properties.map((a) => a.name || '(unnamed)').join(', ')})` : ''}`);

  // spark.* extras and COL_ nodes (ADR-008).
  const sparkNodes = [];
  const collisionNodes = [];
  for (const node of doc.getRoot().listNodes()) {
    const extras = node.getExtras();
    const spark = Object.entries(extras).filter(([k]) => k.startsWith('spark.'));
    if (spark.length) sparkNodes.push({ path: nodePath(node), spark });
    if ((node.getName() || '').startsWith('COL_')) collisionNodes.push({ path: nodePath(node), mesh: node.getMesh()?.getName() ?? null });
  }
  lines.push(`  spark.* nodes: ${sparkNodes.length}`);
  for (const n of sparkNodes) lines.push(`    ${n.path}: ${n.spark.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
  lines.push(`  collision (COL_) nodes: ${collisionNodes.length}`);
  for (const n of collisionNodes) lines.push(`    ${n.path}${n.mesh ? ` (mesh ${n.mesh})` : ' (no mesh!)'}`);
  for (const n of collisionNodes) if (!n.mesh) warnings.push(`collision node ${n.path} has no mesh`);

  // Scale sanity.
  for (const scene of doc.getRoot().listScenes()) {
    const { min, max } = getBounds(scene);
    const size = max.map((v, i) => v - min[i]);
    const extent = Math.max(...size);
    lines.push(`  bounds: ${size.map((v) => v.toFixed(2)).join(' x ')} m (min ${min.map((v) => v.toFixed(2)).join(',')})`);
    if (extent > 500) warnings.push(`scene extent ${extent.toFixed(0)} m looks like centimetres or millimetres; check export units`);
    if (extent > 0 && extent < 0.01) warnings.push(`scene extent ${extent.toFixed(4)} m looks like the export was scaled down; check export units`);
  }

  lines.unshift(`  budget: ${budget} (${budgetSource})`);
  return { lines, warnings, triangles: sceneTriangles, name };
}

/**
 * Winding audit: compare each triangle's geometric normal against its vertex
 * normals. glTF is counter-clockwise; a primitive where most faces disagree was
 * exported inside-out. WebGPU culls those as back faces (they render dark or
 * vanish), while three's WebGL backend can mask it, so catch it here.
 */
function checkWinding(mesh) {
  const warnings = [];
  mesh.listPrimitives().forEach((prim, index) => {
    if (prim.getMode() !== 4) return; // TRIANGLES only
    const position = prim.getAttribute('POSITION');
    const normal = prim.getAttribute('NORMAL');
    const indices = prim.getIndices();
    if (!position || !normal) return;
    const count = indices ? indices.getCount() : position.getCount();
    const vertex = (i) => (indices ? indices.getScalar(i) : i);
    const a = [];
    const b = [];
    const c = [];
    const n = [];
    let agree = 0;
    let disagree = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      position.getElement(vertex(t), a);
      position.getElement(vertex(t + 1), b);
      position.getElement(vertex(t + 2), c);
      normal.getElement(vertex(t), n);
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      const fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx;
      const dot = fx * n[0] + fy * n[1] + fz * n[2];
      if (Math.abs(dot) < 1e-12) continue; // degenerate (poles, slivers)
      if (dot > 0) agree++;
      else disagree++;
    }
    const total = agree + disagree;
    if (total === 0) return;
    if (disagree > agree) {
      warnings.push(`mesh ${mesh.getName() || '(unnamed)'} primitive ${index}: winding looks inverted (${disagree}/${total} faces oppose their vertex normals)`);
    } else if (disagree > total * 0.1) {
      warnings.push(`mesh ${mesh.getName() || '(unnamed)'} primitive ${index}: mixed winding (${disagree}/${total} faces oppose their vertex normals)`);
    }
  });
  return warnings;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

// ---- driver -------------------------------------------------------------------------

export async function processFile({ io, file, outDir, budgetFlag, dryRun, verbose, toktxVersion, log }) {
  const name = path.basename(file).replace(/\.(glb|gltf)$/i, '');
  const inputBytes = (await stat(file)).size;
  const doc = await io.read(file);
  doc.setLogger(new Logger(verbose ? Logger.Verbosity.DEBUG : Logger.Verbosity.WARN));
  log(`\n== ${rel(file)} (${kib(inputBytes)})`);

  const notes = normalizeRoots(doc);
  for (const note of notes) log(`  normalize: ${note}`);
  if (notes.length === 0 && verbose) log('  normalize: units and up-axis look right, nothing baked');

  await doc.transform(
    dedup(),
    prune({ keepExtras: true, keepLeaves: false }),
    weld(),
    resample(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  log('  transform: dedup, prune(keepExtras), weld, resample, meshopt(medium)');

  if (toktxVersion) {
    const { encoded, skipped } = await encodeKTX2(doc, log, verbose);
    log(`  ktx2: ${encoded} texture(s) encoded${skipped ? `, ${skipped} skipped` : ''} (${toktxVersion})`);
  } else if (doc.getRoot().listTextures().length > 0) {
    log(`  ktx2: SKIPPED, toktx not on PATH (install KTX-Software); ${doc.getRoot().listTextures().length} texture(s) stay as PNG/JPEG`);
  }

  const { budget, source } = chooseBudget(doc, name, budgetFlag);
  const result = validate(doc, { name, budget, budgetSource: source });
  for (const line of result.lines) log(line);
  for (const w of result.warnings) log(`  warn: ${w}`);

  const outFile = path.join(outDir, `${name}.glb`);
  const bytes = await io.writeBinary(doc);
  if (dryRun) {
    log(`  dry-run: would write ${rel(outFile)} (${kib(bytes.byteLength)}, ${((bytes.byteLength / inputBytes) * 100).toFixed(0)}% of source)`);
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, bytes);
    log(`  wrote ${rel(outFile)} (${kib(bytes.byteLength)}, ${((bytes.byteLength / inputBytes) * 100).toFixed(0)}% of source)`);
  }
  return { name, outFile, bytes: bytes.byteLength, warnings: result.warnings };
}

/** Run the whole pipeline. Returns true when every file processed (budget warnings do not count as failure). */
export async function runPipeline(options = {}) {
  const src = path.resolve(repoRoot, options.src ?? DEFAULT_SRC);
  const outDir = path.resolve(repoRoot, options.out ?? DEFAULT_OUT);
  const only = options.only ? String(options.only).replace(/\.(glb|gltf)$/i, '') : null;
  const dryRun = Boolean(options.dryRun);
  const verbose = Boolean(options.verbose);
  const log = options.log ?? ((line) => console.log(line));

  const toktxVersion = detectToktx();
  log(`spark asset pipeline: ${rel(src)} -> ${rel(outDir)}${dryRun ? ' (dry run)' : ''}`);
  log(`  meshopt encoder: meshoptimizer wasm; toktx: ${toktxVersion ?? 'not found (KTX2 encoding will be skipped)'}`);
  if (!dryRun) await copyBasisTranscoder(log);

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  });

  const entries = (await readdir(src).catch(() => [])).filter((f) => /\.(glb|gltf)$/i.test(f)).sort();
  const files = entries.filter((f) => !only || f.replace(/\.(glb|gltf)$/i, '') === only).map((f) => path.join(src, f));
  if (files.length === 0) {
    log(only ? `no source file named "${only}" in ${rel(src)}` : `no .glb/.gltf files in ${rel(src)} (run make-test-assets.mjs for samples)`);
    return true;
  }

  const results = [];
  let failed = 0;
  for (const file of files) {
    try {
      results.push(await processFile({ io, file, outDir, budgetFlag: options.budget, dryRun, verbose, toktxVersion, log }));
    } catch (error) {
      failed++;
      log(`\n== ${rel(file)}: FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }

  const total = results.reduce((n, r) => n + r.bytes, 0);
  const warnings = results.reduce((n, r) => n + r.warnings.length, 0);
  log(`\n${results.length} asset(s) ${dryRun ? 'validated' : 'written'}, ${kib(total)} total, ${warnings} warning(s), ${failed} failed`);
  return failed === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ok = await runPipeline({
    src: args.src,
    out: args.out,
    only: args.only,
    dryRun: Boolean(args['dry-run']),
    verbose: Boolean(args.verbose),
    budget: typeof args.budget === 'string' ? args.budget : undefined,
  });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
