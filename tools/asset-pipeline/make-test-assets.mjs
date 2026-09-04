#!/usr/bin/env node
/**
 * Procedurally generate small, real test assets into assets/source/ so the
 * pipeline (and the `assets` benchmark scene) have something to chew on:
 *
 *   crate.glb             textured 1 m box: baseColor + normal map (pngjs), spark.type=prop
 *   prop-pipe.glb         low-poly cylinder cluster, one shared mesh, five nodes
 *   hero-placeholder.glb  capsule with two spark.* nodes (spawn, prop), a COL_ collision
 *                         node, and one short animation clip
 *
 *   node tools/asset-pipeline/make-test-assets.mjs [--out=assets/source] [--no-pipeline]
 *
 * Then runs the pipeline on them unless --no-pipeline is given. Deterministic:
 * a seeded PRNG drives the noise, so re-running writes byte-identical files.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

// ---- deterministic noise ----------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a lattice of `cells` × `cells`, sampled at `size` × `size`. */
function valueNoise(size, cells, seed) {
  const rand = mulberry32(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const out = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx);
      const tx = smooth(fx - x0);
      const l = (cx, cy) => lattice[((cy % cells) + cells) % cells * cells + (((cx % cells) + cells) % cells)];
      const a = l(x0, y0) * (1 - tx) + l(x0 + 1, y0) * tx;
      const b = l(x0, y0 + 1) * (1 - tx) + l(x0 + 1, y0 + 1) * tx;
      out[y * size + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function fbm(size, seed) {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let cells = 4;
  for (let octave = 0; octave < 4; octave++) {
    const n = valueNoise(size, cells, seed + octave * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    amp *= 0.5;
    cells *= 2;
  }
  return out;
}

function pngBytes(size, fill) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * size + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png, { deflateLevel: 9 }));
}

/** Wood-ish crate base colour: planks with grain noise and darker checker seams. */
function crateBaseColor(size) {
  const grain = fbm(size, 7);
  return pngBytes(size, (x, y) => {
    const plank = Math.floor((y / size) * 4);
    const seam = y % (size / 4) < 3 || x % (size / 2) < 3 || x === size - 1 || y === size - 1;
    const checker = (Math.floor((x / size) * 2) + plank) % 2 === 0 ? 1 : 0.86;
    const g = grain[y * size + x];
    let r = 150 + g * 70;
    let gg = 100 + g * 45;
    let b = 55 + g * 25;
    if (seam) {
      r *= 0.35;
      gg *= 0.35;
      b *= 0.35;
    }
    return [Math.round(r * checker), Math.round(gg * checker), Math.round(b * checker)];
  });
}

/** Tangent-space normal map derived from a height field of bumps + seams. */
function crateNormalMap(size) {
  const height = fbm(size, 99);
  const h = (x, y) => {
    const xx = ((x % size) + size) % size;
    const yy = ((y % size) + size) % size;
    const seam = yy % (size / 4) < 3 || xx % (size / 2) < 3 ? -0.6 : 0;
    return height[yy * size + xx] * 0.5 + seam;
  };
  const strength = 6;
  return pngBytes(size, (x, y) => {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
    const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const len = Math.hypot(dx, dy, 1);
    const nx = -dx / len;
    const ny = -dy / len;
    const nz = 1 / len;
    return [Math.round((nx * 0.5 + 0.5) * 255), Math.round((ny * 0.5 + 0.5) * 255), Math.round((nz * 0.5 + 0.5) * 255)];
  });
}

// ---- geometry builders --------------------------------------------------------

function box(size) {
  const s = size / 2;
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((f, fi) => {
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [cu, cv] of corners) {
      positions.push(
        f.n[0] * s + f.u[0] * s * cu + f.v[0] * s * cv,
        f.n[1] * s + f.u[1] * s * cu + f.v[1] * s * cv,
        f.n[2] * s + f.u[2] * s * cu + f.v[2] * s * cv,
      );
      normals.push(...f.n);
      uvs.push(cu * 0.5 + 0.5, 1 - (cv * 0.5 + 0.5));
    }
    const b = fi * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions, normals, uvs, indices };
}

/** Closed cylinder along Y, centred at origin. */
function cylinder(radius, height, segments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const half = height / 2;
  // side
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const y of [-half, half]) {
      positions.push(c * radius, y, s * radius);
      normals.push(c, 0, s);
      uvs.push(i / segments, y > 0 ? 0 : 1);
    }
  }
  for (let i = 0; i < segments; i++) {
    // Counter-clockwise seen from outside: bottom_i, top_i, bottom_i+1 / top_i, top_i+1, bottom_i+1.
    const b = i * 2;
    indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  // caps
  for (const [y, ny] of [
    [half, 1],
    [-half, -1],
  ]) {
    const centre = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, ny, 0);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      normals.push(0, ny, 0);
      uvs.push(Math.cos(a) * 0.5 + 0.5, Math.sin(a) * 0.5 + 0.5);
    }
    for (let i = 0; i < segments; i++) {
      const a = centre + 1 + i;
      const b = centre + 1 + ((i + 1) % segments);
      if (ny > 0) indices.push(centre, b, a);
      else indices.push(centre, a, b);
    }
  }
  return { positions, normals, uvs, indices };
}

/** Capsule along Y: hemisphere caps of `radius`, straight section `length`. */
function capsule(radius, length, radial, capRings, heightSegments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const rows = [];
  // Rows from top pole down: top cap (lat 0..90), cylinder, bottom cap (lat 90..180).
  for (let i = 0; i <= capRings; i++) {
    const lat = (i / capRings) * (Math.PI / 2);
    rows.push({ y: length / 2 + Math.cos(lat) * radius, r: Math.sin(lat) * radius, ny: Math.cos(lat), nr: Math.sin(lat) });
  }
  for (let i = 1; i < heightSegments; i++) {
    const y = length / 2 - (i / heightSegments) * length;
    rows.push({ y, r: radius, ny: 0, nr: 1 });
  }
  for (let i = 0; i <= capRings; i++) {
    const lat = Math.PI / 2 + (i / capRings) * (Math.PI / 2);
    rows.push({ y: -length / 2 + Math.cos(lat) * radius, r: Math.sin(lat) * radius, ny: Math.cos(lat), nr: Math.sin(lat) });
  }
  const total = radius * 2 + length;
  rows.forEach((row, ri) => {
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      positions.push(c * row.r, row.y, s * row.r);
      const nx = c * row.nr;
      const nz = s * row.nr;
      const len = Math.hypot(nx, row.ny, nz) || 1;
      normals.push(nx / len, row.ny / len, nz / len);
      uvs.push(j / radial, 1 - (row.y + total / 2) / total);
    }
    if (ri > 0) {
      const stride = radial + 1;
      for (let j = 0; j < radial; j++) {
        const a = (ri - 1) * stride + j;
        const b = ri * stride + j;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  });
  return { positions, normals, uvs, indices };
}

// ---- glTF assembly ------------------------------------------------------------

function addPrimitive(doc, buffer, geo, material, name) {
  const position = doc.createAccessor(`${name}_pos`).setType('VEC3').setArray(new Float32Array(geo.positions)).setBuffer(buffer);
  const normal = doc.createAccessor(`${name}_nrm`).setType('VEC3').setArray(new Float32Array(geo.normals)).setBuffer(buffer);
  const uv = doc.createAccessor(`${name}_uv`).setType('VEC2').setArray(new Float32Array(geo.uvs)).setBuffer(buffer);
  const IndexArray = geo.positions.length / 3 > 65535 ? Uint32Array : Uint16Array;
  const indices = doc.createAccessor(`${name}_idx`).setType('SCALAR').setArray(new IndexArray(geo.indices)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setAttribute('TEXCOORD_0', uv).setIndices(indices);
  if (material) prim.setMaterial(material);
  return doc.createMesh(name).addPrimitive(prim);
}

function makeCrate() {
  const doc = new Document();
  doc.createBuffer('crate');
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.createScene('Scene');
  const size = 256;
  const baseColor = doc.createTexture('crate_basecolor').setImage(crateBaseColor(size)).setMimeType('image/png');
  const normal = doc.createTexture('crate_normal').setImage(crateNormalMap(size)).setMimeType('image/png');
  const material = doc
    .createMaterial('crate_wood')
    .setBaseColorTexture(baseColor)
    .setNormalTexture(normal)
    .setNormalScale(1)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);
  const mesh = addPrimitive(doc, buffer, box(1), material, 'crate');
  const node = doc.createNode('crate').setMesh(mesh).setExtras({ 'spark.type': 'prop', 'spark.budget': 'prop', 'spark.prop': 'crate' });
  scene.addChild(node);
  return doc;
}

function makePipes() {
  const doc = new Document();
  doc.createBuffer('pipes');
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.createScene('Scene');
  const material = doc.createMaterial('pipe_steel').setBaseColorFactor([0.55, 0.57, 0.6, 1]).setMetallicFactor(1).setRoughnessFactor(0.35);
  const mesh = addPrimitive(doc, buffer, cylinder(0.12, 2.4, 12), material, 'pipe');
  const root = doc.createNode('prop-pipe').setExtras({ 'spark.type': 'prop', 'spark.prop': 'pipe-cluster' });
  scene.addChild(root);
  // Five pipes: three upright, two lying across. Shared mesh, so the pipeline's
  // dedup/prune leave one mesh referenced by five nodes.
  const layout = [
    { t: [-0.4, 1.2, 0], r: [0, 0, 0, 1] },
    { t: [0, 1.2, 0.25], r: [0, 0, 0, 1] },
    { t: [0.4, 1.2, 0], r: [0, 0, 0, 1] },
    { t: [0, 0.14, 0.9], r: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
    { t: [0, 0.14, -0.6], r: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  ];
  layout.forEach((p, i) => {
    root.addChild(doc.createNode(`pipe_${i}`).setMesh(mesh).setTranslation(p.t).setRotation(p.r));
  });
  return doc;
}

function makeHero() {
  const doc = new Document();
  doc.createBuffer('hero');
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.createScene('Scene');
  const skin = doc.createMaterial('hero_placeholder').setBaseColorFactor([0.85, 0.3, 0.25, 1]).setMetallicFactor(0.1).setRoughnessFactor(0.5);
  // ~20k triangles: enough to exercise meshopt, deliberately under the 60k hero floor
  // so the validator's "LOW" note has something to say.
  const body = addPrimitive(doc, buffer, capsule(0.4, 1.0, 96, 48, 8), skin, 'hero_body');
  const collision = addPrimitive(doc, buffer, capsule(0.42, 1.0, 8, 3, 1), null, 'COL_hero_capsule');

  const root = doc.createNode('hero-placeholder').setExtras({ 'spark.budget': 'hero' });
  scene.addChild(root);
  const bodyNode = doc.createNode('hero_body').setMesh(body).setTranslation([0, 0.9, 0]);
  root.addChild(bodyNode);
  root.addChild(doc.createNode('COL_hero_capsule').setMesh(collision).setTranslation([0, 0.9, 0]));
  root.addChild(doc.createNode('spawn_point').setTranslation([0, 0, 0.6]).setExtras({ 'spark.type': 'spawn', 'spark.team': 'player' }));
  const anchor = doc
    .createNode('prop_anchor')
    .setTranslation([0.6, 1.4, 0])
    .setExtras({ 'spark.type': 'prop', 'spark.prop': 'crate', 'spark.scale': 0.25 });
  root.addChild(anchor);

  // One short clip: the anchor bobs. Exercises `resample` and ModelAsset.animations.
  const times = doc.createAccessor('bob_t').setType('SCALAR').setArray(new Float32Array([0, 0.25, 0.5, 0.75, 1.0])).setBuffer(buffer);
  const values = doc
    .createAccessor('bob_v')
    .setType('VEC3')
    .setArray(new Float32Array([0.6, 1.4, 0, 0.6, 1.5, 0, 0.6, 1.6, 0, 0.6, 1.5, 0, 0.6, 1.4, 0]))
    .setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(times).setOutput(values).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(anchor).setTargetPath('translation').setSampler(sampler);
  doc.createAnimation('anchor_bob').addSampler(sampler).addChannel(channel);
  return doc;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(repoRoot, String(args.out ?? 'assets/source'));
  await mkdir(outDir, { recursive: true });
  const io = new NodeIO();
  const models = [
    ['crate.glb', makeCrate],
    ['prop-pipe.glb', makePipes],
    ['hero-placeholder.glb', makeHero],
  ];
  for (const [file, build] of models) {
    const doc = build();
    doc.getRoot().getAsset().generator = 'spark-engine make-test-assets';
    const target = path.join(outDir, file);
    await io.write(target, doc);
    const bytes = (await io.writeBinary(doc)).byteLength;
    console.log(`wrote ${path.relative(repoRoot, target)} (${(bytes / 1024).toFixed(1)} KiB)`);
  }
  if (!args['no-pipeline']) {
    const { runPipeline } = await import('./pipeline.mjs');
    const ok = await runPipeline({ src: outDir, verbose: Boolean(args.verbose) });
    if (!ok) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
