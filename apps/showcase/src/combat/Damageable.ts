import type * as THREE from 'three/webgpu';
import type { Entity } from '@spark/engine';
import type { HitZone } from './weapons';

/** Where and which way a bullet went in, for blood and ragdoll impulses. */
export interface Impact {
  readonly point: THREE.Vector3;
  readonly direction: THREE.Vector3;
}

/** Anything a hitscan ray can hurt: dummies, enemies, and later the operator. */
export interface Damageable {
  readonly eid: Entity;
  readonly dead: boolean;
  /** Height of a world-space hit as a fraction of the standing height, for hit zones. */
  heightFraction(y: number): number;
  /** Apply damage. Returns true when this hit killed the target. */
  hit(zone: HitZone, damage: number, now: number, impact?: Impact): boolean;
}
