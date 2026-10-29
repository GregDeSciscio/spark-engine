/** Small vector helpers for build-time geometry. Hot solver loops use typed arrays instead. */

export type V3 = [number, number, number];
export type P2 = [number, number];

export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
/** `o + u·a + v·b` */
export const plane = (o: V3, u: V3, a: number, v: V3, b: number): V3 => [
  o[0] + u[0] * a + v[0] * b,
  o[1] + u[1] * a + v[1] * b,
  o[2] + u[2] * a + v[2] * b,
];

/** Any unit vector perpendicular to `n`, then the third axis so that `e1 × e2 = n`. */
export function basisFor(n: V3): [V3, V3] {
  const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(helper, n));
  const e2 = cross(n, e1);
  return [e1, e2];
}

/** Seeded PRNG (mulberry32): same seed, same building. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 2D convex polygons ----------------------------------------------------------

/** Signed area, positive for counter-clockwise. */
export function polygonArea(poly: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/**
 * Area, centroid and second moments about the centroid of a CCW polygon:
 * `ixx = ∫y² dA`, `iyy = ∫x² dA`, `ixy = ∫xy dA`.
 */
export function polygonMoments(poly: readonly P2[]): { area: number; cx: number; cy: number; ixx: number; iyy: number; ixy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
    ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c;
    iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c;
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) return { area: 0, cx: 0, cy: 0, ixx: 0, iyy: 0, ixy: 0 };
  cx /= 6 * a;
  cy /= 6 * a;
  ixx = ixx / 12 - a * cy * cy;
  iyy = iyy / 12 - a * cx * cx;
  ixy = ixy / 24 - a * cx * cy;
  return { area: a, cx, cy, ixx, iyy, ixy };
}

/** Keep the part of a convex polygon where `nx·x + ny·y <= d`. */
export function clipHalfPlane(poly: readonly P2[], nx: number, ny: number, d: number): P2[] {
  const out: P2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const dp = nx * p[0] + ny * p[1] - d;
    const dq = nx * q[0] + ny * q[1] - d;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Intersection of two CCW convex polygons (Sutherland–Hodgman). */
export function clipConvex(subject: readonly P2[], clip: readonly P2[]): P2[] {
  let out: P2[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 2; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    // Inside of a CCW edge a→b is to its left; outward normal is (dy, -dx).
    const nx = b[1] - a[1];
    const ny = -(b[0] - a[0]);
    out = clipHalfPlane(out, nx, ny, nx * a[0] + ny * a[1]);
  }
  return out;
}

/** Drop consecutive near-duplicate vertices a clip can leave behind. */
export function cleanPolygon(poly: readonly P2[], eps = 1e-6): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.abs(last[0] - first[0]) <= eps && Math.abs(last[1] - first[1]) <= eps) out.pop();
  return out;
}
