import * as THREE from 'three/webgpu';
import { Renderable, Transform } from '../components/Transform';
import type { Entity, EntityWorld } from '../EntityWorld';
import type { System } from '../System';
import type { Disposable } from '../../core/Disposable';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * Renders many entities that share one geometry + material through a single
 * `InstancedMesh`. Each registered entity owns one instance slot; the instance
 * matrix is rebuilt from Transform every frame.
 *
 * Use this for anything repeated (props, projectiles, debris, crowds). One
 * draw call per batch regardless of entity count.
 */
export class InstancedBatch implements Disposable {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots = new Map<Entity, number>();
  private readonly entities: Entity[] = [];
  private readonly capacity: number;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.entities.length;
  }

  add(eid: Entity): number {
    const existing = this.slots.get(eid);
    if (existing !== undefined) return existing;
    if (this.entities.length >= this.capacity) throw new Error(`InstancedBatch: capacity ${this.capacity} exceeded`);
    const slot = this.entities.length;
    this.entities.push(eid);
    this.slots.set(eid, slot);
    this.mesh.count = this.entities.length;
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
    }
    this.entities.pop();
    this.slots.delete(eid);
    this.mesh.count = this.entities.length;
  }

  has(eid: Entity): boolean {
    return this.slots.has(eid);
  }

  update(world: EntityWorld): void {
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
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.slots.clear();
    this.entities.length = 0;
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

  createBatch(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): InstancedBatch {
    const batch = new InstancedBatch(geometry, material, capacity);
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
