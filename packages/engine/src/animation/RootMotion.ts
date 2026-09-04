/**
 * Root-motion extraction, pure math. A clip's root-bone translation track is
 * sampled at the previous and current playback times; the difference (with
 * loop wraps accounted for) is the distance the character moved this step.
 * `AnimationWorld` sums these per active clip, weighted, and neutralises the
 * bone so the mesh stays on its entity.
 */

export interface Vec3Track {
  /** Ascending key times in seconds. */
  readonly times: ArrayLike<number>;
  /** xyz per key, `3 * times.length` values. */
  readonly values: ArrayLike<number>;
}

export type Vec3Tuple = [number, number, number];

/** Linear sample, clamped to the first / last key. */
export function sampleVec3(track: Vec3Track, t: number, out: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
  const times = track.times;
  const values = track.values;
  const n = times.length;
  if (n === 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  if (t <= (times[0] as number) || n === 1) {
    out[0] = values[0] as number;
    out[1] = values[1] as number;
    out[2] = values[2] as number;
    return out;
  }
  if (t >= (times[n - 1] as number)) {
    const o = (n - 1) * 3;
    out[0] = values[o] as number;
    out[1] = values[o + 1] as number;
    out[2] = values[o + 2] as number;
    return out;
  }
  // Binary search for the key interval containing t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo] as number;
  const t1 = times[hi] as number;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = lo * 3;
  const b = hi * 3;
  out[0] = (values[a] as number) + ((values[b] as number) - (values[a] as number)) * f;
  out[1] = (values[a + 1] as number) + ((values[b + 1] as number) - (values[a + 1] as number)) * f;
  out[2] = (values[a + 2] as number) + ((values[b + 2] as number) - (values[a + 2] as number)) * f;
  return out;
}

const sA: Vec3Tuple = [0, 0, 0];
const sB: Vec3Tuple = [0, 0, 0];

/**
 * Root translation delta for playback moving from `prevTime` to `time`,
 * crossing the clip end `loops` times (0 for a one-shot or an in-loop step).
 * The delta, scaled by `scale`, is added to `out`.
 */
export function rootMotionDelta(
  track: Vec3Track,
  prevTime: number,
  time: number,
  loops: number,
  duration: number,
  out: Vec3Tuple,
  scale = 1,
): Vec3Tuple {
  if (loops <= 0) {
    sampleVec3(track, time, sA);
    sampleVec3(track, prevTime, sB);
    out[0] += (sA[0] - sB[0]) * scale;
    out[1] += (sA[1] - sB[1]) * scale;
    out[2] += (sA[2] - sB[2]) * scale;
    return out;
  }
  // Tail of the previous loop, whole loops in between, head of the new loop.
  sampleVec3(track, duration, sA);
  sampleVec3(track, prevTime, sB);
  let dx = sA[0] - sB[0];
  let dy = sA[1] - sB[1];
  let dz = sA[2] - sB[2];
  sampleVec3(track, 0, sB);
  const whole = loops - 1;
  if (whole > 0) {
    dx += (sA[0] - sB[0]) * whole;
    dy += (sA[1] - sB[1]) * whole;
    dz += (sA[2] - sB[2]) * whole;
  }
  sampleVec3(track, time, sA);
  dx += sA[0] - sB[0];
  dy += sA[1] - sB[1];
  dz += sA[2] - sB[2];
  out[0] += dx * scale;
  out[1] += dy * scale;
  out[2] += dz * scale;
  return out;
}

/** Rotate a local-space delta by a unit quaternion (the entity's facing) into world space, in place. */
export function rotateByQuaternion(v: Vec3Tuple, qx: number, qy: number, qz: number, qw: number): Vec3Tuple {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  // t = 2 * cross(q.xyz, v); v' = v + qw * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  v[0] = x + qw * tx + (qy * tz - qz * ty);
  v[1] = y + qw * ty + (qz * tx - qx * tz);
  v[2] = z + qw * tz + (qx * ty - qy * tx);
  return v;
}
