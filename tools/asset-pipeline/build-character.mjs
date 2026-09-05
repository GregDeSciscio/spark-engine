#!/usr/bin/env node
/**
 * Build the showcase's character from Quaternius' Universal Animation Library
 * (CC0; the free tier, mirrored as glTF at
 * https://github.com/J-Ponzo/gltf-universal-animation-library):
 *
 *   node tools/asset-pipeline/build-character.mjs [--no-pipeline] [--verbose]
 *
 * The library ships one 1.83 m mannequin on a Rigify DEF- skeleton (53
 * joints) with 46 clips. This keeps the clips the showcase graphs use, renames
 * them to the engine's conventions (`idle`, `walk`, `run`, `hit`, `death`,
 * ... see CLIPS), replaces the dots in bone names with underscores (three's
 * loader would strip them), marks loops and the root-motion bone with `spark.*` extras,
 * writes assets/source/characters/operator.glb and runs the asset pipeline on
 * it into apps/showcase/public/models/operator.glb.
 *
 * The rig's bone names, masks and ragdoll shape live in
 * apps/showcase/src/actors/rig.ts; the two must agree.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { runPipeline } from './pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SRC = path.join(repoRoot, 'assets', 'source', 'characters', 'ual', 'AnimationLibrary_Godot_Standard.gltf');
const OUT_DIR = path.join(repoRoot, 'assets', 'source', 'characters');
const OUT = path.join(OUT_DIR, 'operator.glb');
const PUBLIC = path.join(repoRoot, 'apps', 'showcase', 'public', 'models');

/** Engine clip name → library clip, and whether it loops. */
export const CLIPS = {
  idle: { from: 'Idle_Loop', loop: true },
  walk: { from: 'Walk_Loop', loop: true },
  run: { from: 'Jog_Fwd_Loop', loop: true },
  sprint: { from: 'Sprint_Loop', loop: true },
  crouch_idle: { from: 'Crouch_Idle_Loop', loop: true },
  crouch_walk: { from: 'Crouch_Fwd_Loop', loop: true },
  /** Weapon held, relaxed: the upper-body pose whenever the operator is not aiming. */
  ready: { from: 'Pistol_Idle_Loop', loop: true },
  /** Aim poses for the pitch blend; short static clips. */
  aim_up: { from: 'Pistol_Aim_Up', loop: true },
  aim: { from: 'Pistol_Aim_Neutral', loop: true },
  aim_down: { from: 'Pistol_Aim_Down', loop: true },
  reload: { from: 'Pistol_Reload', loop: false },
  hit: { from: 'Hit_Chest', loop: false },
  hit_head: { from: 'Hit_Head', loop: false },
  death: { from: 'Death01', loop: false },
  jump: { from: 'Jump_Loop', loop: true },
  land: { from: 'Jump_Land', loop: false },
};

export async function buildCharacter({ log = console.log, pipeline = true, verbose = false } = {}) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(SRC);
  const root = doc.getRoot();

  const byName = new Map(root.listAnimations().map((a) => [a.getName(), a]));
  const wanted = new Set(Object.values(CLIPS).map((c) => c.from));
  for (const [name, anim] of byName) if (!wanted.has(name)) anim.dispose();
  for (const [name, spec] of Object.entries(CLIPS)) {
    const anim = byName.get(spec.from);
    if (!anim) throw new Error(`clip "${spec.from}" (for ${name}) not in ${path.relative(repoRoot, SRC)}`);
    anim.setName(name).setExtras({ 'spark.loop': spec.loop, 'spark.source': spec.from });
  }

  // Rigify names carry dots (DEF-spine.001, DEF-hand.R); three's glTF loader strips
  // those (PropertyBinding reserves them), which would leave the bone names in
  // apps/showcase/src/actors/rig.ts pointing at nothing. Make them loader-proof here.
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (name.includes('.')) node.setName(name.replace(/\./g, '_'));
  }
  const rootJoint = root.listNodes().find((n) => n.getName() === 'root');
  if (!rootJoint) throw new Error('no "root" joint');
  rootJoint.setExtras({ 'spark.rootBone': true });
  const scene = root.listScenes()[0];
  const rig = scene.listChildren()[0];
  rig.setExtras({ 'spark.type': 'character', 'spark.budget': 'enemy', 'spark.source': 'Quaternius Universal Animation Library (CC0)' });
  root.setExtras({ 'spark.source': 'Quaternius Universal Animation Library, standard tier (CC0)' });

  if (verbose) {
    const walk = (n, d) => {
      log(`${'  '.repeat(d)}${n.getName()} t=${n.getTranslation().map((v) => v.toFixed(3)).join(',')}`);
      for (const c of n.listChildren()) walk(c, d + 1);
    };
    walk(rig, 0);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(OUT, glb);
  log(`wrote ${path.relative(repoRoot, OUT)} (${(glb.byteLength / 1024).toFixed(0)} KiB, ${Object.keys(CLIPS).length} clips)`);
  if (!pipeline) return OUT;
  const ok = await runPipeline({ src: OUT_DIR, out: PUBLIC, only: 'operator', budget: 'enemy', verbose, log });
  if (!ok) throw new Error('asset pipeline failed');
  return path.join(PUBLIC, 'operator.glb');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  buildCharacter({ pipeline: !argv.includes('--no-pipeline'), verbose: argv.includes('--verbose') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
