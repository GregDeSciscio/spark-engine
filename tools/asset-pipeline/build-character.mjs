#!/usr/bin/env node
/**
 * Build the showcase's character (all CC0, see assets/source/characters/SOURCES.md):
 *
 *   node tools/asset-pipeline/build-character.mjs [--rig=cyberpunk|ual] [--retarget] [--no-pipeline] [--verbose]
 *
 * Clips come from Quaternius' Universal Animation Library (a 1.83 m mannequin
 * on a Rigify DEF- skeleton, 46 clips). Rigs:
 *
 *   cyberpunk (default)  Quaternius' Cyberpunk Game Kit character with the
 *                        library's clips retargeted onto it by Blender
 *                        (tools/level-authoring/character.py; `--retarget` runs
 *                        it, else the last export is used) → operator.glb
 *   ual                  the library's own mannequin → operator_ual.glb
 *
 * Either way this keeps the clips the showcase graphs use, renames them to the
 * engine's conventions (`idle`, `walk`, `run`, `hit`, `death`, ... see CLIPS),
 * replaces the dots in bone names with underscores (three's loader would strip
 * them), marks loops and the root-motion bone with `spark.*` extras, writes
 * assets/source/characters/<name>.glb and runs the asset pipeline on it into
 * apps/showcase/public/models/.
 *
 * The rig's bone names, masks and ragdoll shape live in
 * apps/showcase/src/actors/rig.ts; the two must agree.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { runBlender } from '../level-authoring/blender.mjs';
import { runPipeline } from './pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CHARACTERS = path.join(repoRoot, 'assets', 'source', 'characters');
const UAL = path.join(CHARACTERS, 'ual', 'AnimationLibrary_Godot_Standard.gltf');
const KIT_CHARACTER = path.join(CHARACTERS, 'cyberpunk', 'SK_Character.usda');
const RETARGETED = path.join(CHARACTERS, 'cyberpunk', 'SK_Character.retargeted.glb');
const RETARGET_SCRIPT = path.join(repoRoot, 'tools', 'level-authoring', 'character.py');
const OUT_DIR = CHARACTERS;
const PUBLIC = path.join(repoRoot, 'apps', 'showcase', 'public', 'models');

export const RIGS = {
  cyberpunk: { src: RETARGETED, root: 'Root', out: 'operator', source: 'Quaternius Cyberpunk Game Kit character + Universal Animation Library clips (CC0)' },
  ual: { src: UAL, root: 'root', out: 'operator_ual', source: 'Quaternius Universal Animation Library (CC0)' },
};

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

export async function buildCharacter({ log = console.log, rig = 'cyberpunk', retarget = false, pipeline = true, verbose = false } = {}) {
  const spec = RIGS[rig];
  if (!spec) throw new Error(`unknown rig "${rig}"; rigs: ${Object.keys(RIGS).join(', ')}`);
  if (rig === 'cyberpunk' && retarget) {
    const clips = Object.values(CLIPS).map((c) => c.from).join(',');
    const status = runBlender(RETARGET_SCRIPT, [UAL, KIT_CHARACTER, RETARGETED, clips]);
    if (status !== 0) throw new Error(`retarget failed (blender exit ${status})`);
  }
  const OUT = path.join(OUT_DIR, `${spec.out}.glb`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(spec.src);
  const root = doc.getRoot();

  // Blender suffixes a retargeted action with .001 when the source action holds the plain name.
  const byName = new Map(root.listAnimations().map((a) => [a.getName().replace(/\.\d{3}$/, ''), a]));
  const wanted = new Set(Object.values(CLIPS).map((c) => c.from));
  for (const [name, anim] of byName) if (!wanted.has(name)) anim.dispose();
  for (const [name, clip] of Object.entries(CLIPS)) {
    const anim = byName.get(clip.from);
    if (!anim) throw new Error(`clip "${clip.from}" (for ${name}) not in ${path.relative(repoRoot, spec.src)}`);
    anim.setName(name).setExtras({ 'spark.loop': clip.loop, 'spark.source': clip.from });
  }

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
  top.setExtras({ 'spark.type': 'character', 'spark.budget': 'enemy', 'spark.source': spec.source });
  root.setExtras({ 'spark.source': spec.source });

  if (verbose) {
    const walk = (n, d) => {
      log(`${'  '.repeat(d)}${n.getName()} t=${n.getTranslation().map((v) => v.toFixed(3)).join(',')}`);
      for (const c of n.listChildren()) walk(c, d + 1);
    };
    for (const child of scene.listChildren()) walk(child, 0);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(OUT, glb);
  log(`wrote ${path.relative(repoRoot, OUT)} (${(glb.byteLength / 1024).toFixed(0)} KiB, ${Object.keys(CLIPS).length} clips)`);
  if (!pipeline) return OUT;
  const ok = await runPipeline({ src: OUT_DIR, out: PUBLIC, only: spec.out, budget: 'enemy', verbose, log });
  if (!ok) throw new Error('asset pipeline failed');
  return path.join(PUBLIC, `${spec.out}.glb`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const rigArg = argv.find((a) => a.startsWith('--rig='));
  buildCharacter({
    rig: rigArg ? rigArg.slice(6) : 'cyberpunk',
    retarget: argv.includes('--retarget'),
    pipeline: !argv.includes('--no-pipeline'),
    verbose: argv.includes('--verbose'),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
