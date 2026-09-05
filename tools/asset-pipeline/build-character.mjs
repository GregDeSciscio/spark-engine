#!/usr/bin/env node
/**
 * Build a game character from a config file:
 *
 *   node tools/asset-pipeline/build-character.mjs [--config=<path.json>] [--retarget] [--no-pipeline] [--verbose]
 *
 * The config (default assets/source/characters/operator.character.json) names
 * the character, its `spark.*` extras, the clip renames (library clip → engine
 * name, loop flag) and, when the model is not the clip library's own rig, a
 * `retarget` section that tools/level-authoring/character.py runs in Blender:
 * source library, target model, bone map, hips, foot reparenting, footstep
 * clips. `--retarget` runs Blender; otherwise the last retarget export is used.
 *
 * With a retarget, Blender writes one GLB per clip (Blender 5.1 flattens
 * multi-action exports) and they are merged here. Either way the clips are
 * renamed, bone names lose their dots (three's loader would strip them), loops
 * and the root-motion bone get `spark.*` extras, the footstep markers from
 * the retarget become `spark.events`, and the asset pipeline writes
 * <publicDir>/<name>.glb.
 *
 * The game's rig config (bone names, masks, ragdoll) must agree with the bone
 * names in the config; for the showcase that is apps/showcase/src/actors/rig.ts.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { runBlender } from '../level-authoring/blender.mjs';
import { runPipeline } from './pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const RETARGET_SCRIPT = path.join(repoRoot, 'tools', 'level-authoring', 'character.py');
export const DEFAULT_CONFIG = 'assets/source/characters/operator.character.json';

/** Read and validate a character config; paths become absolute. */
export async function loadConfig(configPath = DEFAULT_CONFIG) {
  const file = path.resolve(repoRoot, configPath);
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  for (const key of ['name', 'clips', 'rootBone', 'publicDir']) if (!cfg[key]) throw new Error(`${configPath}: missing "${key}"`);
  if (!cfg.retarget && !cfg.model) throw new Error(`${configPath}: needs "model" (a glTF with the clips) or "retarget"`);
  const abs = (p) => path.resolve(repoRoot, p);
  return {
    file,
    name: cfg.name,
    source: cfg.source ?? '',
    budget: cfg.budget ?? 'enemy',
    rootBone: cfg.rootBone,
    clips: cfg.clips,
    publicDir: abs(cfg.publicDir),
    outDir: path.dirname(file),
    model: cfg.model ? abs(cfg.model) : null,
    retarget: cfg.retarget ? { ...cfg.retarget, library: abs(cfg.retarget.library), target: abs(cfg.retarget.target), out: abs(cfg.retarget.out) } : null,
  };
}

export async function buildCharacter({ log = console.log, config = DEFAULT_CONFIG, retarget = false, pipeline = true, verbose = false } = {}) {
  const cfg = await loadConfig(config);
  const CLIPS = cfg.clips;
  if (cfg.retarget && retarget) {
    const status = runBlender(RETARGET_SCRIPT, [cfg.file]);
    if (status !== 0) throw new Error(`retarget failed (blender exit ${status})`);
  }
  const src = cfg.retarget ? cfg.retarget.out : cfg.model;
  const spec = { src, root: cfg.rootBone, out: cfg.name, source: cfg.source };
  const OUT = path.join(cfg.outDir, `${spec.out}.glb`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = spec.src.endsWith('.gltf') || spec.src.endsWith('.glb') ? await io.read(spec.src) : await mergeClipFiles(io, spec.src, log);
  const root = doc.getRoot();

  // Blender suffixes a retargeted action with .001 when the source action holds the plain name.
  const byName = new Map(root.listAnimations().map((a) => [a.getName().replace(/\.\d{3}$/, ''), a]));
  // Foot-contact markers the retarget wrote next to the clip files (`events.json`), keyed by library clip name.
  const events = await readEvents(spec.src);
  const wanted = new Set(Object.values(CLIPS).map((c) => c.from));
  for (const [name, anim] of byName) if (!wanted.has(name)) anim.dispose();
  for (const [name, clip] of Object.entries(CLIPS)) {
    const anim = byName.get(clip.from);
    if (!anim) throw new Error(`clip "${clip.from}" (for ${name}) not in ${path.relative(repoRoot, spec.src)}`);
    anim.setName(name).setExtras({ 'spark.loop': clip.loop, 'spark.source': clip.from });
    // A clip whose every channel has one key is a pose, not an animation: the retarget export lost its keys.
    const keys = Math.max(0, ...anim.listSamplers().map((s) => s.getInput()?.getCount() ?? 0));
    if (keys < 2) throw new Error(`clip "${clip.from}" (for ${name}) has ${keys} key(s) per channel; the export is static`);
    const markers = events[clip.from];
    if (markers && markers.length > 0) anim.setExtras({ ...anim.getExtras(), 'spark.events': markers });
  }
  const withEvents = Object.keys(CLIPS).filter((n) => (events[CLIPS[n].from] ?? []).length > 0);
  if (withEvents.length > 0) log(`  footstep markers on ${withEvents.join(', ')}`);

  // Rigify names carry dots (DEF-spine.001, DEF-hand.R); three's glTF loader strips
  // those (PropertyBinding reserves them), which would leave the bone names in
  // apps/showcase/src/actors/rig.ts pointing at nothing. Make them loader-proof here.
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (name.includes('.')) node.setName(name.replace(/\./g, '_'));
  }
  const rootJoint = root.listNodes().find((n) => n.getName() === spec.root);
  if (!rootJoint) throw new Error(`no "${spec.root}" joint`);
  rootJoint.setExtras({ 'spark.rootBone': true });
  const scene = root.listScenes()[0];
  const top = scene.listChildren()[0];
  top.setExtras({ 'spark.type': 'character', 'spark.budget': cfg.budget, 'spark.source': spec.source });
  root.setExtras({ 'spark.source': spec.source });

  if (verbose) {
    const walk = (n, d) => {
      log(`${'  '.repeat(d)}${n.getName()} t=${n.getTranslation().map((v) => v.toFixed(3)).join(',')}`);
      for (const c of n.listChildren()) walk(c, d + 1);
    };
    for (const child of scene.listChildren()) walk(child, 0);
  }

  await mkdir(cfg.outDir, { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(OUT, glb);
  log(`wrote ${path.relative(repoRoot, OUT)} (${(glb.byteLength / 1024).toFixed(0)} KiB, ${Object.keys(CLIPS).length} clips)`);
  if (!pipeline) return OUT;
  const ok = await runPipeline({ src: cfg.outDir, out: cfg.publicDir, only: spec.out, budget: cfg.budget, verbose, log });
  if (!ok) throw new Error('asset pipeline failed');
  return path.join(cfg.publicDir, `${spec.out}.glb`);
}

/** `<dir>/events.json` from the retarget, or nothing for a plain glTF source. */
async function readEvents(src) {
  if (src.endsWith('.gltf') || src.endsWith('.glb')) return {};
  try {
    return JSON.parse(await readFile(path.join(src, 'events.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Read a folder of single-clip GLBs of the same model and return one document
 * carrying every clip: the first file is the model, each file's one animation
 * is copied over by re-targeting its channels onto nodes of the same name.
 */
export async function mergeClipFiles(io, dir, log) {
  const files = (await readdir(dir)).filter((n) => n.endsWith('.glb')).sort();
  if (files.length === 0) throw new Error(`no clip files in ${path.relative(repoRoot, dir)}; run with --retarget`);
  const base = await io.read(path.join(dir, files[0]));
  for (const anim of base.getRoot().listAnimations()) anim.dispose();
  const nodes = new Map(base.getRoot().listNodes().map((n) => [n.getName(), n]));
  const buffer = base.getRoot().listBuffers()[0] ?? base.createBuffer();
  for (const file of files) {
    const clipDoc = await io.read(path.join(dir, file));
    const source = clipDoc.getRoot().listAnimations()[0];
    if (!source) throw new Error(`${file}: no animation`);
    const anim = base.createAnimation(path.basename(file, '.glb'));
    for (const channel of source.listChannels()) {
      const target = nodes.get(channel.getTargetNode()?.getName() ?? '');
      if (!target) continue;
      const s = channel.getSampler();
      const input = base.createAccessor().setType('SCALAR').setArray(s.getInput().getArray().slice()).setBuffer(buffer);
      const output = base.createAccessor().setType(s.getOutput().getType()).setArray(s.getOutput().getArray().slice()).setBuffer(buffer);
      if (s.getOutput().getNormalized()) output.setNormalized(true);
      const sampler = base.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation());
      const ch = base.createAnimationChannel().setTargetNode(target).setTargetPath(channel.getTargetPath()).setSampler(sampler);
      anim.addSampler(sampler).addChannel(ch);
    }
  }
  log(`merged ${files.length} clip file(s) from ${path.relative(repoRoot, dir)}`);
  return base;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const configArg = argv.find((a) => a.startsWith('--config='));
  buildCharacter({
    config: configArg ? configArg.slice(9) : DEFAULT_CONFIG,
    retarget: argv.includes('--retarget'),
    pipeline: !argv.includes('--no-pipeline'),
    verbose: argv.includes('--verbose'),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
