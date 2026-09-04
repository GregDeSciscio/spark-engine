/**
 * Frustum math on flat arrays, so culling and the spatial index can be unit
 * tested without three and run without allocating.
 *
 * A frustum is 6 planes × 4 floats `(a, b, c, d)`; a point `p` is inside a
 * plane when `a·x + b·y + c·z + d >= 0`. This matches three's `Frustum` /
 * `Plane` convention (`normal · p + constant`).
 */

export const FRUSTUM_FLOATS = 24;

export const FrustumResult = {
  Outside: 0,
  Intersect: 1,
  Inside: 2,
} as const;

export type FrustumResultValue = (typeof FrustumResult)[keyof typeof FrustumResult];

/**
 * Extract the six planes from a column-major projection × view matrix (the
 * same algorithm as three's `Frustum.setFromProjectionMatrix`, normalised).
 */
export function extractFrustumPlanes(m: ArrayLike<number>, out: Float32Array): Float32Array {
  const me0 = m[0] as number;
  const me1 = m[1] as number;
  const me2 = m[2] as number;
  const me3 = m[3] as number;
  const me4 = m[4] as number;
  const me5 = m[5] as number;
  const me6 = m[6] as number;
  const me7 = m[7] as number;
  const me8 = m[8] as number;
  const me9 = m[9] as number;
  const me10 = m[10] as number;
  const me11 = m[11] as number;
  const me12 = m[12] as number;
  const me13 = m[13] as number;
  const me14 = m[14] as number;
  const me15 = m[15] as number;
  setPlane(out, 0, me3 - me0, me7 - me4, me11 - me8, me15 - me12);
  setPlane(out, 1, me3 + me0, me7 + me4, me11 + me8, me15 + me12);
  setPlane(out, 2, me3 + me1, me7 + me5, me11 + me9, me15 + me13);
  setPlane(out, 3, me3 - me1, me7 - me5, me11 - me9, me15 - me13);
  setPlane(out, 4, me3 - me2, me7 - me6, me11 - me10, me15 - me14);
  setPlane(out, 5, me3 + me2, me7 + me6, me11 + me10, me15 + me14);
  return out;
}

function setPlane(out: Float32Array, index: number, a: number, b: number, c: number, d: number): void {
  const inv = 1 / Math.hypot(a, b, c);
  const o = index * 4;
  out[o] = a * inv;
  out[o + 1] = b * inv;
  out[o + 2] = c * inv;
  out[o + 3] = d * inv;
}

/** True when a sphere touches or is inside the frustum. */
export function sphereInFrustum(planes: ArrayLike<number>, x: number, y: number, z: number, radius: number): boolean {
  for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
    const d = (planes[i] as number) * x + (planes[i + 1] as number) * y + (planes[i + 2] as number) * z + (planes[i + 3] as number);
    if (d < -radius) return false;
  }
  return true;
}

/** Classify an axis-aligned box against the frustum. */
export function aabbInFrustum(
  planes: ArrayLike<number>,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): FrustumResultValue {
  let result: FrustumResultValue = FrustumResult.Inside;
  for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
    const a = planes[i] as number;
    const b = planes[i + 1] as number;
    const c = planes[i + 2] as number;
    const d = planes[i + 3] as number;
    // p-vertex: the corner furthest along the plane normal; n-vertex: the nearest.
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return FrustumResult.Outside;
    const nx = a >= 0 ? minX : maxX;
    const ny = b >= 0 ? minY : maxY;
    const nz = c >= 0 ? minZ : maxZ;
    if (a * nx + b * ny + c * nz + d < 0) result = FrustumResult.Intersect;
  }
  return result;
}

/**
 * Ray vs sphere. Returns the entry distance along the (unit) direction, or -1
 * when the ray misses or the hit is beyond `maxDist`. A ray starting inside
 * the sphere hits at 0.
 */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  const t1 = tca + thc;
  if (t1 < 0) return -1;
  const t = t0 < 0 ? 0 : t0;
  return t > maxDist ? -1 : t;
}

/** Ray vs axis-aligned box on the XZ plane (slab test). True when the segment `[0, maxDist]` overlaps the box. */
export function raySlabXZ(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  let tmin = 0;
  let tmax = maxDist;
  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return false;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}
