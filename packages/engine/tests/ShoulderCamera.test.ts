import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SHOULDER_PRESET, ShoulderCamera, clampPitch, shoulderFrame } from '../src/rendering/ShoulderCamera';

describe('shoulderFrame', () => {
  it('yaw 0 looks down -Z with +X on the right', () => {
    const f = new THREE.Vector3();
    const r = new THREE.Vector3();
    shoulderFrame(0, 0, f, r);
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-1);
    expect(r.x).toBeCloseTo(1);
    expect(r.z).toBeCloseTo(0);
  });

  it('positive pitch looks down', () => {
    const f = new THREE.Vector3();
    const r = new THREE.Vector3();
    shoulderFrame(0, 0.5, f, r);
    expect(f.y).toBeLessThan(0);
    expect(r.y).toBe(0);
  });
});

describe('clampPitch', () => {
  it('respects the asymmetric limits', () => {
    expect(clampPitch(10, SHOULDER_PRESET)).toBeCloseTo(SHOULDER_PRESET.maxPitchDown);
    expect(clampPitch(-10, SHOULDER_PRESET)).toBeCloseTo(-SHOULDER_PRESET.maxPitchUp);
    expect(clampPitch(0.1, SHOULDER_PRESET)).toBeCloseTo(0.1);
  });
});

describe('ShoulderCamera', () => {
  it('hangs behind and to the right of the shoulder pivot at the hip', () => {
    const cam = new ShoulderCamera();
    cam.target.set(0, 0, 0);
    cam.height = 1.8;
    cam.snap();
    const p = SHOULDER_PRESET;
    expect(cam.pivot.x).toBeCloseTo(p.sideOffset);
    expect(cam.pivot.y).toBeCloseTo(1.8 * p.shoulderRatio);
    expect(cam.camera.position.z).toBeCloseTo(p.distance);
    expect(cam.camera.position.x).toBeCloseTo(p.sideOffset);
    expect(cam.camera.fov).toBe(p.fov);
  });

  it('pulls in against an occluder and keeps the collision gap', () => {
    const cam = new ShoulderCamera();
    cam.snap(() => 1.0);
    expect(cam.camera.position.distanceTo(cam.pivot)).toBeCloseTo(1.0 - SHOULDER_PRESET.collisionRadius);
  });

  it('blends toward the aim numbers over time', () => {
    const cam = new ShoulderCamera();
    cam.snap();
    cam.aiming = true;
    for (let i = 0; i < 60; i++) cam.update(1 / 60);
    expect(cam.camera.fov).toBeCloseTo(SHOULDER_PRESET.aimFov, 0);
    expect(cam.camera.position.distanceTo(cam.pivot)).toBeCloseTo(SHOULDER_PRESET.aimDistance, 1);
  });

  it('recoil offsets the view without moving the look', () => {
    const cam = new ShoulderCamera();
    cam.snap();
    const f0 = new THREE.Vector3();
    cam.viewForward(f0);
    cam.recoilPitch = -0.2;
    cam.recoilYaw = 0.1;
    cam.snap();
    const f1 = new THREE.Vector3();
    cam.viewForward(f1);
    expect(f1.y).toBeGreaterThan(f0.y);
    expect(cam.getPitch()).toBe(0);
    expect(cam.getYaw()).toBe(0);
    expect(cam.effectiveYaw()).toBeCloseTo(0.1);
    cam.recoilPitch = 0;
    cam.recoilYaw = 0;
    cam.snap();
    cam.viewForward(f1);
    expect(f1.distanceTo(f0)).toBeCloseTo(0);
  });

  it('look() turns left for rightward pointer motion and clamps pitch', () => {
    const cam = new ShoulderCamera();
    cam.look(100, 0);
    expect(cam.getYaw()).toBeLessThan(0);
    cam.look(0, 1e6);
    expect(cam.getPitch()).toBeCloseTo(SHOULDER_PRESET.maxPitchDown);
  });
});
