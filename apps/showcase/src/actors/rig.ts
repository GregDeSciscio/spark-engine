import type * as THREE from 'three/webgpu';
import { findBone, type RagdollConfig } from '@spark/engine';

/**
 * The showcase character (`tools/asset-pipeline/build-character.mjs`):
 * Quaternius' Cyberpunk Game Kit character, scaled to 1.8 m, with the
 * Universal Animation Library's clips retargeted onto its skeleton by
 * `tools/level-authoring/character.py`. Forward is +Z at yaw 0. Bone names,
 * the upper-body mask and the ragdoll shape live here so the actors and the
 * build agree.
 *
 * Skeleton: Root → Body (the hips) → Hips / Abdomen → Torso → Chest → Neck →
 * Head, Chest → Shoulder → UpperArm → LowerArm → Hand (Hand_R → Weapon, a
 * socket at the grip), Body → UpperLeg → LowerLeg → Foot. `PT_*` are
 * pole-target leftovers.
 *
 * Clips (engine names): idle, walk, run, sprint, crouch_idle, crouch_walk,
 * ready, aim_up, aim, aim_down, reload, hit, hit_head, death, jump, land.
 */
export const CHARACTER_URL = '/models/operator.glb';

/** Model height as built; the same as the standing capsule. */
export const CHARACTER_HEIGHT = 1.8;

export const BONES = {
  root: 'Root',
  hips: 'Body',
  spine1: 'Abdomen',
  spine2: 'Torso',
  spine3: 'Chest',
  neck: 'Neck',
  head: 'Head',
  handR: 'Hand_R',
  handL: 'Hand_L',
  /** Weapon socket in the right hand. */
  weapon: 'Weapon',
} as const;

/**
 * Bone-name prefixes the aim / ready layer overrides: the upper spine, neck,
 * head and both arms. The hips, abdomen and legs stay with locomotion so
 * walking and crouching still read through an aim.
 */
export const UPPER_BODY_MASK: readonly string[] = ['Torso', 'Chest', 'Neck', 'Head', 'Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Weapon'];

/**
 * Ragdoll capsules for the rig; parents before children (engine
 * `RagdollConfig`). Explicit lengths where a bone's first configured child is
 * not along it (the hips fan out to the legs) or is missing (forearms, shins).
 */
export const CHARACTER_RAGDOLL: RagdollConfig = {
  bones: [
    { bone: 'Body', radius: 0.15, length: 0.14 },
    { bone: 'Abdomen', radius: 0.14 },
    { bone: 'Torso', radius: 0.14 },
    { bone: 'Chest', radius: 0.15, length: 0.13 },
    { bone: 'Neck', radius: 0.06, length: 0.12 },
    { bone: 'Head', radius: 0.11, length: 0.22 },
    { bone: 'UpperArm_L', radius: 0.055 },
    { bone: 'LowerArm_L', radius: 0.045, length: 0.37 },
    { bone: 'UpperArm_R', radius: 0.055 },
    { bone: 'LowerArm_R', radius: 0.045, length: 0.37 },
    { bone: 'UpperLeg_L', radius: 0.08 },
    { bone: 'LowerLeg_L', radius: 0.065, length: 0.46 },
    { bone: 'UpperLeg_R', radius: 0.08 },
    { bone: 'LowerLeg_R', radius: 0.065, length: 0.46 },
  ],
  leafLength: 0.25,
  linearDamping: 0.4,
  angularDamping: 2.5,
  friction: 0.9,
};

/** Speed thresholds (m/s) for the locomotion blends: the clips' natural paces. */
export const LOCOMOTION = { walk: 1.4, run: 4.0, sprint: 7.0, crouchWalk: 2.0 } as const;

/** Aim blend parameter: view pitch in degrees, positive looking down; the poses cover this range. */
export const AIM_PITCH_RANGE = 45;

export { findBone };

/**
 * Recolour a character instance: the kit's `Main` material takes `main`,
 * `Accent` / `Accent_Dark` take `accent` (optionally glowing), `Black` stays
 * black. Materials are cloned per instance so tints never leak.
 */
export function tintCharacter(visual: THREE.Object3D, main: THREE.ColorRepresentation, accent: THREE.ColorRepresentation, emissive = 0): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  visual.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = materials.map((mat) => {
      const m = (mat as THREE.MeshStandardMaterial).clone();
      const isAccent = /joint|accent/i.test(m.name);
      const isBlack = /black/i.test(m.name);
      if (isAccent) {
        m.color.set(accent);
        if (emissive > 0) {
          m.emissive.set(accent);
          m.emissiveIntensity = emissive;
        }
        if (/dark/i.test(m.name)) m.color.multiplyScalar(0.45);
        m.roughness = 0.35;
        m.metalness = 0.3;
      } else if (!isBlack) {
        m.color.set(main);
        m.roughness = 0.7;
        m.metalness = 0.05;
      }
      out.push(m);
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : (cloned[0] as THREE.Material);
  });
  return out;
}
