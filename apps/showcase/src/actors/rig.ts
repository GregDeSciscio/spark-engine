import type * as THREE from 'three/webgpu';
import type { RagdollConfig } from '@spark/engine';

/**
 * The showcase character (`tools/asset-pipeline/build-character.mjs`): the
 * Quaternius Universal Animation Library mannequin on a Rigify DEF- skeleton,
 * 1.83 m tall, forward +Z at yaw 0. Bone names, the upper-body mask and the
 * ragdoll shape live here so the actors and the build script agree. Names are
 * Rigify's with underscores for dots (`DEF-spine_001`, `DEF-hand_R`): the
 * build step renames them because three's glTF loader strips dots.
 *
 * Clips (engine names): idle, walk, run, sprint, crouch_idle, crouch_walk,
 * ready, aim_up, aim, aim_down, reload, hit, hit_head, death, jump, land.
 */
export const CHARACTER_URL = '/models/operator.glb';

/** Model height as authored; the capsule is `OPERATOR.height`, close enough for hit zones. */
export const CHARACTER_HEIGHT = 1.83;

export const BONES = {
  root: 'root',
  hips: 'DEF-hips',
  spine1: 'DEF-spine_001',
  spine2: 'DEF-spine_002',
  spine3: 'DEF-spine_003',
  neck: 'DEF-neck',
  head: 'DEF-head',
  handR: 'DEF-hand_R',
  handL: 'DEF-hand_L',
} as const;

/**
 * Bone-name prefixes the aim / ready layer overrides: the upper spine, neck,
 * head and both arms. The hips, the first spine link and the legs stay with
 * locomotion so walking and crouching still read through an aim.
 */
export const UPPER_BODY_MASK: readonly string[] = ['DEF-spine_002', 'DEF-spine_003', 'DEF-neck', 'DEF-head', 'DEF-shoulder', 'DEF-upper_arm', 'DEF-forearm', 'DEF-hand', 'DEF-f_', 'DEF-thumb'];

/** Ragdoll capsules for the rig; parents before children (engine `RagdollConfig`). */
export const CHARACTER_RAGDOLL: RagdollConfig = {
  bones: [
    { bone: 'DEF-hips', radius: 0.15 },
    { bone: 'DEF-spine_001', radius: 0.14 },
    { bone: 'DEF-spine_002', radius: 0.14 },
    { bone: 'DEF-spine_003', radius: 0.15 },
    { bone: 'DEF-neck', radius: 0.06 },
    { bone: 'DEF-head', radius: 0.11, length: 0.2 },
    { bone: 'DEF-upper_arm_L', radius: 0.055 },
    { bone: 'DEF-forearm_L', radius: 0.045, length: 0.36 },
    { bone: 'DEF-upper_arm_R', radius: 0.055 },
    { bone: 'DEF-forearm_R', radius: 0.045, length: 0.36 },
    { bone: 'DEF-thigh_L', radius: 0.08 },
    { bone: 'DEF-shin_L', radius: 0.065, length: 0.5 },
    { bone: 'DEF-thigh_R', radius: 0.08 },
    { bone: 'DEF-shin_R', radius: 0.065, length: 0.5 },
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

/** Find a bone by name under an instantiated model. */
export function findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}

/** Recolour a character instance: base and accent materials, cloned per instance so tints never leak. */
export function tintCharacter(visual: THREE.Object3D, main: THREE.ColorRepresentation, accent: THREE.ColorRepresentation, emissive = 0): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  visual.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = materials.map((mat) => {
      const m = (mat as THREE.MeshStandardMaterial).clone();
      const isAccent = /joint|accent/i.test(m.name);
      m.color.set(isAccent ? accent : main);
      if (isAccent && emissive > 0) {
        m.emissive.set(accent);
        m.emissiveIntensity = emissive;
      }
      m.roughness = isAccent ? 0.35 : 0.7;
      m.metalness = isAccent ? 0.3 : 0.05;
      out.push(m);
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : (cloned[0] as THREE.Material);
  });
  return out;
}
