import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { CameraRig, ISOMETRIC_PRESET, damp, decayTrauma, focusDistanceAlongView, orbitOffset, shakeAmount } from '../src/rendering/CameraRig';

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

describe('CameraRig focus', () => {
  it('focusDistanceAlongView measures along the view direction and clamps', () => {
    const forward = { x: 0, y: 0, z: -1 };
    expect(focusDistanceAlongView({ x: 0, y: 0, z: 10 }, forward, { x: 3, y: 4, z: 0 })).toBeCloseTo(10, 9);
    expect(focusDistanceAlongView({ x: 0, y: 0, z: 10 }, forward, { x: 0, y: 0, z: 20 }, 0.5)).toBe(0.5);
  });

  it('follows the focus target with damping and publishes to the bound sink', () => {
    const rig = new CameraRig({ preset: ISOMETRIC_PRESET, focusRate: 4, focusRange: 3 });
    const calls: { distance: number; range: number }[] = [];
    rig.bindFocus({ setFocus: (distance, range) => calls.push({ distance, range }) });
    rig.target.set(0, 0, 0);
    rig.snap();
    expect(rig.getFocusDistance()).toBeCloseTo(ISOMETRIC_PRESET.distance, 5);
    expect(calls.at(-1)?.range).toBe(3);
    const before = rig.getFocusDistance() as number;
    // A focus subject much nearer than the follow target: the distance must move toward it, not jump.
    rig.focusTarget = rig.camera.position.clone().add(rig.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5));
    rig.update(1 / 60);
    const after = rig.getFocusDistance() as number;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(5);
    for (let i = 0; i < 600; i++) rig.update(1 / 60);
    expect(rig.getFocusDistance()).toBeCloseTo(5, 2);
    expect(calls.length).toBeGreaterThan(600);
  });
});
