import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Renderable, Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { InstancedBatch, InstancedRenderSync } from '../src/ecs/systems/InstancedRenderSync';
import { Cullable, LOD, LOD_UNASSIGNED } from '../src/world/components';
import { CullingSystem, isVisible } from '../src/world/CullingSystem';
import { extractFrustumPlanes } from '../src/world/Frustum';
import { LODSystem, selectLOD } from '../src/world/LODSystem';
import { SpatialIndex } from '../src/world/SpatialIndex';

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 200);
  cam.position.set(0, 5, 0);
  cam.lookAt(0, 5, -10); // looking down -Z
  cam.updateMatrixWorld();
  return cam;
}

describe('selectLOD', () => {
  const thresholds = [10, 30];

  it('walks thresholds without history', () => {
    expect(selectLOD(5, thresholds, LOD_UNASSIGNED, 0.1)).toBe(0);
    expect(selectLOD(10, thresholds, LOD_UNASSIGNED, 0.1)).toBe(1);
    expect(selectLOD(29.9, thresholds, LOD_UNASSIGNED, 0.1)).toBe(1);
    expect(selectLOD(1000, thresholds, LOD_UNASSIGNED, 0.1)).toBe(2);
    expect(selectLOD(5, [], LOD_UNASSIGNED, 0.1)).toBe(0);
  });

  it('applies hysteresis so a boundary sitter does not flicker', () => {
    // Coming from level 0, need to pass 11 to go up.
    expect(selectLOD(10.5, thresholds, 0, 0.1)).toBe(0);
    expect(selectLOD(11.01, thresholds, 0, 0.1)).toBe(1);
    // Coming from level 1, need to drop under 9 to come back.
    expect(selectLOD(9.5, thresholds, 1, 0.1)).toBe(1);
    expect(selectLOD(8.9, thresholds, 1, 0.1)).toBe(0);
    // Oscillating around 10 keeps the level stable.
    let level = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const d = 10 + Math.sin(i) * 0.9;
      level = selectLOD(d, thresholds, level, 0.1);
      seen.add(level);
    }
    expect(seen.size).toBe(1);
  });

  it('can jump several levels in one step', () => {
    expect(selectLOD(500, thresholds, 0, 0.1)).toBe(2);
    expect(selectLOD(1, thresholds, 2, 0.1)).toBe(0);
  });
});

describe('isVisible', () => {
  it('combines frustum and distance', () => {
    const cam = camera();
    const planes = extractFrustumPlanes(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements, new Float32Array(24));
    expect(isVisible(planes, 0, 5, 0, 0, 5, -20, 1, 0)).toBe(true);
    expect(isVisible(planes, 0, 5, 0, 0, 5, 20, 1, 0)).toBe(false); // behind
    expect(isVisible(planes, 0, 5, 0, 0, 5, -20, 1, 10)).toBe(false); // too far
    expect(isVisible(planes, 0, 5, 0, 0, 5, -20, 1, 25)).toBe(true);
  });
});

describe('CullingSystem', () => {
  function fixture(withIndex: boolean) {
    const world = new EntityWorld({ capacity: 256 });
    const spatial = withIndex ? new SpatialIndex({ cellSize: 10, minX: -200, minZ: -200, maxX: 200, maxZ: 200, capacity: 257 }) : undefined;
    const culling = new CullingSystem({ spatial, drawDistance: 1 });
    world.addSystem(culling);
    const cam = camera();
    culling.setCamera(cam);
    const spawn = (x: number, y: number, z: number, maxDistance = 0): number => {
      const eid = world.create([Transform, { x, y, z }], Renderable, [Cullable, { radius: 1, maxDistance }]);
      spatial?.insert(eid, x, y, z, 1);
      return eid;
    };
    return { world, spatial, culling, cam, spawn };
  }

  for (const withIndex of [false, true]) {
    it(`writes Renderable.visible for opted-in entities only (index=${withIndex})`, () => {
      const f = fixture(withIndex);
      const inView = f.spawn(0, 5, -30);
      const behind = f.spawn(0, 5, 30);
      const tooFar = f.spawn(0, 5, -100, 50);
      const plain = f.world.create([Transform, { z: 30 }], Renderable);
      f.world.runStage('late', 1 / 60);
      const r = f.world.store(Renderable);
      expect(r.visible[inView]).toBe(1);
      expect(r.visible[behind]).toBe(0);
      expect(r.visible[tooFar]).toBe(0);
      expect(r.visible[plain]).toBe(1);
      const s = f.culling.stats();
      expect(s.candidates).toBe(3);
      expect(s.visible).toBe(1);
      expect(s.culled).toBe(2);
      expect(s.changed).toBe(2);
      // Second frame: nothing changed.
      f.world.runStage('late', 1 / 60);
      expect(f.culling.stats().changed).toBe(0);
      // Turn the camera around: the sets swap.
      f.cam.lookAt(0, 5, 10);
      f.world.runStage('late', 1 / 60);
      expect(r.visible[inView]).toBe(0);
      expect(r.visible[behind]).toBe(1);
      f.world.dispose();
    });
  }

  it('scales max distance by drawDistance', () => {
    const f = fixture(true);
    const eid = f.spawn(0, 5, -60, 50);
    f.world.runStage('late', 1 / 60);
    expect(f.world.store(Renderable).visible[eid]).toBe(0);
    f.culling.setDrawDistance(1.5);
    f.world.runStage('late', 1 / 60);
    expect(f.world.store(Renderable).visible[eid]).toBe(1);
    f.world.dispose();
  });
});

describe('LODSystem', () => {
  it('moves entities between batches with hysteresis and frees slots on destroy', () => {
    const world = new EntityWorld({ capacity: 64 });
    const instanced = new InstancedRenderSync(world);
    const lod = new LODSystem(world, { lodBias: 1 });
    world.addSystem(lod);
    world.addSystem(instanced);
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const near = instanced.createBatch(geometry, material, 16, { static: true });
    const far = instanced.createBatch(geometry, material, 16, { static: true });
    const group = lod.defineGroup({ distances: [10, 30], hysteresis: 0.1, batches: [near, far, null] });
    expect(lod.levelCount(group)).toBe(3);
    const cam = camera();
    lod.setCamera(cam);

    const a = world.create([Transform, { x: 0, y: 5, z: -5 }], Renderable);
    const b = world.create([Transform, { x: 0, y: 5, z: -17 }], Renderable);
    const c = world.create([Transform, { x: 0, y: 5, z: -100 }], Renderable);
    lod.add(world, a, group);
    lod.add(world, b, group);
    lod.add(world, c, group);
    world.runStage('late', 1 / 60);
    const store = world.store(LOD);
    expect(store.level[a]).toBe(0);
    expect(store.level[b]).toBe(1);
    expect(store.level[c]).toBe(2);
    expect(near.has(a)).toBe(true);
    expect(far.has(b)).toBe(true);
    expect(near.has(c) || far.has(c)).toBe(false);
    expect(lod.stats().switches).toBe(3);
    expect(lod.stats().perLevel.slice(0, 3)).toEqual([1, 1, 1]);

    // Move a to just past the threshold: hysteresis holds level 0.
    const t = world.store(Transform);
    t.z[a] = -10.5;
    world.runStage('late', 1 / 60);
    expect(store.level[a]).toBe(0);
    t.z[a] = -12;
    world.runStage('late', 1 / 60);
    expect(store.level[a]).toBe(1);
    expect(near.has(a)).toBe(false);
    expect(far.has(a)).toBe(true);

    // Bias 2 keeps detail out to 20/60 (b at 17 is under 20 × 0.9).
    lod.setLODBias(2);
    world.runStage('late', 1 / 60);
    expect(store.level[a]).toBe(0);
    expect(store.level[b]).toBe(0);
    expect(store.level[c]).toBe(2);

    // Destroying frees the slot through the onRemove hook.
    world.destroy(a);
    expect(near.has(a)).toBe(false);
    expect(near.count).toBe(1);
    lod.remove(world, b);
    expect(near.has(b)).toBe(false);
    expect(world.has(b, LOD)).toBe(false);
    world.dispose();
  });

  it('object route toggles visibility per level', () => {
    const world = new EntityWorld({ capacity: 16 });
    const lod = new LODSystem(world);
    world.addSystem(lod);
    lod.setCamera(camera());
    const group = lod.defineGroup({ distances: [20] });
    const eid = world.create([Transform, { x: 0, y: 5, z: -5 }]);
    lod.add(world, eid, group);
    const hi = new THREE.Object3D();
    const lo = new THREE.Object3D();
    lod.attachObjects(world, eid, [hi, lo]);
    world.runStage('late', 1 / 60);
    expect(hi.visible).toBe(true);
    expect(lo.visible).toBe(false);
    world.store(Transform).z[eid] = -50;
    world.runStage('late', 1 / 60);
    expect(hi.visible).toBe(false);
    expect(lo.visible).toBe(true);
    expect(() => lod.defineGroup({ distances: [5, 1] })).toThrow(/ascending/);
    world.dispose();
  });
});

describe('InstancedBatch static mode', () => {
  it('rebuilds only dirty slots and uploads one range', () => {
    const world = new EntityWorld({ capacity: 64 });
    const batch = new InstancedBatch(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 8, { static: true });
    const ids = [1, 2, 3].map((i) => world.create([Transform, { x: i }], Renderable));
    for (const id of ids) batch.add(id);
    batch.update(world);
    expect(batch.lastUploaded).toBe(3);
    expect(batch.visibleCount).toBe(3);
    const ranges = batch.mesh.instanceMatrix.updateRanges;
    expect(ranges.length).toBe(1);
    expect(ranges[0]).toEqual({ start: 0, count: 48 });
    batch.mesh.instanceMatrix.clearUpdateRanges();
    // Nothing changed: no work.
    batch.update(world);
    expect(batch.lastUploaded).toBe(0);
    expect(batch.mesh.instanceMatrix.updateRanges.length).toBe(0);
    // Flip visibility of the middle one: one slot rebuilt.
    world.store(Renderable).visible[ids[1] as number] = 0;
    batch.update(world);
    expect(batch.lastUploaded).toBe(1);
    expect(batch.visibleCount).toBe(2);
    expect(batch.mesh.instanceMatrix.updateRanges[0]).toEqual({ start: 16, count: 16 });
    const m = new THREE.Matrix4();
    batch.mesh.getMatrixAt(1, m);
    expect(m.elements[0]).toBe(0); // scale 0 = hidden
    batch.mesh.instanceMatrix.clearUpdateRanges();
    // Removing the first swaps the last into its slot and dirties it.
    batch.remove(ids[0] as number);
    expect(batch.count).toBe(2);
    batch.update(world);
    expect(batch.lastUploaded).toBe(1);
    batch.mesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBe(3); // x of entity 3 now in slot 0
    // markDirty after a transform write.
    world.store(Transform).x[ids[2] as number] = 9;
    batch.markDirty(ids[2] as number);
    batch.update(world);
    batch.mesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBe(9);
    batch.dispose();
    world.dispose();
  });
});
