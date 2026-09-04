/**
 * Fade curves. Equal-power keeps perceived loudness flat through a crossfade
 * (linear dips ~3 dB at the midpoint). Pure functions so they are testable
 * and identical between music crossfades and stem intensity blends.
 */

/** Gains for the outgoing (`a`) and incoming (`b`) sources at progress `t` in [0, 1]. */
export function crossfadeGains(t: number): { a: number; b: number } {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const angle = (x * Math.PI) / 2;
  return { a: Math.cos(angle), b: Math.sin(angle) };
}

/** Gain of an intensity layer: silent at 0, equal-power partner of the base at 1. */
export function intensityGain(intensity: number): number {
  return crossfadeGains(intensity).b;
}

/** Sample a fade over `steps` points for `AudioParam.setValueCurveAtTime`. */
export function fadeCurve(from: number, to: number, steps = 32): Float32Array {
  const n = Math.max(2, Math.floor(steps));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Equal-power shape between two arbitrary levels.
    const g = crossfadeGains(t);
    out[i] = from * g.a + to * g.b;
  }
  return out;
}
