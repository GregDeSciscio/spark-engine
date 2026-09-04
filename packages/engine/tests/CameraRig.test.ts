import { describe, expect, it } from 'vitest';
import { damp, decayTrauma, orbitOffset, shakeAmount } from '../src/rendering/CameraRig';

describe('CameraRig math', () => {
  it('damp is frame-rate independent', () => {
    // One 100 ms step vs ten 10 ms steps must land in the same place.
    const one = damp(0, 10, 4, 0.1);
    let many = 0;
    for (let i = 0; i < 10; i++) many = damp(many, 10, 4, 0.01);
    expect(one).toBeCloseTo(many, 6);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(10);
  });

  it('damp converges and never overshoots', () => {
    let v = 0;
    let previous = 0;
    for (let i = 0; i < 200; i++) {
      v = damp(v, 1, 6, 1 / 60);
      expect(v).toBeGreaterThanOrEqual(previous);
      expect(v).toBeLessThanOrEqual(1);
      previous = v;
    }
    expect(v).toBeCloseTo(1, 3);
  });

  it('damp with zero dt is the identity', () => {
    expect(damp(3, 10, 5, 0)).toBe(3);
  });

  it('orbitOffset has the requested length and elevation', () => {
    const o = orbitOffset(Math.PI / 4, Math.PI / 6, 10);
    const length = Math.hypot(o.x, o.y, o.z);
    expect(length).toBeCloseTo(10, 6);
    expect(o.y).toBeCloseTo(5, 6);
    expect(o.x).toBeCloseTo(o.z, 6);
  });

  it('trauma decays linearly to zero and clamps', () => {
    let t = 1;
    t = decayTrauma(t, 2, 0.25);
    expect(t).toBeCloseTo(0.5, 6);
    t = decayTrauma(t, 2, 1);
    expect(t).toBe(0);
    expect(decayTrauma(5, 1, 0)).toBe(1);
  });

  it('shake amount is squared trauma', () => {
    expect(shakeAmount(0)).toBe(0);
    expect(shakeAmount(0.5)).toBeCloseTo(0.25, 6);
    expect(shakeAmount(1)).toBe(1);
    expect(shakeAmount(3)).toBe(1);
  });
});
