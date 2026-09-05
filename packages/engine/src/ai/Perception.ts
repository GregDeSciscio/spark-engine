import type { Entity } from '../ecs/EntityWorld';
import type { LayerSpec } from '../physics/Layers';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Vec3Like } from './Navigation';

/**
 * Perception primitives for agents (ADR-005): can an eye see a point, and is
 * a point inside a view cone. Sound and light are the other two senses;
 * hearing is a radius test the game does inline, light is
 * `LightingSystem.illuminanceAt`.
 */

const _dir = { x: 0, y: 0, z: 0 };

/** True when nothing on `layers` lies between `eye` and `target`. */
export function lineOfSight(physics: PhysicsWorld, eye: Vec3Like, target: Vec3Like, layers: LayerSpec = 'world', exclude?: Entity): boolean {
  _dir.x = target.x - eye.x;
  _dir.y = target.y - eye.y;
  _dir.z = target.z - eye.z;
  const len = Math.hypot(_dir.x, _dir.y, _dir.z);
  if (len < 1e-6) return true;
  const options = exclude !== undefined ? { layers, excludeEid: exclude } : { layers };
  return physics.raycast(eye, _dir, len, options) === null;
}

/**
 * True when `to` lies within `fov` radians (full angle) of `forward` as seen
 * from `from`, on the ground plane. `forward` need not be unit length.
 */
export function inViewCone(forward: Vec3Like, from: Vec3Like, to: Vec3Like, fov: number): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  const f = Math.hypot(forward.x, forward.z);
  if (d < 1e-6) return true;
  if (f < 1e-6) return false;
  const cosine = (dx * forward.x + dz * forward.z) / (d * f);
  return cosine >= Math.cos(fov / 2);
}
