import type * as THREE from 'three/webgpu';
import type { AssetManager } from '../assets/AssetManager';
import { AssetLoadAbortedError } from '../assets/AssetCache';
import type { ModelAsset } from '../assets/ModelAsset';
import type { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/Events';
import { Logger } from '../core/Logger';
import { Renderable, Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import type { InstancedBatch, InstancedRenderSync } from '../ecs/systems/InstancedRenderSync';
import { Cullable, Streamed } from './components';
import type { LODSystem } from './LODSystem';
import type { SpatialIndex } from './SpatialIndex';
import { StreamingPlanner, type StreamingPlannerOptions } from './StreamingPlanner';

// ---- chunk sources -----------------------------------------------------------

/** Where one instance of an asset goes inside a chunk. */
export interface ChunkPlacement {
  /** A model URL registered with `registerModel`, or `procedural:<kind>` registered with `registerProcedural`. */
  readonly asset: string;
  readonly position: readonly [number, number, number];
  /** Quaternion `[x, y, z, w]`; identity when omitted. */
  readonly rotation?: readonly [number, number, number, number] | undefined;
  /** Uniform or per-axis scale; 1 when omitted. */
  readonly scale?: number | readonly [number, number, number] | undefined;
  /** Override the asset's LOD group with another registered group id. */
  readonly lod?: number | undefined;
  readonly extras?: Readonly<Record<string, unknown>> | undefined;
}

export interface ChunkDescriptor {
  readonly placements: readonly ChunkPlacement[];
}

/** Produces chunk content on demand. Must be deterministic for a given `(cx, cz)`. */
export interface ChunkSource {
  chunkAt(cx: number, cz: number): ChunkDescriptor;
}

// ---- streamed assets ---------------------------------------------------------

export interface StreamedAssetLevel {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

export interface StreamedAssetDefinition {
  /** One entry per LOD level, nearest first; `null` = not drawn at that level. */
  readonly levels: ReadonlyArray<StreamedAssetLevel | null>;
  /** LOD switch distances (`levels.length - 1` entries), see `LODSystem`. */
  readonly lodDistances: readonly number[];
  readonly hysteresis?: number | undefined;
  /** Bounding-sphere radius at unit scale. */
  readonly radius: number;
  /** Distance-cull threshold (scaled by `quality.drawDistance`); 0 = unlimited. */
  readonly maxDistance: number;
  /**
   * Instances per level batch: one number for every level, or one per level
   * (nearest first). Size these to what each LOD ring can hold: three's
   * velocity/TRAA path copies and re-uploads every instanced mesh's whole
   * matrix array each frame, so capacity, not count, is what costs.
   */
  readonly capacity: number | readonly number[];
  readonly castShadow?: boolean | undefined;
  readonly receiveShadow?: boolean | undefined;
  /** Free geometry/materials the definition created itself (never those owned by a `ModelAsset`). */
  dispose?(): void;
}

/** Builds the streamed definition of a model once it is resident. */
export type StreamedModelFactory = (model: ModelAsset) => StreamedAssetDefinition;

export interface StreamingBudget {
  /** Chunks activated per frame. Default 2. */
  maxChunksPerFrame: number;
  /** Wall-clock cap per frame for unload + activation, ms. `Infinity` for deterministic captures. Default 2. */
  maxMs: number;
  /** Chunks whose assets may be in flight at once. Default 8. */
  maxLoadsInFlight?: number | undefined;
  /** Chunks released per frame. Default 2. */
  maxUnloadsPerFrame?: number | undefined;
}

export interface StreamingManagerOptions extends StreamingPlannerOptions {
  entities: EntityWorld;
  assets: AssetManager;
  /** Batch meshes are added here. */
  scene: THREE.Object3D;
  /** Level batches are created through this system so it uploads them each frame. */
  instanced: InstancedRenderSync;
  lod: LODSystem;
  /** Streamed entities are inserted here for culling. */
  spatial?: SpatialIndex | undefined;
  source: ChunkSource;
  budget?: Partial<StreamingBudget> | undefined;
  /**
   * Never let streamed entities exceed this count; a chunk that would cross it
   * waits (logged once). Default: the entity world's capacity minus 1024.
   */
  maxEntities?: number | undefined;
  /**
   * Activate strictly in priority order (a chunk whose assets are still
   * loading blocks the ones behind it). Off by default: ready chunks behind a
   * loading one activate first, so a slow asset never stalls the stream.
   */
  strictOrder?: boolean | undefined;
}

export interface StreamingEvents extends Record<string, unknown> {
  progress: { active: number; queued: number; loading: number };
  chunkLoaded: { cx: number; cz: number; key: number; entities: number };
  chunkUnloaded: { cx: number; cz: number; key: number };
}

export interface StreamingStats {
  active: number;
  loading: number;
  ready: number;
  /** Wanted chunks not yet active. */
  queued: number;
  failed: number;
  entities: number;
  /** Instance slots across every level batch. */
  instances: number;
  /** Instances drawn at non-zero scale after the last upload. */
  visibleInstances: number;
  batches: number;
  /** Instance matrices rebuilt last frame across every batch. */
  uploadedInstances: number;
  /** Instance slots covered by last frame's upload ranges. */
  uploadedRange: number;
  activatedLastFrame: number;
  unloadedLastFrame: number;
  lastFrameMs: number;
  maxFrameMs: number;
  replans: number;
  /** Total chunk activations since creation, for determinism checks. */
  activations: number;
  /** Streamed entity budget (see `maxEntities`). */
  maxEntities: number;
}

const ChunkState = {
  Idle: 0,
  Loading: 1,
  Ready: 2,
  Active: 3,
  Failed: 4,
} as const;

type ChunkStateValue = (typeof ChunkState)[keyof typeof ChunkState];

interface ChunkRecord {
  key: number;
  cx: number;
  cz: number;
  state: ChunkStateValue;
  /** Bumps on every cancel so a late load completion can tell it is stale. */
  generation: number;
  descriptor: ChunkDescriptor | null;
  /** Distinct asset keys this chunk holds a reference on. */
  assets: string[];
  entities: Entity[];
}

interface AssetRecord {
  readonly key: string;
  readonly url: string | null;
  /** Chunks referencing this asset (loading or active). */
  refs: number;
  factory: StreamedModelFactory | null;
  definition: StreamedAssetDefinition | null;
  batches: Array<InstancedBatch | null> | null;
  group: number;
  loading: Promise<void> | null;
}

const _now = typeof performance !== 'undefined' ? (): number => performance.now() : (): number => Date.now();

/**
 * Chunked world streaming around a moving target. A `ChunkSource` describes
 * each chunk as asset placements; the manager loads the models it needs
 * through the `AssetManager` (one reference per chunk), creates one static
 * `InstancedBatch` per asset per LOD level, and spawns one entity per
 * placement (Transform + Renderable + Cullable + LOD + Streamed). Chunks are
 * released, entities destroyed and asset references given back once the
 * target moves beyond the unload radius.
 *
 * Runs as an `update`-stage system. Work per frame is bounded by the budget so
 * activation never stalls a frame; the *order* of activation is the planner's
 * deterministic priority order.
 */
export class StreamingManager implements System, Disposable {
  readonly name = 'StreamingManager';
  readonly stage = 'update' as const;
  readonly order = 0;

  readonly planner: StreamingPlanner;
  readonly events = new EventEmitter<StreamingEvents>();
  readonly budget: StreamingBudget;

  private readonly entities: EntityWorld;
  private readonly assets: AssetManager;
  private readonly scene: THREE.Object3D;
  private readonly instanced: InstancedRenderSync;
  private readonly lod: LODSystem;
  private readonly spatial: SpatialIndex | undefined;
  private readonly source: ChunkSource;
  private readonly strictOrder: boolean;
  private readonly maxEntities: number;
  private capacityWarned = false;
  private readonly log = new Logger('streaming');

  private readonly records: Array<ChunkRecord | undefined>;
  private readonly pool: ChunkRecord[] = [];
  private readonly activeList: number[] = [];
  private readonly loadingList: number[] = [];
  private readonly assetRecords = new Map<string, AssetRecord>();
  private targetX = 0;
  private targetZ = 0;
  private dirX = 0;
  private dirZ = 0;
  private loadsInFlight = 0;
  private entityCount = 0;
  private disposed = false;
  private lastProgressKey = -1;
  private readonly statsValue: StreamingStats = {
    active: 0,
    loading: 0,
    ready: 0,
    queued: 0,
    failed: 0,
    entities: 0,
    instances: 0,
    visibleInstances: 0,
    batches: 0,
    uploadedInstances: 0,
    uploadedRange: 0,
    activatedLastFrame: 0,
    unloadedLastFrame: 0,
    lastFrameMs: 0,
    maxFrameMs: 0,
    replans: 0,
    activations: 0,
    maxEntities: 0,
  };

  constructor(options: StreamingManagerOptions) {
    this.entities = options.entities;
    this.assets = options.assets;
    this.scene = options.scene;
    this.instanced = options.instanced;
    this.lod = options.lod;
    this.spatial = options.spatial;
    this.source = options.source;
    this.strictOrder = options.strictOrder ?? false;
    this.maxEntities = options.maxEntities ?? Math.max(0, options.entities.capacity - 1024);
    this.planner = new StreamingPlanner(options);
    this.budget = {
      maxChunksPerFrame: options.budget?.maxChunksPerFrame ?? 2,
      maxMs: options.budget?.maxMs ?? 2,
      maxLoadsInFlight: options.budget?.maxLoadsInFlight ?? 8,
      maxUnloadsPerFrame: options.budget?.maxUnloadsPerFrame ?? 2,
    };
    this.records = new Array<ChunkRecord | undefined>(this.planner.chunkCount);
  }

  // ---- asset registration -------------------------------------------------------

  /** Register a procedural asset (geometry the scene built). Placements reference it as `procedural:<kind>`. */
  registerProcedural(kind: string, definition: StreamedAssetDefinition): string {
    const key = `procedural:${kind}`;
    if (this.assetRecords.has(key)) throw new Error(`StreamingManager: asset "${key}" already registered`);
    const record: AssetRecord = { key, url: null, refs: 0, factory: null, definition, batches: null, group: -1, loading: null };
    this.assetRecords.set(key, record);
    this.buildBatches(record);
    return key;
  }

  /**
   * Register a model URL. The factory turns the resident `ModelAsset` into a
   * streamed definition the first time a chunk needs it; batches are torn down
   * and the model released once no chunk references it any more.
   */
  registerModel(url: string, factory: StreamedModelFactory): string {
    if (this.assetRecords.has(url)) throw new Error(`StreamingManager: asset "${url}" already registered`);
    this.assetRecords.set(url, { key: url, url, refs: 0, factory, definition: null, batches: null, group: -1, loading: null });
    return url;
  }

  /** The LOD group an asset's entities use, or -1 before its batches exist. */
  groupOf(assetKey: string): number {
    return this.assetRecords.get(assetKey)?.group ?? -1;
  }

  // ---- target -----------------------------------------------------------------------

  /** Where to stream around and which way it is heading (`dx, dz` may be zero). */
  setTarget(x: number, z: number, dx: number, dz: number): void {
    this.targetX = x;
    this.targetZ = z;
    this.dirX = dx;
    this.dirZ = dz;
  }

  // ---- queries -------------------------------------------------------------------------

  isActive(cx: number, cz: number): boolean {
    const key = this.planner.key(cx, cz);
    return key >= 0 && this.records[key]?.state === ChunkState.Active;
  }

  /** Keys of active chunks, in activation order. Do not mutate. */
  activeChunks(): readonly number[] {
    return this.activeList;
  }

  entitiesOf(cx: number, cz: number): readonly Entity[] {
    const key = this.planner.key(cx, cz);
    const record = key >= 0 ? this.records[key] : undefined;
    return record && record.state === ChunkState.Active ? record.entities : [];
  }

  stats(): StreamingStats {
    const s = this.statsValue;
    s.active = this.activeList.length;
    s.loading = this.loadingList.length;
    s.entities = this.entityCount;
    s.replans = this.planner.replanCount;
    s.maxEntities = this.maxEntities;
    let instances = 0;
    let visible = 0;
    let batches = 0;
    let ready = 0;
    let failed = 0;
    let uploaded = 0;
    let uploadedRange = 0;
    for (const record of this.assetRecords.values()) {
      if (!record.batches) continue;
      for (const batch of record.batches) {
        if (!batch) continue;
        batches++;
        instances += batch.count;
        visible += batch.visibleCount;
        uploaded += batch.lastUploaded;
        uploadedRange += batch.lastUploadedRange;
      }
    }
    s.uploadedInstances = uploaded;
    s.uploadedRange = uploadedRange;
    let queued = 0;
    for (const key of this.planner.queue) {
      const state = this.records[key]?.state ?? ChunkState.Idle;
      if (state !== ChunkState.Active) queued++;
      if (state === ChunkState.Ready) ready++;
      if (state === ChunkState.Failed) failed++;
    }
    s.queued = queued;
    s.ready = ready;
    s.failed = failed;
    s.instances = instances;
    s.visibleInstances = visible;
    s.batches = batches;
    return s;
  }

  // ---- per frame ---------------------------------------------------------------------------

  run(): void {
    if (this.disposed) return;
    const start = _now();
    const s = this.statsValue;
    s.activatedLastFrame = 0;
    s.unloadedLastFrame = 0;
    const planner = this.planner;
    planner.setTarget(this.targetX, this.targetZ, this.dirX, this.dirZ);
    const budget = this.budget;
    const maxMs = budget.maxMs;
    const maxUnloads = budget.maxUnloadsPerFrame ?? 2;
    const maxLoads = budget.maxLoadsInFlight ?? 8;

    // 1. Release chunks that drifted past the unload radius (hysteresis).
    let unloaded = 0;
    for (let i = this.activeList.length - 1; i >= 0 && unloaded < maxUnloads; i--) {
      const key = this.activeList[i] as number;
      if (!planner.shouldUnload(key)) continue;
      this.deactivate(key, i);
      unloaded++;
      if (_now() - start >= maxMs) break;
    }
    for (let i = this.loadingList.length - 1; i >= 0; i--) {
      const key = this.loadingList[i] as number;
      if (planner.shouldUnload(key)) this.cancel(key, i);
    }
    s.unloadedLastFrame = unloaded;

    // 2. Start loads and activate ready chunks, in priority order.
    const queue = planner.queue;
    let activated = 0;
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i] as number;
      const record = this.records[key];
      const state = record?.state ?? ChunkState.Idle;
      if (state === ChunkState.Active || state === ChunkState.Failed) continue;
      if (state === ChunkState.Idle) {
        if (this.loadsInFlight >= maxLoads) continue;
        this.startLoad(key);
        // startLoad may have made it Ready synchronously; fall through.
      }
      const now = this.records[key];
      if (!now) continue;
      if (now.state === ChunkState.Loading) {
        if (this.strictOrder) break;
        continue;
      }
      if (now.state !== ChunkState.Ready) continue;
      if (activated >= budget.maxChunksPerFrame || _now() - start >= maxMs) break;
      if (this.entityCount + (now.descriptor?.placements.length ?? 0) > this.maxEntities) {
        if (!this.capacityWarned) {
          this.capacityWarned = true;
          this.log.info(`entity budget ${this.maxEntities} reached with ${this.activeList.length} chunks active; further chunks wait`);
        }
        continue;
      }
      this.activate(now);
      activated++;
    }
    s.activatedLastFrame = activated;
    const ms = _now() - start;
    s.lastFrameMs = ms;
    if (ms > s.maxFrameMs) s.maxFrameMs = ms;
    this.emitProgress();
  }

  private emitProgress(): void {
    if (this.events.listenerCount('progress') === 0) return;
    const active = this.activeList.length;
    const loading = this.loadingList.length;
    let queued = 0;
    for (const key of this.planner.queue) if (this.records[key]?.state !== ChunkState.Active) queued++;
    const progressKey = active * 1_000_000 + queued * 1000 + loading;
    if (progressKey === this.lastProgressKey) return;
    this.lastProgressKey = progressKey;
    this.events.emit('progress', { active, queued, loading });
  }

  // ---- chunk lifecycle ------------------------------------------------------------------------

  private record(key: number): ChunkRecord {
    let record = this.records[key];
    if (record) return record;
    record = this.pool.pop() ?? { key: 0, cx: 0, cz: 0, state: ChunkState.Idle, generation: 0, descriptor: null, assets: [], entities: [] };
    record.key = key;
    record.cx = this.planner.chunkX(key);
    record.cz = this.planner.chunkZ(key);
    record.state = ChunkState.Idle;
    record.descriptor = null;
    record.assets.length = 0;
    record.entities.length = 0;
    this.records[key] = record;
    return record;
  }

  private recycle(record: ChunkRecord): void {
    this.records[record.key] = undefined;
    record.descriptor = null;
    record.assets.length = 0;
    record.entities.length = 0;
    record.state = ChunkState.Idle;
    this.pool.push(record);
  }

  private startLoad(key: number): void {
    const record = this.record(key);
    let descriptor: ChunkDescriptor;
    try {
      descriptor = this.source.chunkAt(record.cx, record.cz);
    } catch (error) {
      this.log.error(`chunk (${record.cx}, ${record.cz}) source failed: ${error instanceof Error ? error.message : String(error)}`);
      record.state = ChunkState.Failed;
      return;
    }
    record.descriptor = descriptor;
    record.state = ChunkState.Loading;
    record.generation++;
    const generation = record.generation;
    this.loadingList.push(key);
    this.loadsInFlight++;

    // Take one reference per distinct asset; collect the loads still pending.
    let pending: Promise<void>[] | null = null;
    for (const placement of descriptor.placements) {
      const assetKey = placement.asset;
      if (record.assets.includes(assetKey)) continue;
      const asset = this.assetRecords.get(assetKey);
      if (!asset) {
        this.log.error(`chunk (${record.cx}, ${record.cz}) references unregistered asset "${assetKey}"`);
        this.failLoad(record);
        return;
      }
      record.assets.push(assetKey);
      asset.refs++;
      const wait = this.acquireAsset(asset);
      if (wait) (pending ??= []).push(wait);
    }
    if (!pending) {
      this.finishLoad(record, generation);
      return;
    }
    void Promise.all(pending).then(
      () => {
        if (record.generation === generation && record.state === ChunkState.Loading) this.finishLoad(record, generation);
      },
      (error: unknown) => {
        if (record.generation !== generation || record.state !== ChunkState.Loading) return;
        if (!(error instanceof AssetLoadAbortedError)) {
          this.log.error(`chunk (${record.cx}, ${record.cz}) asset load failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.failLoad(record);
      },
    );
  }

  private finishLoad(record: ChunkRecord, generation: number): void {
    if (record.generation !== generation) return;
    // Every model this chunk uses is resident; make sure its batches exist.
    for (const assetKey of record.assets) {
      const asset = this.assetRecords.get(assetKey);
      if (asset && !asset.batches) {
        if (!asset.definition) {
          this.failLoad(record);
          return;
        }
        this.buildBatches(asset);
      }
    }
    this.removeFromLoading(record.key);
    record.state = ChunkState.Ready;
  }

  private failLoad(record: ChunkRecord): void {
    this.removeFromLoading(record.key);
    this.releaseAssets(record);
    record.state = ChunkState.Failed;
  }

  private removeFromLoading(key: number): void {
    const i = this.loadingList.indexOf(key);
    if (i === -1) return;
    const last = this.loadingList.length - 1;
    this.loadingList[i] = this.loadingList[last] as number;
    this.loadingList.pop();
    this.loadsInFlight--;
  }

  private cancel(key: number, loadingIndex: number): void {
    const record = this.records[key];
    if (!record || record.state !== ChunkState.Loading) return;
    const last = this.loadingList.length - 1;
    this.loadingList[loadingIndex] = this.loadingList[last] as number;
    this.loadingList.pop();
    this.loadsInFlight--;
    record.generation++;
    this.releaseAssets(record);
    this.recycle(record);
  }

  private activate(record: ChunkRecord): void {
    const descriptor = record.descriptor;
    if (!descriptor) return;
    const world = this.entities;
    const t = world.store(Transform);
    const c = world.store(Cullable);
    const st = world.store(Streamed);
    const spatial = this.spatial;
    for (const placement of descriptor.placements) {
      const asset = this.assetRecords.get(placement.asset);
      const definition = asset?.definition;
      if (!asset || !definition || asset.group < 0) continue;
      const eid = world.create();
      world.add(eid, Transform);
      world.add(eid, Renderable);
      world.add(eid, Cullable);
      world.add(eid, Streamed);
      const p = placement.position;
      t.x[eid] = p[0];
      t.y[eid] = p[1];
      t.z[eid] = p[2];
      const q = placement.rotation;
      if (q) {
        t.qx[eid] = q[0];
        t.qy[eid] = q[1];
        t.qz[eid] = q[2];
        t.qw[eid] = q[3];
      }
      const sc = placement.scale;
      let maxScale = 1;
      if (typeof sc === 'number') {
        t.sx[eid] = t.sy[eid] = t.sz[eid] = sc;
        maxScale = sc;
      } else if (sc) {
        t.sx[eid] = sc[0];
        t.sy[eid] = sc[1];
        t.sz[eid] = sc[2];
        maxScale = Math.max(sc[0], sc[1], sc[2]);
      }
      const radius = definition.radius * maxScale;
      c.radius[eid] = radius;
      c.maxDistance[eid] = definition.maxDistance;
      c.stamp[eid] = 0;
      st.chunk[eid] = record.key;
      this.lod.add(world, eid, placement.lod ?? asset.group);
      spatial?.insert(eid, p[0], p[1], p[2], radius);
      record.entities.push(eid);
    }
    record.state = ChunkState.Active;
    this.activeList.push(record.key);
    this.entityCount += record.entities.length;
    this.statsValue.activations++;
    this.events.emit('chunkLoaded', { cx: record.cx, cz: record.cz, key: record.key, entities: record.entities.length });
  }

  private deactivate(key: number, activeIndex: number): void {
    const record = this.records[key];
    if (!record || record.state !== ChunkState.Active) return;
    const world = this.entities;
    const spatial = this.spatial;
    for (const eid of record.entities) {
      spatial?.remove(eid);
      world.destroy(eid); // LOD's onRemove hook gives the batch slot back
    }
    this.entityCount -= record.entities.length;
    const last = this.activeList.length - 1;
    this.activeList[activeIndex] = this.activeList[last] as number;
    this.activeList.pop();
    record.generation++;
    this.releaseAssets(record);
    const cx = record.cx;
    const cz = record.cz;
    this.recycle(record);
    this.events.emit('chunkUnloaded', { cx, cz, key });
  }

  // ---- assets ----------------------------------------------------------------------------

  /** Returns a promise while the model is still loading, null when it is already usable. */
  private acquireAsset(asset: AssetRecord): Promise<void> | null {
    if (asset.url === null) return null;
    const url = asset.url;
    // One AssetManager reference per chunk; the cache joins in-flight loads.
    const load = this.assets.loadModel(url);
    if (asset.definition) {
      // Already resident: this is a cache hit taking one more reference.
      void load.catch(() => undefined);
      return null;
    }
    if (asset.loading) {
      void load.catch(() => undefined);
      return asset.loading;
    }
    asset.loading = load.then(
      (model) => {
        asset.loading = null;
        if (asset.refs === 0 || this.disposed) return;
        if (!asset.definition) {
          const factory = asset.factory;
          if (!factory) throw new Error(`StreamingManager: no factory for "${url}"`);
          asset.definition = factory(model);
        }
      },
      (error: unknown) => {
        asset.loading = null;
        throw error;
      },
    );
    return asset.loading;
  }

  private releaseAssets(record: ChunkRecord): void {
    for (const assetKey of record.assets) {
      const asset = this.assetRecords.get(assetKey);
      if (!asset) continue;
      asset.refs--;
      if (asset.url !== null) {
        if (asset.refs === 0) this.teardownModel(asset);
        this.assets.release(asset.url);
      }
    }
    record.assets.length = 0;
  }

  private buildBatches(asset: AssetRecord): void {
    const definition = asset.definition;
    if (!definition || asset.batches) return;
    const batches: Array<InstancedBatch | null> = [];
    for (const level of definition.levels) {
      if (!level) {
        batches.push(null);
        continue;
      }
      const capacity = typeof definition.capacity === 'number' ? definition.capacity : (definition.capacity[batches.length] ?? 1);
      const batch = this.instanced.createBatch(level.geometry, level.material, Math.max(1, capacity), { static: true });
      batch.mesh.name = `stream:${asset.key}:lod${batches.length}`;
      batch.mesh.castShadow = definition.castShadow ?? false;
      batch.mesh.receiveShadow = definition.receiveShadow ?? false;
      this.scene.add(batch.mesh);
      batches.push(batch);
    }
    asset.batches = batches;
    if (asset.group < 0) {
      asset.group = this.lod.defineGroup({ distances: definition.lodDistances, hysteresis: definition.hysteresis, batches });
    } else {
      this.lod.setGroupBatches(asset.group, batches);
    }
  }

  /** Last chunk gone: drop the batches so the model's geometry can be disposed by the cache. */
  private teardownModel(asset: AssetRecord): void {
    if (asset.batches) {
      if (asset.group >= 0) this.lod.setGroupBatches(asset.group, null);
      for (const batch of asset.batches) if (batch) this.instanced.removeBatch(batch);
      asset.batches = null;
    }
    asset.definition?.dispose?.();
    asset.definition = null;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Release every chunk now (entities destroyed, assets released). The manager stays usable. */
  clear(): void {
    for (let i = this.activeList.length - 1; i >= 0; i--) this.deactivate(this.activeList[i] as number, i);
    for (let i = this.loadingList.length - 1; i >= 0; i--) this.cancel(this.loadingList[i] as number, i);
    for (const key of this.planner.queue) {
      const record = this.records[key];
      if (record && record.state === ChunkState.Ready) {
        this.releaseAssets(record);
        this.recycle(record);
      }
    }
    for (let key = 0; key < this.records.length; key++) {
      const record = this.records[key];
      if (record) {
        this.releaseAssets(record);
        this.recycle(record);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    for (const asset of this.assetRecords.values()) {
      this.teardownModel(asset);
      asset.refs = 0;
    }
    this.assetRecords.clear();
    this.events.clear();
  }
}
