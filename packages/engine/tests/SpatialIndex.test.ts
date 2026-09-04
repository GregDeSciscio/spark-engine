import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { FrustumResult, aabbInFrustum, extractFrustumPlanes, raySphere, sphereInFrustum } from '../src/world/Frustum';
import { SpatialIndex } from '../src/world/SpatialIndex';

/** Planes of a camera at the origin looking down -Z, matching three's Frustum. */
function cameraPlanes(camera: THREE.Camera): Float32Array {
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return extractFrustumPlanes(m.elements, new Float32Array(24));
}

describe('Frustum math', () => {
  it('extracts planes that agree with three.Frustum for spheres', () => {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 100);
    camera.position.set(3, 2, 10);
    camera.lookAt(0, 0, 0);
    const planes = cameraPlanes(camera);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    let agree = 0;
    for (let i = 0; i < 500; i++) {
      // Deterministic pseudo-random points.
      const x = ((i * 37) % 200) - 100;
      const y = ((i * 91) % 60) - 30;
      const z = ((i * 53) % 260) - 130;
      const r = (i % 7) + 0.5;
      sphere.center.set(x, y, z);
      sphere.radius = r;
      expect(sphereInFrustum(planes, x, y, z, r)).toBe(frustum.intersectsSphere(sphere));
      agree++;
    }
    expect(agree).toBe(500);
  });

  it('classifies boxes as outside / intersecting / inside', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 100);
    const planes = cameraPlanes(camera); // at origin, looking down -Z
    expect(aabbInFrustum(planes, -1, -1, -30, 1, 1, -20)).toBe(FrustumResult.Inside);
    expect(aabbInFrustum(planes, 50, -1, -30, 60, 1, -20)).toBe(FrustumResult.Outside);
    expect(aabbInFrustum(planes, -1, -1, 5, 1, 1, 10)).toBe(FrustumResult.Outside); // behind
    expect(aabbInFrustum(planes, -1, -1, -120, 1, 1, -80)).toBe(FrustumResult.Intersect); // crosses far plane
    expect(aabbInFrustum(planes, -40, -1, -30, 40, 1, -20)).toBe(FrustumResult.Intersect);
  });

  it('ray vs sphere returns the entry distance and respects maxDist', () => {
    expect(raySphere(0, 0, 0, 1, 0, 0, 100, 10, 0, 0, 2)).toBeCloseTo(8);
    expect(raySphere(0, 0, 0, 1, 0, 0, 5, 10, 0, 0, 2)).toBe(-1);
    expect(raySphere(0, 0, 0, 1, 0, 0, 100, 10, 5, 0, 2)).toBe(-1);
    expect(raySphere(0, 0, 0, -1, 0, 0, 100, 10, 0, 0, 2)).toBe(-1);
    expect(raySphere(10, 0, 0, 1, 0, 0, 100, 10, 0, 0, 2)).toBe(0); // inside
  });
});

describe('SpatialIndex', () => {
  function makeIndex(): SpatialIndex {
    return new SpatialIndex({ cellSize: 10, minX: -100, minZ: -100, maxX: 100, maxZ: 100, capacity: 1024 });
  }

  it('inserts, updates, removes and tracks occupancy', () => {
    const index = makeIndex();
    expect(index.cellCount).toBe(400);
    index.insert(1, 5, 0, 5, 1);
    index.insert(2, 5, 0, 5, 1);
    index.insert(3, -95, 0, -95, 1);
    expect(index.size).toBe(3);
    expect(index.stats().occupiedCells).toBe(2);
    index.update(2, 55, 0, 55, 1); // moves cell
    expect(index.stats().occupiedCells).toBe(3);
    expect(index.remove(1)).toBe(true);
    expect(index.remove(1)).toBe(false);
    expect(index.stats().occupiedCells).toBe(2);
    expect(index.has(1)).toBe(false);
    expect(index.has(2)).toBe(true);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.stats().occupiedCells).toBe(0);
    expect(() => index.insert(5000, 0, 0, 0, 1)).toThrow(/out of range/);
  });

  it('clamps entries outside the grid to edge cells (loose grid)', () => {
    const index = makeIndex();
    index.insert(1, 500, 0, -500, 1);
    expect(index.has(1)).toBe(true);
    const out: number[] = [];
    expect(index.queryRadius(500, 0, -500, 2, out)).toBe(1);
    expect(out).toEqual([1]);
  });

  it('queryRadius is exact on spheres and allocation-free on repeat', () => {
    const index = makeIndex();
    for (let i = 0; i < 200; i++) index.insert(i + 1, (i % 20) * 10 - 95, 0, Math.floor(i / 20) * 10 - 95, 0.5);
    const out: number[] = [];
    const n = index.queryRadius(0, 0, 0, 15, out);
    expect(n).toBe(out.length);
    for (const id of out) {
      const dx = index.centerX(id);
      const dz = index.centerZ(id);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(15.5);
    }
    // Brute force check.
    let expected = 0;
    for (let i = 1; i <= 200; i++) if (Math.hypot(index.centerX(i), index.centerZ(i)) <= 15.5) expected++;
    expect(n).toBe(expected);
    const same = index.queryRadius(0, 0, 0, 15, out);
    expect(same).toBe(n);
  });

  it('queryFrustum matches brute-force sphere tests and skips per-entity tests for interior cells', () => {
    const index = makeIndex();
    const positions: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 10 - 95 + (i % 3) - 1;
      const z = Math.floor(i / 20) * 10 - 95 + (i % 5) - 2;
      const r = 0.5 + (i % 4) * 0.5;
      positions.push([i + 1, x, r, z]);
      index.insert(i + 1, x, r, z, r);
    }
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 120);
    camera.position.set(0, 25, 60);
    camera.lookAt(0, 0, 0);
    const planes = cameraPlanes(camera);
    const out: number[] = [];
    const n = index.queryFrustum(planes, out);
    const expected = positions.filter(([, x, r, z]) => sphereInFrustum(planes, x, r, z, r)).map(([id]) => id);
    expect(n).toBe(expected.length);
    expect([...out].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
    const stats = index.stats();
    expect(stats.lastCellsVisited).toBeGreaterThan(0);
    // Interior cells skip per-entity tests, so fewer tests than candidates.
    expect(stats.lastEntityTests).toBeLessThan(n);
  });

  it('queryRay finds spheres along a ray and hitDistance orders them', () => {
    const index = makeIndex();
    index.insert(1, 30, 0, 0, 1);
    index.insert(2, 60, 0, 0, 1);
    index.insert(3, 60, 0, 20, 1); // off the ray
    index.insert(4, -20, 0, 0, 1); // behind
    index.insert(5, 45, 0, 0.8, 1); // grazing
    const out: number[] = [];
    const n = index.queryRay(0, 0, 0, 2, 0, 0, 100, out);
    expect(n).toBe(3);
    out.sort((a, b) => index.hitDistance(a, 0, 0, 0, 1, 0, 0, 100) - index.hitDistance(b, 0, 0, 0, 1, 0, 0, 100));
    expect(out).toEqual([1, 5, 2]);
    expect(index.queryRay(0, 0, 0, 1, 0, 0, 40, out)).toBe(1);
    expect(out).toEqual([1]);
    // Diagonal ray through a cell corner region.
    index.clear();
    index.insert(7, 50, 0, 50, 2);
    expect(index.queryRay(0, 0, 0, 1, 0, 1, 200, out)).toBe(1);
    expect(index.queryRay(0, 0, 0, 1, 0, -1, 200, out)).toBe(0);
  });
});
