import { describe, expect, it } from 'vitest';
import { intersectRayBox } from '../src/rendering/VolumeFog';

const min = { x: -1, y: 0, z: -1 };
const max = { x: 1, y: 2, z: 1 };

describe('intersectRayBox', () => {
  it('clips a ray that starts inside the box to [0, exit]', () => {
    const r = intersectRayBox({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, min, max);
    expect(r.enter).toBe(0);
    expect(r.exit).toBeCloseTo(1, 9);
  });

  it('finds entry and exit for a ray from outside', () => {
    const r = intersectRayBox({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max);
    expect(r.enter).toBeCloseTo(4, 9);
    expect(r.exit).toBeCloseTo(6, 9);
  });

  it('reports no overlap for a miss and for a box behind the ray', () => {
    const miss = intersectRayBox({ x: 5, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max);
    expect(miss.enter).toBeGreaterThanOrEqual(miss.exit);
    const behind = intersectRayBox({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: 1 }, min, max);
    expect(behind.enter).toBeGreaterThanOrEqual(behind.exit);
  });

  it('is clipped by the scene depth', () => {
    const r = intersectRayBox({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max, 4.5);
    expect(r.enter).toBeCloseTo(4, 9);
    expect(r.exit).toBeCloseTo(4.5, 9);
    const occluded = intersectRayBox({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max, 2);
    expect(occluded.enter).toBeGreaterThanOrEqual(occluded.exit);
  });

  it('handles axis-parallel rays', () => {
    const inside = intersectRayBox({ x: 0.5, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max);
    expect(inside.exit).toBeGreaterThan(inside.enter);
    const outside = intersectRayBox({ x: 3, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, min, max);
    expect(outside.exit).toBeLessThanOrEqual(outside.enter);
  });
});
