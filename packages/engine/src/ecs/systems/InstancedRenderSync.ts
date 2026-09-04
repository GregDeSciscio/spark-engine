import * as THREE from 'three/webgpu';
import { Renderable, Transform } from '../components/Transform';
import type { Entity, EntityWorld } from '../EntityWorld';
import type { System } from '../System';
import type { Disposable } from '../../core/Disposable';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** Dirty slots further apart than this start a new upload range (static batches). */
const RANGE_GAP = 128;
/** At most this many ranges per upload; beyond it one range spans everything. */
const MAX_RANGES = 48;

export interface InstancedBatchOptions {
  /**
   * Static batches (streamed world geometry) rebuild only the slots that
   * changed since the last update: added, swap-moved by a removal, explicitly
   * `markDirty`-ed, or whose `Renderable.visible` flipped. One contiguous
   * buffer range is uploaded per frame, and nothing at all when nothing
   * changed. Default false: every matrix is rebuilt and uploaded each frame,
   * which is right for entities that move.
   */
  static?: boolean | undefined;
}

/**
 * Renders many entities that share one geometry + material through a single
 * `InstancedMesh`. Each registered entity owns one instance slot; the instance
 * matrix is rebuilt from Transform every frame (or only when it changed, for
 * static batches).
 *
 * Use this for anything repeated (props, projectiles, debris, crowds). One
 * draw call per batch regardless of entity count.
 */
export class InstancedBatch implements Disposable {
  readonly mesh: THREE.InstancedMesh;
  readonly isStatic: boolean;
  private readonly slots = new Map<Entity, number>();
  private readonly entities: Entity[] = [];
  private readonly capacity: number;
  // Static-mode bookkeeping. `slotVisible` mirrors the visibility baked into
  // each slot's matrix; `dirty` lists slots whose matrix must be rebuilt.
  private readonly slotVisible: Uint8Array;
  private readonly dirtyMark: Uint8Array;
  private dirty: Int32Array;
  private dirtyCount = 0;
  private visibleSlots = 0;
  private lastUploadedSlots = 0;
  private lastRangeSlots = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, options: InstancedBatchOptions = {}) {
    this.capacity = capacity;
    this.isStatic = options.static ?? false;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.slotVisible = new Uint8Array(this.isStatic ? capacity : 0);
    this.dirtyMark = new Uint8Array(this.isStatic ? capacity : 0);
    this.dirty = new Int32Array(this.isStatic ? Math.min(capacity, 1024) : 0);
  }

  get count(): number {
    return this.entities.length;
  }

  get maxCount(): number {
    return this.capacity;
  }

  get isFull(): boolean {
    return this.entities.length >= this.capacity;
  }

  /** Slots drawn at non-zero scale after the last update (static batches; equals `count` for dynamic ones). */
  get visibleCount(): number {
    return this.isStatic ? this.visibleSlots : this.entities.length;
  }

  /** Slots whose matrices were rebuilt by the last update. Debug stat. */
  get lastUploaded(): number {
    return this.lastUploadedSlots;
  }

  /** Slots covered by the upload ranges of the last update (≥ `lastUploaded`). Debug stat. */
  get lastUploadedRange(): number {
    return this.lastRangeSlots;
  }

  add(eid: Entity): number {
    const slot = this.tryAdd(eid);
    if (slot === -1) throw new Error(`InstancedBatch: capacity ${this.capacity} exceeded`);
    return slot;
  }

  /** Like `add`, but returns -1 instead of throwing when the batch is full. */
  tryAdd(eid: Entity): number {
    const existing = this.slots.get(eid);
    if (existing !== undefined) return existing;
    if (this.entities.length >= this.capacity) return -1;
    const slot = this.entities.length;
    this.entities.push(eid);
    this.slots.set(eid, slot);
    this.mesh.count = this.entities.length;
    if (this.isStatic) this.markSlotDirty(slot);
    return slot;
  }

  /** Swap-remove keeps slots dense so `mesh.count` stays exact. */
  remove(eid: Entity): void {
    const slot = this.slots.get(eid);
    if (slot === undefined) return;
    const last = this.entities.length - 1;
    const lastEid = this.entities[last];
    if (lastEid !== undefined && slot !== last) {
      this.entities[slot] = lastEid;
      this.slots.set(lastEid, slot);
      if (this.isStatic) this.markSlotDirty(slot);
    }
    this.entities.pop();
    this.slots.delete(eid);
    this.mesh.count = this.entities.length;
  }

  has(eid: Entity): boolean {
    return this.slots.has(eid);
  }

  /** Static batches only: rebuild this entity's matrix on the next update (call after writing its Transform). */
  markDirty(eid: Entity): void {
    if (!this.isStatic) return;
    const slot = this.slots.get(eid);
    if (slot !== undefined) this.markSlotDirty(slot);
  }

  private markSlotDirty(slot: number): void {
    if (this.dirtyMark[slot] === 1) return;
    this.dirtyMark[slot] = 1;
    if (this.dirtyCount === this.dirty.length) {
      const grown = new Int32Array(Math.min(this.capacity, this.dirty.length * 2));
      grown.set(this.dirty);
      this.dirty = grown;
    }
    this.dirty[this.dirtyCount++] = slot;
  }

  update(world: EntityWorld): void {
    if (this.isStatic) {
      this.updateStatic(world);
      return;
    }
    const t = world.store(Transform);
    const r = world.store(Renderable);
    const mesh = this.mesh;
    for (let slot = 0; slot < this.entities.length; slot++) {
      const eid = this.entities[slot] as Entity;
      const visible = (r.visible[eid] ?? 1) !== 0;
      const s = visible ? 1 : 0;
      _position.set(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
      _quaternion.set(t.qx[eid] ?? 0, t.qy[eid] ?? 0, t.qz[eid] ?? 0, t.qw[eid] ?? 1);
      _scale.set((t.sx[eid] ?? 1) * s, (t.sy[eid] ?? 1) * s, (t.sz[eid] ?? 1) * s);
      _matrix.compose(_position, _quaternion, _scale);
      mesh.setMatrixAt(slot, _matrix);
    }
    this.lastUploadedSlots = this.entities.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private updateStatic(world: EntityWorld): void {
    const t = world.store(Transform);
    const r = world.store(Renderable);
    const entities = this.entities;
    const n = entities.length;
    const slotVisible = this.slotVisible;
    // Visibility scan: a flipped Renderable.visible dirties the slot. This is
    // one byte compare per slot, far cheaper than rebuilding every matrix.
    let visibleSlots = 0;
    for (let slot = 0; slot < n; slot++) {
      const v = r.visible[entities[slot] as Entity] === 0 ? 0 : 1;
      visibleSlots += v;
      if (v !== slotVisible[slot]) this.markSlotDirty(slot);
    }
    this.visibleSlots = visibleSlots;
    const count = this.dirtyCount;
    if (count === 0) {
      this.lastUploadedSlots = 0;
      this.lastRangeSlots = 0;
      return;
    }
    // Sort in place so runs of neighbouring slots become contiguous uploads.
    const dirty = count === this.dirty.length ? this.dirty : this.dirty.subarray(0, count);
    dirty.sort();
    const mesh = this.mesh;
    const attribute = mesh.instanceMatrix;
    attribute.clearUpdateRanges();
    let rebuilt = 0;
    let ranges = 0;
    let rangeStart = -1;
    let rangeEnd = -1;
    let first = -1;
    let last = -1;
    let covered = 0;
    for (let i = 0; i < count; i++) {
      const slot = dirty[i] as number;
      this.dirtyMark[slot] = 0;
      if (slot >= n) continue; // removed since it was marked
      const eid = entities[slot] as Entity;
      const v = r.visible[eid] === 0 ? 0 : 1;
      slotVisible[slot] = v;
      _position.set(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
      _quaternion.set(t.qx[eid] ?? 0, t.qy[eid] ?? 0, t.qz[eid] ?? 0, t.qw[eid] ?? 1);
      _scale.set((t.sx[eid] ?? 1) * v, (t.sy[eid] ?? 1) * v, (t.sz[eid] ?? 1) * v);
      _matrix.compose(_position, _quaternion, _scale);
      mesh.setMatrixAt(slot, _matrix);
      rebuilt++;
      if (first < 0) first = slot;
      last = slot;
      if (rangeStart < 0) {
        rangeStart = rangeEnd = slot;
      } else if (slot - rangeEnd > RANGE_GAP && ranges < MAX_RANGES) {
        attribute.addUpdateRange(rangeStart * 16, (rangeEnd - rangeStart + 1) * 16);
        covered += rangeEnd - rangeStart + 1;
        ranges++;
        rangeStart = rangeEnd = slot;
      } else {
        rangeEnd = slot;
      }
    }
    this.dirtyCount = 0;
    this.lastUploadedSlots = rebuilt;
    if (rebuilt === 0) {
      this.lastRangeSlots = 0;
      return;
    }
    if (ranges >= MAX_RANGES) {
      // Too fragmented: one range over everything touched this frame.
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(first * 16, (last - first + 1) * 16);
      covered = last - first + 1;
    } else {
      attribute.addUpdateRange(rangeStart * 16, (rangeEnd - rangeStart + 1) * 16);
      covered += rangeEnd - rangeStart + 1;
    }
    this.lastRangeSlots = covered;
    attribute.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.slots.clear();
    this.entities.length = 0;
    this.dirtyCount = 0;
  }
}

/** Late-stage system that updates every registered InstancedBatch. */
export class InstancedRenderSync implements System {
  readonly name = 'InstancedRenderSync';
  readonly stage = 'late' as const;
  readonly order = 1001;

  private readonly batches = new Set<InstancedBatch>();
  private readonly detach: () => void;

  constructor(world: EntityWorld) {
    this.detach = world.onDestroy((eid) => {
      for (const batch of this.batches) batch.remove(eid);
    });
  }

  createBatch(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, options?: InstancedBatchOptions): InstancedBatch {
    const batch = new InstancedBatch(geometry, material, capacity, options);
    this.batches.add(batch);
    return batch;
  }

  removeBatch(batch: InstancedBatch): void {
    if (this.batches.delete(batch)) batch.dispose();
  }

  run(world: EntityWorld): void {
    for (const batch of this.batches) batch.update(world);
  }

  dispose(): void {
    this.detach();
    for (const batch of this.batches) batch.dispose();
    this.batches.clear();
  }
}
