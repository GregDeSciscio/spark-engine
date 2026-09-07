import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  FRUSTUM_FLOATS,
  FrustumResult,
  aabbInFrustum,
  extractFrustumPlanes,
  raySlabXZ,
  raySphere,
  sphereInFrustum,
} from '../src/world/Frustum';

/**
 * Flat-array frustum math: the hot path under culling and the spatial index,
 * written without three so it can run without allocating. Its correctness is
 * checked here against three's own `Frustum` — if the two ever disagree, the
 * cheap version is the one that is wrong.
 */

function planesFor(camera: THREE.PerspectiveCamera): Float32Array {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return extractFrustumPlanes(m.elements, new Float32Array(FRUSTUM_FLOATS));
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('extractFrustumPlanes', () => {
  it('produces normalised planes in three’s own convention', () => {
    const cam = camera();
    const planes = planesFor(cam);
    expect(planes).toHaveLength(FRUSTUM_FLOATS);
    for (let i = 0; i < FRUSTUM_FLOATS; i += 4) {
      const length = Math.hypot(planes[i] as number, planes[i + 1] as number, planes[i + 2] as number);
      expect(length).toBeCloseTo(1, 6);
    }
    const three = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (let i = 0; i < 6; i++) {
      const plane = three.planes[i]?.clone().normalize();
      expect(planes[i * 4]).toBeCloseTo(plane?.normal.x ?? 0, 5);
      expect(planes[i * 4 + 1]).toBeCloseTo(plane?.normal.y ?? 0, 5);
      expect(planes[i * 4 + 2]).toBeCloseTo(plane?.normal.z ?? 0, 5);
      expect(planes[i * 4 + 3]).toBeCloseTo(plane?.constant ?? 0, 5);
    }
  });
});

describe('sphereInFrustum', () => {
  it('agrees with three across a grid of spheres', () => {
    const cam = camera();
    const planes = planesFor(cam);
    const three = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere();
    let inside = 0;
    let outside = 0;
    for (let x = -40; x <= 40; x += 7) {
      for (let y = -10; y <= 20; y += 6) {
        for (let z = -60; z <= 40; z += 9) {
          for (const radius of [0.5, 4]) {
            const mine = sphereInFrustum(planes, x, y, z, radius);
            const theirs = three.intersectsSphere(sphere.set(new THREE.Vector3(x, y, z), radius));
            expect(mine, `sphere (${x}, ${y}, ${z}) r=${radius}`).toBe(theirs);
            if (mine) inside++;
            else outside++;
          }
        }
      }
    }
    // A grid that lands entirely on one side would prove nothing.
    expect(inside).toBeGreaterThan(20);
    expect(outside).toBeGreaterThan(20);
  });

  it('keeps a sphere whose centre is outside but whose surface reaches in', () => {
    const cam = camera();
    const planes = planesFor(cam);
    expect(sphereInFrustum(planes, 0, 2, 12, 0.5)).toBe(false); // behind the camera
    expect(sphereInFrustum(planes, 0, 2, 12, 4)).toBe(true); // big enough to cross the near plane
  });
});

describe('aabbInFrustum', () => {
  it('separates fully inside from straddling from outside', () => {
    const cam = camera();
    const planes = planesFor(cam);
    expect(aabbInFrustum(planes, -1, 1.5, -1, 1, 2.5, 1)).toBe(FrustumResult.Inside);
    // A box behind the camera.
    expect(aabbInFrustum(planes, -1, 1, 20, 1, 3, 22)).toBe(FrustumResult.Outside);
    // A long box running from behind the camera to well in front of it.
    expect(aabbInFrustum(planes, -1, 1, -5, 1, 3, 20)).toBe(FrustumResult.Intersect);
  });

  it('treats a box off to the side as outside', () => {
    const cam = camera();
    const planes = planesFor(cam);
    expect(aabbInFrustum(planes, 60, 1, -5, 62, 3, -3)).toBe(FrustumResult.Outside);
  });
});

describe('raySphere', () => {
  it('returns the entry distance along the ray', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 100, 0, 0, -10, 2)).toBeCloseTo(8, 6);
  });

  it('returns 0 when the ray starts inside', () => {
    expect(raySphere(0, 0, -10, 0, 0, -1, 100, 0, 0, -10, 2)).toBe(0);
  });

  it('misses a sphere beside the ray, behind it, or past the limit', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 100, 5, 0, -10, 2)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, -1, 100, 0, 0, 10, 2)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, -1, 5, 0, 0, -10, 2)).toBe(-1);
  });

  it('grazes a sphere it exactly touches', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 100, 2, 0, -10, 2)).toBeCloseTo(10, 4);
  });
});

describe('raySlabXZ', () => {
  const box = { minX: -1, minZ: -11, maxX: 1, maxZ: -9 };

  it('hits a box in front of the ray', () => {
    expect(raySlabXZ(0, 0, 0, -1, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(true);
  });

  it('misses a box beside the ray or behind it', () => {
    expect(raySlabXZ(5, 0, 0, -1, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(false);
    expect(raySlabXZ(0, 0, 0, 1, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(false);
  });

  it('respects the segment length', () => {
    expect(raySlabXZ(0, 0, 0, -1, 8, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(false);
    expect(raySlabXZ(0, 0, 0, -1, 9.5, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(true);
  });

  it('handles an axis-parallel ray without dividing by zero', () => {
    // dz = 0: inside the z slab, so the x slab decides.
    expect(raySlabXZ(-5, -10, 1, 0, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(true);
    // dz = 0 and outside the z slab: no distance along x can help.
    expect(raySlabXZ(-5, 5, 1, 0, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(false);
  });

  it('reports a ray that starts inside the box', () => {
    expect(raySlabXZ(0, -10, 1, 0, 100, box.minX, box.minZ, box.maxX, box.maxZ)).toBe(true);
  });
});
