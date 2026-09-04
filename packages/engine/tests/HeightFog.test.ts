import { describe, expect, it } from 'vitest';
import { DEFAULT_HEIGHT_FOG, heightFogDensity, heightFogFactor, type HeightFogParams } from '../src/rendering/HeightFog';

const params: HeightFogParams = { ...DEFAULT_HEIGHT_FOG, density: 0.02, groundY: 0, falloff: 3, groundBoost: 1 };

describe('height fog term', () => {
  it('is boosted at ground level and decays to the base density with height', () => {
    expect(heightFogDensity(0, params)).toBeCloseTo(0.04, 6);
    expect(heightFogDensity(-5, params)).toBeCloseTo(0.04, 6);
    expect(heightFogDensity(3, params)).toBeCloseTo(0.02 * (1 + Math.exp(-1)), 6);
    expect(heightFogDensity(100, params)).toBeCloseTo(0.02, 6);
  });

  it('with groundBoost 0 is plain exp2 fog', () => {
    const flat = { ...params, groundBoost: 0 };
    for (const y of [-10, 0, 5, 50]) expect(heightFogDensity(y, flat)).toBeCloseTo(0.02, 9);
    expect(heightFogFactor(30, 0, flat)).toBeCloseTo(1 - Math.exp(-((30 * 0.02) ** 2)), 9);
  });

  it('factor is 0 at the camera, monotone in distance and saturates at 1', () => {
    expect(heightFogFactor(0, 0, params)).toBe(0);
    let previous = 0;
    for (let d = 1; d <= 200; d += 1) {
      const f = heightFogFactor(d, 0, params);
      expect(f).toBeGreaterThanOrEqual(previous);
      expect(f).toBeLessThanOrEqual(1);
      previous = f;
    }
    expect(previous).toBeGreaterThan(0.99);
  });

  it('is thicker near the ground than at the same distance up high', () => {
    expect(heightFogFactor(20, 0, params)).toBeGreaterThan(heightFogFactor(20, 12, params));
  });

  it('tolerates a zero falloff', () => {
    expect(Number.isFinite(heightFogDensity(1, { ...params, falloff: 0 }))).toBe(true);
  });
});
