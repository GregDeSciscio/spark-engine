import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { distanceFalloff, illuminanceAt, lightRecord, litness, spotFactor, type IlluminanceLight } from '../src/rendering/Illuminance';

describe('distanceFalloff', () => {
  it('is inverse-square with no cutoff and zero at the cutoff', () => {
    expect(distanceFalloff(2, 0, 2)).toBeCloseTo(0.25);
    expect(distanceFalloff(1, 0, 2)).toBeCloseTo(1);
    expect(distanceFalloff(8, 8, 2)).toBeCloseTo(0);
    expect(distanceFalloff(2, 8, 2)).toBeLessThan(0.25);
    expect(distanceFalloff(2, 8, 2)).toBeGreaterThan(0.2);
  });
});

describe('spotFactor', () => {
  it('is full inside the inner cone, zero outside, smooth between', () => {
    const angle = Math.PI / 6;
    expect(spotFactor(1, angle, 0.5)).toBe(1);
    expect(spotFactor(Math.cos(angle) - 0.01, angle, 0.5)).toBe(0);
    const mid = spotFactor((Math.cos(angle) + Math.cos(angle * 0.5)) / 2, angle, 0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('illuminanceAt', () => {
  const lamp: IlluminanceLight = { position: new THREE.Vector3(0, 3, 0), intensity: 22, distance: 8, decay: 2 };

  it('falls off with distance and stops at the cutoff', () => {
    const near = illuminanceAt([lamp], new THREE.Vector3(0, 1, 0));
    const far = illuminanceAt([lamp], new THREE.Vector3(0, 1, 5));
    expect(near).toBeGreaterThan(far);
    expect(illuminanceAt([lamp], new THREE.Vector3(0, 3, 9))).toBe(0);
    expect(illuminanceAt([], new THREE.Vector3(), { ambient: 0.3 })).toBeCloseTo(0.3);
  });

  it('spot lights only light their cone', () => {
    const spot: IlluminanceLight = { ...lamp, spot: { direction: new THREE.Vector3(0, -1, 0), angle: Math.PI / 8, penumbra: 0.2 } };
    expect(illuminanceAt([spot], new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0);
    expect(illuminanceAt([spot], new THREE.Vector3(4, 3, 0))).toBe(0);
  });

  it('drops occluded contributors, strongest first, up to the limit', () => {
    const a: IlluminanceLight = { position: new THREE.Vector3(0, 2, 0), intensity: 10, distance: 0, decay: 2 };
    const b: IlluminanceLight = { position: new THREE.Vector3(0, 2, 4), intensity: 10, distance: 0, decay: 2 };
    const p = new THREE.Vector3(0, 0, 0);
    const open = illuminanceAt([a, b], p);
    const blocked = illuminanceAt([a, b], p, { occluder: (from) => from.z === 0 });
    expect(blocked).toBeLessThan(open);
    expect(blocked).toBeCloseTo(illuminanceAt([b], p));
    // With maxOccluded 0 nothing is tested, so nothing is dropped.
    expect(illuminanceAt([a, b], p, { occluder: () => true, maxOccluded: 0 })).toBeCloseTo(open);
  });
});

describe('litness', () => {
  it('maps 0 to 0 and the reference to about 0.63, saturating above', () => {
    expect(litness(0)).toBe(0);
    expect(litness(2, 2)).toBeCloseTo(0.632, 2);
    expect(litness(100, 2)).toBeGreaterThan(0.99);
  });
});

describe('lightRecord', () => {
  it('reads point and spot lights and ignores directional ones', () => {
    const out = { position: new THREE.Vector3(), direction: new THREE.Vector3() };
    const point = new THREE.PointLight(0xffffff, 5, 7, 2);
    point.position.set(1, 2, 3);
    point.updateMatrixWorld();
    const rec = lightRecord(point, out);
    expect(rec?.intensity).toBe(5);
    expect(rec?.distance).toBe(7);
    expect(rec?.position.x).toBe(1);
    const spot = new THREE.SpotLight(0xffffff, 3, 10, Math.PI / 5, 0.3, 2);
    spot.position.set(0, 4, 0);
    spot.target.position.set(0, 0, 0);
    spot.updateMatrixWorld();
    spot.target.updateMatrixWorld();
    const srec = lightRecord(spot, out);
    expect(srec?.spot?.direction.y).toBeCloseTo(-1);
    expect(lightRecord(new THREE.DirectionalLight(), out)).toBeNull();
  });
});
