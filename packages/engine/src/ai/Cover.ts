import type { Random } from '../core/Random';
import type { LayerSpec } from '../physics/Layers';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Navigation, Vec3Like } from './Navigation';
import { lineOfSight } from './Perception';

/**
 * Cover queries over the navmesh and the physics world. Promoted from the
 * showcase's enemy: sample reachable points near an agent, keep the closest
 * one a threat's eye cannot see into, and find a sideways point to peek from.
 * Deterministic given the engine `Random`.
 */
export interface CoverQuery {
  /** Where the agent stands (feet). */
  readonly from: Vec3Like;
  /** The threat's eye position. */
  readonly threatEye: Vec3Like;
  /** Radius around `from` to sample. */
  readonly searchRadius: number;
  /** How many navmesh points to try. */
  readonly samples: number;
  /** Candidates closer to the threat than this are refused. */
  readonly minThreatDistance: number;
  /** Candidates farther from the threat than this are refused. */
  readonly maxThreatDistance: number;
  /** Height above the candidate the threat must not see (a crouched chest, roughly). */
  readonly hideHeight: number;
  /** Distance from the threat the score prefers. Default halfway between min and max. */
  readonly preferredThreatDistance?: number | undefined;
  /** Weight of the preferred-distance term against travel distance. Default 0.3. */
  readonly preferredWeight?: number | undefined;
  /** Layers that block sight. Default `'world'`. */
  readonly layers?: LayerSpec | undefined;
}

const _candidate = { x: 0, y: 0, z: 0 };
const _hide = { x: 0, y: 0, z: 0 };

/** Fill `out` with the best cover point and return true, or return false when nothing near hides. */
export function findCover(navigation: Navigation, physics: PhysicsWorld, random: Random, query: CoverQuery, out: Vec3Like): boolean {
  const layers = query.layers ?? 'world';
  const preferred = query.preferredThreatDistance ?? (query.minThreatDistance + query.maxThreatDistance) / 2;
  const weight = query.preferredWeight ?? 0.3;
  let best = Infinity;
  let found = false;
  for (let i = 0; i < query.samples; i++) {
    const c = navigation.randomPointAround(query.from, query.searchRadius, random, _candidate);
    if (!c) continue;
    const dThreat = Math.hypot(c.x - query.threatEye.x, c.z - query.threatEye.z);
    if (dThreat < query.minThreatDistance || dThreat > query.maxThreatDistance) continue;
    _hide.x = c.x;
    _hide.y = c.y + query.hideHeight;
    _hide.z = c.z;
    if (lineOfSight(physics, query.threatEye, _hide, layers)) continue;
    const dSelf = Math.hypot(c.x - query.from.x, c.z - query.from.z);
    const score = dSelf + Math.abs(dThreat - preferred) * weight;
    if (score < best) {
      best = score;
      out.x = c.x;
      out.y = c.y;
      out.z = c.z;
      found = true;
    }
  }
  return found;
}

/**
 * A point `offset` to one side of `cover`, perpendicular to the direction of
 * `threat`, snapped to the navmesh. Tries a random side first, then the
 * other. Returns false when neither side has walkable ground far enough out.
 */
export function peekPoint(navigation: Navigation, cover: Vec3Like, threat: Vec3Like, offset: number, random: Random, out: Vec3Like): boolean {
  const dx = threat.x - cover.x;
  const dz = threat.z - cover.z;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;
  const first = random.next() < 0.5 ? 1 : -1;
  for (const side of [first, -first]) {
    _candidate.x = cover.x + px * offset * side;
    _candidate.y = cover.y;
    _candidate.z = cover.z + pz * offset * side;
    const snapped = navigation.nearestPoint(_candidate, _candidate);
    if (!snapped) continue;
    if (Math.hypot(snapped.x - cover.x, snapped.z - cover.z) < offset * 0.5) continue;
    out.x = snapped.x;
    out.y = snapped.y;
    out.z = snapped.z;
    return true;
  }
  return false;
}
