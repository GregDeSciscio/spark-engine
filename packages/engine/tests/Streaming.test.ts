import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { AssetManager } from '../src/assets/AssetManager';
import type { ModelAsset } from '../src/assets/ModelAsset';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { InstancedRenderSync } from '../src/ecs/systems/InstancedRenderSync';
import { Streamed } from '../src/world/components';
import { LODSystem } from '../src/world/LODSystem';
import { SpatialIndex } from '../src/world/SpatialIndex';
import { StreamingManager, type ChunkSource, type StreamedAssetDefinition } from '../src/world/StreamingManager';
import { StreamingPlanner } from '../src/world/StreamingPlanner';

describe('StreamingPlanner', () => {
  function planner(overrides: Partial<ConstructorParameters<typeof StreamingPlanner>[0]> = {}): StreamingPlanner {
    return new StreamingPlanner({
      chunkSize: 10,
      minChunkX: -20,
      minChunkZ: -20,
      maxChunkX: 19,
      maxChunkZ: 19,
      loadRadius: 35,
      unloadRadius: 50,
      directionWeight: 0.5,
      ...overrides,
    });
  }

  it('packs and unpacks chunk keys and clamps keyAt', () => {
    const p = planner();
    expect(p.cols).toBe(40);
    expect(p.rows).toBe(40);
    const key = p.key(3, -7);
    expect(p.chunkX(key)).toBe(3);
    expect(p.chunkZ(key)).toBe(-7);
    expect(p.key(-21, 0)).toBe(-1);
    expect(p.key(20, 0)).toBe(-1);
    expect(p.keyAt(35, -65)).toBe(p.key(3, -7));
    expect(p.keyAt(-9999, 9999)).toBe(p.key(-20, 19));
    expect(p.centreXOf(p.key(3, -7))).toBe(35);
    expect(() => planner({ unloadRadius: 10 })).toThrow(/unloadRadius/);
  });

  it('wants every chunk inside the load radius, nearest first, ahead of the heading before behind', () => {
    const p = planner();
    expect(p.setTarget(5, 5, 1, 0)).toBe(true);
    const queue = p.queue;
    expect(queue.length).toBeGreaterThan(0);
    for (const key of queue) expect(p.distanceTo(key)).toBeLessThanOrEqual(35);
    // Every chunk within the radius is present.
    let expected = 0;
    for (let cz = -20; cz <= 19; cz++) for (let cx = -20; cx <= 19; cx++) if (Math.hypot((cx + 0.5) * 10 - 5, (cz + 0.5) * 10 - 5) <= 35) expected++;
    expect(queue.length).toBe(expected);
    // First is the chunk under the target.
    expect(queue[0]).toBe(p.key(0, 0));
    // Ahead (+x) beats behind (-x) at equal distance.
    const ahead = queue.indexOf(p.key(2, 0));
    const behind = queue.indexOf(p.key(-2, 0));
    expect(ahead).toBeLessThan(behind);
    // Priorities are non-decreasing along the queue.
    for (let i = 1; i < queue.length; i++) expect(p.priority(queue[i] as number)).toBeGreaterThanOrEqual(p.priority(queue[i - 1] as number));
  });

  it('replans only when the target moves or turns enough', () => {
    const p = planner();
    expect(p.setTarget(0, 0, 0, 1)).toBe(true);
    expect(p.setTarget(1, 0, 0, 1)).toBe(false); // under chunkSize / 4
    expect(p.setTarget(0, 0, 0.1, 1)).toBe(false); // ~6° turn
    expect(p.setTarget(0, 0, 1, 1)).toBe(true); // 45° turn
    expect(p.setTarget(3, 0, 1, 1)).toBe(true); // moved 3 >= 2.5
    expect(p.replanCount).toBe(3);
  });

  it('hysteresis: chunks between the load and unload radius are neither wanted nor released', () => {
    const p = planner();
    p.setTarget(0, 0, 0, 0);
    const near = p.key(1, 0); // 15 away
    const band = p.key(4, 0); // 45 away
    const far = p.key(6, 0); // 65 away
    expect(p.isWanted(near)).toBe(true);
    expect(p.shouldUnload(near)).toBe(false);
    expect(p.isWanted(band)).toBe(false);
    expect(p.shouldUnload(band)).toBe(false);
    expect(p.isWanted(far)).toBe(false);
    expect(p.shouldUnload(far)).toBe(true);
  });

  it('lookAhead shifts the streaming centre along the heading', () => {
    const p = planner({ lookAhead: 20 });
    p.setTarget(0, 0, 0, -1);
    expect(p.centre).toEqual({ x: 0, z: -20 });
    expect(p.queue).toContain(p.key(0, -5)); // 55 ahead of the target, 35 from the centre
    expect(p.queue).not.toContain(p.key(0, 2)); // 25 behind the target, 45 from the centre
  });
});

// ---- manager ------------------------------------------------------------------

interface FakeAssets {
  manager: AssetManager;
  refs: Map<string, number>;
  resolve(url: string): void;
  pending(url: string): number;
}

/** A stand-in for AssetManager: ref-counted, manually resolved model loads. */
function fakeAssets(): FakeAssets {
  const refs = new Map<string, number>();
  const waiters = new Map<string, Array<(m: ModelAsset) => void>>();
  const inflight = new Map<string, Promise<ModelAsset>>();
  const models = new Map<string, ModelAsset>();
  const manager = {
    loadModel(url: string): Promise<ModelAsset> {
      refs.set(url, (refs.get(url) ?? 0) + 1);
      const model = models.get(url);
      if (model) return Promise.resolve(model);
      // Like AssetCache: repeated requests join the one in-flight load.
      let load = inflight.get(url);
      if (!load) {
        load = new Promise<ModelAsset>((resolve) => {
          waiters.set(url, [resolve]);
        });
        inflight.set(url, load);
      }
      return load;
    },
    release(url: string): boolean {
      const n = (refs.get(url) ?? 0) - 1;
      refs.set(url, n);
      if (n === 0) models.delete(url);
      return true;
    },
  } as unknown as AssetManager;
  return {
    manager,
    refs,
    resolve(url: string): void {
      const model = { url, template: new THREE.Group() } as unknown as ModelAsset;
      models.set(url, model);
      for (const w of waiters.get(url) ?? []) w(model);
      waiters.delete(url);
      inflight.delete(url);
    },
    pending(url: string): number {
      return waiters.get(url)?.length ?? 0;
    },
  };
}

function definition(capacity = 4096): StreamedAssetDefinition {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial();
  return {
    levels: [
      { geometry, material },
      { geometry, material },
      null,
    ],
    lodDistances: [20, 60],
    radius: 1,
    maxDistance: 0,
    capacity,
  };
}

/** Five placements per chunk, deterministic from the chunk coordinates. */
const source: ChunkSource = {
  chunkAt(cx, cz) {
    const placements = [];
    for (let i = 0; i < 5; i++) {
      placements.push({
        asset: i === 4 ? '/models/thing.glb' : 'procedural:box',
        position: [cx * 10 + i * 2, 0, cz * 10 + 1] as [number, number, number],
        scale: 1 + (i % 2),
      });
    }
    return { placements };
  },
};

function fixture(options: { maxChunksPerFrame?: number; strictOrder?: boolean; withModel?: boolean } = {}) {
  const world = new EntityWorld({ capacity: 4096 });
  const instanced = new InstancedRenderSync(world);
  const lod = new LODSystem(world);
  const spatial = new SpatialIndex({ cellSize: 10, minX: -200, minZ: -200, maxX: 200, maxZ: 200, capacity: 4097 });
  const assets = fakeAssets();
  const scene = new THREE.Scene();
  const manager = new StreamingManager({
    entities: world,
    assets: assets.manager,
    scene,
    instanced,
    lod,
    spatial,
    source: options.withModel === false ? { chunkAt: (cx, cz) => ({ placements: source.chunkAt(cx, cz).placements.filter((p) => p.asset.startsWith('procedural')) }) } : source,
    chunkSize: 10,
    minChunkX: -20,
    minChunkZ: -20,
    maxChunkX: 19,
    maxChunkZ: 19,
    loadRadius: 25,
    unloadRadius: 40,
    budget: { maxChunksPerFrame: options.maxChunksPerFrame ?? 2, maxMs: Infinity },
    strictOrder: options.strictOrder,
  });
  manager.registerProcedural('box', definition());
  manager.registerModel('/models/thing.glb', () => definition());
  world.addSystem(manager);
  world.addSystem(lod);
  world.addSystem(instanced);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 10, 0);
  lod.setCamera(camera);
  const loaded: string[] = [];
  const unloaded: string[] = [];
  manager.events.on('chunkLoaded', (e) => loaded.push(`${e.cx},${e.cz}`));
  manager.events.on('chunkUnloaded', (e) => unloaded.push(`${e.cx},${e.cz}`));
  const tick = (): void => {
    world.runStage('update', 1 / 60);
    world.runStage('late', 1 / 60);
  };
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { world, manager, lod, spatial, assets, scene, loaded, unloaded, tick, flush };
}

describe('StreamingManager', () => {
  it('activates procedural chunks under the per-frame budget, nearest first, and creates entities', () => {
    const f = fixture({ maxChunksPerFrame: 1, withModel: false });
    f.manager.setTarget(5, 5, 0, 0);
    f.tick();
    expect(f.loaded).toEqual(['0,0']);
    expect(f.manager.stats().active).toBe(1);
    expect(f.manager.stats().entities).toBe(4);
    expect(f.manager.stats().queued).toBeGreaterThan(0);
    f.tick();
    f.tick();
    expect(f.loaded.length).toBe(3);
    expect(f.manager.stats().activatedLastFrame).toBe(1);
    expect(f.spatial.size).toBe(12);
    expect(f.world.query(Streamed).length).toBe(12);
    // Batches exist for the two drawn levels and hold every entity after LOD ran.
    const s = f.manager.stats();
    expect(s.batches).toBe(2);
    expect(s.instances).toBe(12);
    f.manager.dispose();
    expect(f.world.query(Streamed).length).toBe(0);
    expect(f.spatial.size).toBe(0);
    f.world.dispose();
  });

  it('is deterministic: the same path gives the same activation sequence', () => {
    const path: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 40; i++) path.push([i * 3, Math.sin(i * 0.3) * 20, 1, Math.cos(i * 0.3) * 0.5]);
    const run = (): string[] => {
      const f = fixture({ maxChunksPerFrame: 2, withModel: false });
      for (const [x, z, dx, dz] of path) {
        f.manager.setTarget(x, z, dx, dz);
        f.tick();
      }
      const events = [...f.loaded.map((k) => `+${k}`), ...f.unloaded.map((k) => `-${k}`)];
      f.manager.dispose();
      f.world.dispose();
      return events;
    };
    const a = run();
    const b = run();
    expect(a.length).toBeGreaterThan(30);
    expect(a).toEqual(b);
  });

  it('unloads with hysteresis and never more than the unload budget per frame', () => {
    const f = fixture({ maxChunksPerFrame: 100, withModel: false });
    f.manager.setTarget(0, 0, 0, 0);
    f.tick();
    const active = f.manager.stats().active;
    expect(active).toBeGreaterThan(10);
    // Chunk (-2, 0): centre at -15, active. Move the target so it sits in the band (25 < d < 40).
    f.manager.setTarget(20, 0, 1, 0);
    f.tick();
    expect(f.manager.isActive(-2, 0)).toBe(true);
    expect(f.unloaded).toEqual([]);
    // Now beyond the unload radius: released, at most 2 per frame.
    f.manager.setTarget(60, 0, 1, 0);
    f.tick();
    expect(f.manager.stats().unloadedLastFrame).toBe(2);
    expect(f.unloaded.length).toBe(2);
    for (let i = 0; i < 50; i++) f.tick();
    expect(f.manager.isActive(-2, 0)).toBe(false);
    expect(f.manager.isActive(6, 0)).toBe(true);
    // Every entity of released chunks is gone from the index and the world.
    expect(f.spatial.size).toBe(f.manager.stats().entities);
    expect(f.world.query(Streamed).length).toBe(f.manager.stats().entities);
    f.manager.dispose();
    f.world.dispose();
  });

  it('acquires models per chunk, activates once resident, and releases on unload', async () => {
    const f = fixture({ maxChunksPerFrame: 100 });
    const url = '/models/thing.glb';
    f.manager.setTarget(0, 0, 0, 0);
    f.tick();
    // Nothing activates until the model is resident; each loading chunk took a
    // reference, and loads in flight are capped by the budget (default 8).
    expect(f.manager.stats().active).toBe(0);
    const wanted = f.manager.planner.queue.length;
    expect(wanted).toBeGreaterThan(8);
    expect(f.manager.stats().loading).toBe(8);
    expect(f.assets.refs.get(url)).toBe(8);
    expect(f.assets.pending(url)).toBe(1); // one in-flight load; the other chunks joined it
    f.assets.resolve(url);
    await f.flush();
    f.tick();
    // The resident model makes the remaining chunks ready synchronously.
    expect(f.manager.stats().active).toBe(wanted);
    expect(f.assets.refs.get(url)).toBe(wanted);
    expect(f.manager.stats().batches).toBe(4);
    expect(f.manager.groupOf(url)).toBeGreaterThanOrEqual(0);
    // Move far away: old chunks unload two per frame and give back their
    // references while the new neighbourhood takes its own, so the model
    // stays resident (the cache never hits zero) and no reload happens.
    f.manager.setTarget(150, 150, 0, 0);
    for (let i = 0; i < 100; i++) f.tick();
    expect(f.manager.isActive(0, 0)).toBe(false);
    expect(f.manager.isActive(15, 15)).toBe(true);
    expect(f.assets.pending(url)).toBe(0);
    const stillActive = f.manager.stats().active;
    expect(stillActive).toBeGreaterThan(0);
    // References = chunks referencing the asset (loading or active).
    expect(f.assets.refs.get(url)).toBe(stillActive + f.manager.stats().loading);
    // Once every chunk is gone, so is the reference and the batches.
    f.manager.clear();
    expect(f.assets.refs.get(url)).toBe(0);
    expect(f.manager.stats().batches).toBe(2); // procedural batches stay, the model's are torn down
    f.manager.dispose();
    expect(f.assets.refs.get(url)).toBe(0);
    f.world.dispose();
  });

  it('strict order blocks on a loading head; default order does not', async () => {
    const strict = fixture({ maxChunksPerFrame: 100, strictOrder: true });
    strict.manager.setTarget(0, 0, 0, 0);
    strict.tick();
    expect(strict.manager.stats().active).toBe(0);
    strict.manager.dispose();
    strict.world.dispose();

    // A source where only the chunk under the target needs the model.
    const world = new EntityWorld({ capacity: 4096 });
    const instanced = new InstancedRenderSync(world);
    const lod = new LODSystem(world);
    const assets = fakeAssets();
    const manager = new StreamingManager({
      entities: world,
      assets: assets.manager,
      scene: new THREE.Scene(),
      instanced,
      lod,
      source: {
        chunkAt: (cx, cz) => ({ placements: [{ asset: cx === 0 && cz === 0 ? '/models/thing.glb' : 'procedural:box', position: [cx * 10, 0, cz * 10] }] }),
      },
      chunkSize: 10,
      minChunkX: -5,
      minChunkZ: -5,
      maxChunkX: 5,
      maxChunkZ: 5,
      loadRadius: 15,
      unloadRadius: 30,
      budget: { maxChunksPerFrame: 100, maxMs: Infinity },
    });
    manager.registerProcedural('box', definition());
    manager.registerModel('/models/thing.glb', () => definition());
    world.addSystem(manager);
    manager.setTarget(5, 5, 0, 0);
    world.runStage('update', 1 / 60);
    expect(manager.isActive(0, 0)).toBe(false);
    expect(manager.stats().active).toBeGreaterThan(0);
    assets.resolve('/models/thing.glb');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    world.runStage('update', 1 / 60);
    expect(manager.isActive(0, 0)).toBe(true);
    manager.dispose();
    world.dispose();
  });
});
