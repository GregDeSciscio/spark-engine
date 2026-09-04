import type * as THREE from 'three/webgpu';
import type { Random } from '@spark/engine';
import type { Stance } from '../actors/Operator';

/**
 * Weapon definitions and the pure maths behind a shot. The schema is Task
 * Unit's weapon identity framework (`docs/design/task-unit-reference.md`):
 * cadence, recoil shape, effective range and handling as data, never spread
 * across systems. Everything here is deterministic given the engine `Random`.
 */

export type FireMode = 'auto' | 'semi';
export type HitZone = 'head' | 'torso' | 'legs';

export interface DamageBands {
  readonly close: number;
  readonly far: number;
  readonly falloffStart: number;
  readonly falloffEnd: number;
}

export interface AccuracyProfile {
  /** Standing-still spread, degrees (cone half-angle). */
  readonly baseSpreadDeg: number;
  readonly stanceSpreadMults: Readonly<Record<Stance, number>>;
  /** Added at full movement speed, scaled by speed / walk speed. */
  readonly movingSpreadDeg: number;
  readonly airborneSpreadDeg: number;
  /** Added when firing from the hip instead of the sights. */
  readonly hipSpreadDeg: number;
  readonly bloomPerShotDeg: number;
  readonly maxBloomDeg: number;
  readonly bloomRecoveryDegPerSecond: number;
}

export interface RecoilProfile {
  /** Per-shot kick, indexed by shot number within a burst (wraps). */
  readonly pattern: readonly { readonly pitchDeg: number; readonly yawDeg: number }[];
  readonly bloomPitchScale: number;
  readonly bloomYawScale: number;
  readonly pitchClampDeg: number;
  readonly yawClampDeg: number;
  /** Recovery rate (1/s) of the pitch offset back to zero. */
  readonly returnSpeed: number;
  readonly yawReturnSpeed: number;
  /** Seconds after the last shot before recovery starts. */
  readonly recoveryDelay: number;
  readonly randomPitchDeg: number;
  readonly randomYawDeg: number;
}

export interface WeaponDefinition {
  readonly id: string;
  readonly name: string;
  readonly fireMode: FireMode;
  readonly damage: number | DamageBands;
  readonly rpm: number;
  /** Hitscan reach, world units. */
  readonly range: number;
  readonly magazineSize: number;
  readonly reserveAmmo: number;
  readonly reloadTime: number;
  readonly accuracy: AccuracyProfile;
  readonly recoil: RecoilProfile;
  readonly muzzle: { readonly flashColor: number; readonly flashIntensity: number };
}

/** Task Unit's reference gun (`rifle_baseline`, the M4A1): stable, flexible, no extreme upside. */
export const RIFLE_BASELINE: WeaponDefinition = {
  id: 'rifle_baseline',
  name: 'M4A1',
  fireMode: 'auto',
  damage: 25,
  rpm: 600,
  range: 100,
  magazineSize: 30,
  reserveAmmo: 120,
  reloadTime: 2.5,
  accuracy: {
    baseSpreadDeg: 0.35,
    stanceSpreadMults: { stand: 1, crouch: 0.72, prone: 0.5 },
    movingSpreadDeg: 0.6,
    airborneSpreadDeg: 1.02,
    hipSpreadDeg: 0.9,
    bloomPerShotDeg: 0.19,
    maxBloomDeg: 1.02,
    bloomRecoveryDegPerSecond: 1.35,
  },
  recoil: {
    pattern: [
      { pitchDeg: 0.62, yawDeg: -0.06 },
      { pitchDeg: 0.78, yawDeg: 0.1 },
      { pitchDeg: 0.9, yawDeg: 0.14 },
      { pitchDeg: 1.02, yawDeg: 0.18 },
      { pitchDeg: 1.12, yawDeg: -0.12 },
      { pitchDeg: 1.22, yawDeg: -0.18 },
      { pitchDeg: 1.32, yawDeg: -0.24 },
      { pitchDeg: 1.4, yawDeg: 0.18 },
    ],
    bloomPitchScale: 0.36,
    bloomYawScale: 0.12,
    pitchClampDeg: 6.6,
    yawClampDeg: 2.1,
    returnSpeed: 9.6,
    yawReturnSpeed: 13,
    recoveryDelay: 0.03,
    randomPitchDeg: 0.09,
    randomYawDeg: 0.05,
  },
  muzzle: { flashColor: 0xffb347, flashIntensity: 260 },
};

/** Task Unit's headshot multiplier is 1.5; legs are a soft penalty. */
export const ZONE_MULTIPLIER: Readonly<Record<HitZone, number>> = { head: 1.5, torso: 1, legs: 0.8 };

/** Zone from where a hit lands on a standing character, as a fraction of its height. */
export function hitZoneAt(heightFraction: number): HitZone {
  if (heightFraction > 0.82) return 'head';
  if (heightFraction > 0.47) return 'torso';
  return 'legs';
}

/** Damage at a distance: flat, or linear between the bands. */
export function damageAt(def: WeaponDefinition, distance: number): number {
  const d = def.damage;
  if (typeof d === 'number') return d;
  if (d.falloffEnd <= d.falloffStart) return d.close;
  const ratio = Math.min(1, Math.max(0, (distance - d.falloffStart) / (d.falloffEnd - d.falloffStart)));
  return d.close + (d.far - d.close) * ratio;
}

export interface ShooterState {
  readonly stance: Stance;
  /** Horizontal speed, world units per second. */
  readonly speed: number;
  readonly grounded: boolean;
  readonly aiming: boolean;
}

const WALK_SPEED = 5;

/** Cone half-angle in degrees for the next shot. */
export function spreadDegrees(def: WeaponDefinition, s: ShooterState, bloomDeg: number): number {
  const a = def.accuracy;
  const moveRatio = Math.min(1, Math.max(0, s.speed / WALK_SPEED));
  return (
    a.baseSpreadDeg * a.stanceSpreadMults[s.stance] +
    a.movingSpreadDeg * moveRatio +
    (s.grounded ? 0 : a.airborneSpreadDeg) +
    (s.aiming ? 0 : a.hipSpreadDeg) +
    Math.max(0, bloomDeg)
  );
}

/** Deflect a unit direction uniformly within a cone of `spreadDeg`, in place. */
export function applySpread(direction: THREE.Vector3, spreadDeg: number, random: Random, right: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  if (spreadDeg <= 0) return direction;
  // Basis around the direction: any vector not parallel to it seeds the cross products.
  if (Math.abs(direction.y) < 0.99) right.set(0, 1, 0);
  else right.set(1, 0, 0);
  right.cross(direction).normalize();
  up.crossVectors(direction, right).normalize();
  const radius = Math.tan((spreadDeg * Math.PI) / 180) * Math.sqrt(random.next());
  const theta = random.next() * Math.PI * 2;
  direction.addScaledVector(right, Math.cos(theta) * radius).addScaledVector(up, Math.sin(theta) * radius);
  return direction.normalize();
}

export interface RecoilImpulse {
  readonly pitchDeg: number;
  readonly yawDeg: number;
}

/** The kick for shot `shotIndex` of a burst, grown by bloom and jittered. */
export function recoilImpulse(def: WeaponDefinition, shotIndex: number, bloomDeg: number, random: Random): RecoilImpulse {
  const r = def.recoil;
  const step = r.pattern[shotIndex % r.pattern.length] ?? r.pattern[r.pattern.length - 1];
  if (!step) return { pitchDeg: 0, yawDeg: 0 };
  const bloomRatio = Math.min(1, Math.max(0, bloomDeg / Math.max(def.accuracy.maxBloomDeg, 0.001)));
  const yawSign = step.yawDeg === 0 ? (shotIndex % 2 === 0 ? -1 : 1) : Math.sign(step.yawDeg);
  return {
    pitchDeg: step.pitchDeg + r.bloomPitchScale * bloomRatio + (random.next() * 2 - 1) * r.randomPitchDeg,
    yawDeg: step.yawDeg + r.bloomYawScale * bloomRatio * yawSign + (random.next() * 2 - 1) * r.randomYawDeg,
  };
}
