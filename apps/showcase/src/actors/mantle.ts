/**
 * Mantling: the operator vaults low cover. The level marks what can be vaulted
 * (`spark.type=mantle`: an axis-aligned footprint and a top height, authored
 * in `tools/level-authoring/street.py`), and pressing jump near and facing one
 * of those edges turns the jump into a short scripted move up and over.
 *
 * Planning and the move's path are pure functions of the zones, the
 * operator's feet and facing, and two world queries, so the rules are a unit
 * test (`apps/showcase/tests/Mantle.test.ts`); `Operator` asks for a plan on
 * the fixed step and walks the path there, which keeps it deterministic.
 * No new animation: the jump and land states cover it.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A vaultable obstacle: its footprint on the ground plane, where it stands and how high it reaches. */
export interface MantleZone {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** World y of the obstacle's base. */
  readonly bottom: number;
  /** World y of its top: where the feet go over or land. */
  readonly top: number;
}

export const MANTLE = {
  /** How far beyond the capsule's surface an edge can be and still be vaulted, metres. */
  reach: 0.75,
  /** Rise from the feet to the top that the move covers: below this the controller steps it, above it is a wall. */
  minRise: 0.45,
  maxRise: 1.45,
  /** Widest angle between the view and the edge's inward normal, degrees. */
  facingDeg: 50,
  /** Obstacles up to this deep along the vault are gone over when the far side is clear; deeper ones are climbed onto. */
  overDepth: 1.25,
  /** The feet clear the top by this much while crossing. */
  clearance: 0.12,
  /** Gap left between the capsule and the far face on landing. */
  landingGap: 0.1,
  /** Deepest drop past the far face the vault will land in, below the top. */
  maxDrop: 2.2,
  /** Shortest top that can be stood on, as a fraction of the capsule's diameter. */
  standFraction: 0.75,
  /** Seconds for the whole move. */
  seconds: 0.5,
  /** Fractions of the move: the rise to the edge ends here, the crossing ends here, the rest is the drop. */
  riseEnd: 0.3,
  crossEnd: 0.75,
} as const;

/** What the plan needs to know about the world beyond the zones. */
export interface MantleWorld {
  /** World y of the first surface straight down from (x, fromY, z) within `depth`, or null. */
  groundBelow(x: number, z: number, fromY: number, depth: number): number | null;
  /** Whether a standing capsule with its feet at (x, y, z) is clear of the world and of anyone in it. */
  standClear(x: number, y: number, z: number): boolean;
}

export interface MantlePlan {
  readonly zone: MantleZone;
  /** Feet where the move starts. */
  readonly from: Vec3;
  /** Feet where the capsule's front meets the edge, at the top of the rise. */
  readonly edge: Vec3;
  /** Feet where it lands: past the far face (`over`) or on the top. */
  readonly to: Vec3;
  /** Feet height while crossing. */
  readonly peak: number;
  /** Inward unit normal of the edge being vaulted, on the ground plane. */
  readonly nx: number;
  readonly nz: number;
  /** Gone over and dropped down the far side, rather than climbed onto. */
  readonly over: boolean;
}

interface EdgeHit {
  readonly t: number;
  readonly nx: number;
  readonly nz: number;
}

/** Where a ground-plane ray from (ox, oz) along (dx, dz) enters the zone's footprint, and the inward normal of that face. */
function enterFootprint(zone: MantleZone, ox: number, oz: number, dx: number, dz: number): EdgeHit | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  let nx = 0;
  let nz = 0;
  if (Math.abs(dx) < 1e-9) {
    if (ox < zone.minX || ox > zone.maxX) return null;
  } else {
    const a = (zone.minX - ox) / dx;
    const b = (zone.maxX - ox) / dx;
    const near = Math.min(a, b);
    if (near > tMin) {
      tMin = near;
      nx = Math.sign(dx);
      nz = 0;
    }
    tMax = Math.min(tMax, Math.max(a, b));
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < zone.minZ || oz > zone.maxZ) return null;
  } else {
    const a = (zone.minZ - oz) / dz;
    const b = (zone.maxZ - oz) / dz;
    const near = Math.min(a, b);
    if (near > tMin) {
      tMin = near;
      nx = 0;
      nz = Math.sign(dz);
    }
    tMax = Math.min(tMax, Math.max(a, b));
  }
  // Starting inside the footprint (standing on it) is not an approach to its edge.
  if (tMin < 0 || tMax < tMin) return null;
  return { t: tMin, nx, nz };
}

/**
 * The vault to make from `feet` looking along (dirX, dirZ), or null when no
 * edge qualifies: the nearest zone whose edge the view meets within reach,
 * square enough to it, with a top the right height above the feet, and
 * somewhere clear to land.
 */
export function planMantle(zones: readonly MantleZone[], feet: Vec3, dirX: number, dirZ: number, radius: number, world: MantleWorld): MantlePlan | null {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return null;
  const dx = dirX / len;
  const dz = dirZ / len;
  const minCos = Math.cos((MANTLE.facingDeg * Math.PI) / 180);
  let best: { zone: MantleZone; hit: EdgeHit } | null = null;
  for (const zone of zones) {
    const rise = zone.top - feet.y;
    if (rise < MANTLE.minRise || rise > MANTLE.maxRise) continue;
    // An obstacle standing on a ledge above the operator is somebody else's.
    if (zone.bottom > feet.y + 0.3) continue;
    const hit = enterFootprint(zone, feet.x, feet.z, dx, dz);
    if (!hit || hit.t > radius + MANTLE.reach) continue;
    if (dx * hit.nx + dz * hit.nz < minCos) continue;
    if (!best || hit.t < best.hit.t) best = { zone, hit };
  }
  if (!best) return null;
  const { zone, hit } = best;
  const { nx, nz } = hit;

  // Go over the edge square to it, from where the view meets it, kept off the corners.
  let ex = feet.x + dx * hit.t;
  let ez = feet.z + dz * hit.t;
  const margin = Math.min(radius * 0.5, 0.2);
  if (nx !== 0) ez = clampInside(ez, zone.minZ, zone.maxZ, margin);
  else ex = clampInside(ex, zone.minX, zone.maxX, margin);
  const depth = nx !== 0 ? zone.maxX - zone.minX : zone.maxZ - zone.minZ;
  const peak = zone.top + MANTLE.clearance;
  const edge = { x: ex - nx * radius, y: peak, z: ez - nz * radius };
  const from = { x: feet.x, y: feet.y, z: feet.z };

  if (depth <= MANTLE.overDepth) {
    const lx = ex + nx * (depth + radius + MANTLE.landingGap);
    const lz = ez + nz * (depth + radius + MANTLE.landingGap);
    const ground = world.groundBelow(lx, lz, zone.top + 0.3, MANTLE.maxDrop + 0.3);
    if (ground !== null && ground <= zone.top - 0.3 && world.standClear(lx, ground + 0.02, lz)) {
      return { zone, from, edge, to: { x: lx, y: ground + 0.02, z: lz }, peak, nx, nz, over: true };
    }
  }
  if (depth >= 2 * radius * MANTLE.standFraction) {
    const inset = Math.min(depth / 2, radius + 0.15);
    const tx = ex + nx * inset;
    const tz = ez + nz * inset;
    // The zone says where its top is; the world has to agree before anyone stands on it.
    const surface = world.groundBelow(tx, tz, zone.top + 0.3, 0.6);
    if (surface !== null && Math.abs(surface - zone.top) < 0.2 && world.standClear(tx, surface + 0.02, tz)) {
      return { zone, from, edge, to: { x: tx, y: surface + 0.02, z: tz }, peak, nx, nz, over: false };
    }
  }
  return null;
}

function clampInside(v: number, min: number, max: number, margin: number): number {
  if (max - min <= 2 * margin) return (min + max) / 2;
  return Math.min(max - margin, Math.max(min + margin, v));
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Feet position `u` (0..1) of the way through a planned move, written to
 * `out`. Three beats: rise to the edge (the capsule's front reaches the face
 * as the feet reach the peak), cross at the peak, then drop to the landing
 * (`over`) or settle onto the top. The feet are never below the top while the
 * capsule is over the footprint, so it reads as going over the obstacle, not
 * through it.
 */
export function mantlePose(plan: MantlePlan, u: number, out: Vec3): Vec3 {
  const t = Math.min(1, Math.max(0, u));
  const { from, edge, to, peak } = plan;
  if (t <= MANTLE.riseEnd) {
    const k = t / MANTLE.riseEnd;
    const h = smooth(k);
    out.x = from.x + (edge.x - from.x) * h;
    out.z = from.z + (edge.z - from.z) * h;
    out.y = from.y + (peak - from.y) * easeOut(k);
    return out;
  }
  if (plan.over && t <= MANTLE.crossEnd) {
    const k = (t - MANTLE.riseEnd) / (MANTLE.crossEnd - MANTLE.riseEnd);
    out.x = edge.x + (to.x - edge.x) * k;
    out.z = edge.z + (to.z - edge.z) * k;
    out.y = peak;
    return out;
  }
  if (plan.over) {
    const k = (t - MANTLE.crossEnd) / (1 - MANTLE.crossEnd);
    out.x = to.x;
    out.z = to.z;
    out.y = peak + (to.y - peak) * easeIn(k);
    return out;
  }
  // Onto the top: across to the landing point, settling from the peak in the last stretch.
  const k = (t - MANTLE.riseEnd) / (1 - MANTLE.riseEnd);
  out.x = edge.x + (to.x - edge.x) * smooth(k);
  out.z = edge.z + (to.z - edge.z) * smooth(k);
  out.y = k < 0.6 ? peak : peak + (to.y - peak) * smooth((k - 0.6) / 0.4);
  return out;
}
