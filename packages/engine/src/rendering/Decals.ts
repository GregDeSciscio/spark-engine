import * as THREE from 'three/webgpu';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import type { Disposable } from '../core/Disposable';

/**
 * Projected decals (kickoff §8 phase 2, §41). Two flavours:
 *
 * - **Static** (`addDecal`): grime, posters, puddle rims, oil stains. Each
 *   one is a `DecalGeometry` clipped from the target mesh, owned until the
 *   scene disposes the `Decals` instance.
 * - **Dynamic** (`spawn`): impact marks. A fixed pool of meshes is allocated
 *   up front; spawning past the capacity recycles the oldest decal. No
 *   allocation on the hot path beyond the clipped geometry itself.
 *
 * Decals are ordinary scene meshes, which is the whole point: they go through
 * the same scene pass as everything else, so they receive lights and shadows,
 * write the MRT (normal / roughness / velocity) and are treated by the post
 * stages like any surface:
 *
 * - **SSR** reads the decal's own roughness/metalness from the MRT, so a
 *   glossy oil stain reflects and a matte grime patch kills the reflection
 *   under it. That is usually what you want.
 * - **GTAO** only touches opaque materials (transparent ones are excluded from
 *   the AO context by the pipeline); decals are alpha-blended, so they never
 *   receive AO grain and do not occlude. They also render in the transparent
 *   pass, after the opaques they sit on.
 * - **Depth**: decals do not write depth (`depthWrite: false`) and use a
 *   polygon offset so they never z-fight with the surface. The projector's
 *   depth (`size.z`) is kept small so the clipped geometry hugs the surface.
 * - **TRAA/motion blur**: the velocity MRT is written from the decal's own
 *   (static) transform, so they resolve like the surface beneath.
 *
 * Materials are the caller's (any three material with `transparent: true`);
 * `prepareDecalMaterial` applies the depth/offset settings decals need.
 */
export interface DecalOptions {
  /** Projector centre on the surface, world space. */
  readonly position: THREE.Vector3;
  /** Surface normal at `position`, world space. The projector looks along it. */
  readonly normal: THREE.Vector3;
  /** Projector size: width, height, and depth along the normal. A number means a square of that size with depth `size * 0.5`. */
  readonly size: THREE.Vector3 | number;
  /** Roll around the normal, radians. */
  readonly rotation?: number;
  /** Mesh the decal is clipped from. Must have its world matrix up to date. */
  readonly target: THREE.Mesh;
  readonly material: THREE.Material;
  /** Render order among transparents; higher draws later (default 1). */
  readonly renderOrder?: number;
}

export interface DecalHandle extends Disposable {
  readonly mesh: THREE.Mesh;
}

/**
 * Oldest-first slot recycler for a fixed pool. Pure, so the recycling policy
 * is unit-tested without three.
 */
export class DecalPool {
  readonly capacity: number;
  /** Live slots, oldest first. */
  private readonly order: number[] = [];
  /** Slots handed back by `release`, reused before any never-used index. */
  private readonly free: number[] = [];
  private next = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`DecalPool: capacity must be a positive integer, got ${capacity}`);
    this.capacity = capacity;
  }

  /** Slots in use. */
  get count(): number {
    return this.order.length;
  }

  /** Slot indices from oldest to newest. */
  get slots(): readonly number[] {
    return this.order;
  }

  /**
   * Take a slot. Returns the index and whether it was recycled from a live
   * decal (the caller must release that decal's geometry first).
   */
  acquire(): { index: number; recycled: boolean } {
    if (this.order.length < this.capacity) {
      const index = this.free.length ? (this.free.pop() as number) : this.next++;
      this.order.push(index);
      return { index, recycled: false };
    }
    const index = this.order.shift() as number;
    this.order.push(index);
    return { index, recycled: true };
  }

  /** Give a slot back explicitly (a decal removed before it aged out). */
  release(index: number): boolean {
    const at = this.order.indexOf(index);
    if (at === -1) return false;
    this.order.splice(at, 1);
    this.free.push(index);
    return true;
  }

  /** Oldest live slot, or null. */
  oldest(): number | null {
    return this.order.length ? (this.order[0] as number) : null;
  }

  clear(): void {
    this.order.length = 0;
    this.free.length = 0;
    this.next = 0;
  }
}

const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _size = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _normal = new THREE.Vector3();

/** Projector orientation: +Z along `normal`, rolled by `rotation` around it. */
export function decalOrientation(normal: THREE.Vector3, rotation = 0, out = new THREE.Euler()): THREE.Euler {
  _normal.copy(normal).normalize();
  _quat.setFromUnitVectors(_zAxis, _normal);
  if (rotation !== 0) {
    const roll = new THREE.Quaternion().setFromAxisAngle(_normal, rotation);
    _quat.premultiply(roll);
  }
  return out.setFromQuaternion(_quat);
}

/** Depth/offset settings every decal material needs. Returns the same material. */
export function prepareDecalMaterial<T extends THREE.Material>(material: T): T {
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -4;
  material.polygonOffsetUnits = -4;
  return material;
}

export interface DecalsOptions {
  /** Dynamic pool size (impact marks). Default 32. */
  readonly dynamicCapacity?: number;
}

export class Decals implements Disposable {
  private readonly parent: THREE.Object3D;
  private readonly statics: THREE.Mesh[] = [];
  private readonly pool: DecalPool;
  private readonly dynamic: THREE.Mesh[] = [];
  private disposed = false;

  constructor(parent: THREE.Object3D, options: DecalsOptions = {}) {
    this.parent = parent;
    this.pool = new DecalPool(options.dynamicCapacity ?? 32);
    // The dynamic pool is allocated now: one mesh per slot with an empty
    // geometry, hidden until spawned. Spawning swaps the geometry only.
    for (let i = 0; i < this.pool.capacity; i++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), undefined);
      mesh.name = `Decal:dynamic:${i}`;
      mesh.visible = false;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      this.dynamic.push(mesh);
      parent.add(mesh);
    }
  }

  /** Static decals placed so far. */
  get staticCount(): number {
    return this.statics.length;
  }

  /** Dynamic decals currently visible. */
  get dynamicCount(): number {
    return this.pool.count;
  }

  /** Project a permanent decal. The geometry lives until `handle.dispose()` or `Decals.dispose()`. */
  addDecal(options: DecalOptions): DecalHandle {
    if (this.disposed) throw new Error('Decals: disposed');
    const geometry = this.project(options);
    const mesh = new THREE.Mesh(geometry, options.material);
    mesh.name = 'Decal:static';
    mesh.renderOrder = options.renderOrder ?? 1;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.parent.add(mesh);
    this.statics.push(mesh);
    return {
      mesh,
      dispose: (): void => {
        const at = this.statics.indexOf(mesh);
        if (at === -1) return;
        this.statics.splice(at, 1);
        mesh.removeFromParent();
        mesh.geometry.dispose();
      },
    };
  }

  /**
   * Project an impact decal into the fixed pool. When the pool is full the
   * oldest decal is recycled. Returns the pooled mesh (do not keep it: its
   * geometry is replaced when the slot is reused).
   */
  spawn(options: DecalOptions): THREE.Mesh {
    if (this.disposed) throw new Error('Decals: disposed');
    const { index } = this.pool.acquire();
    const mesh = this.dynamic[index] as THREE.Mesh;
    mesh.geometry.dispose();
    mesh.geometry = this.project(options);
    mesh.material = options.material;
    mesh.renderOrder = options.renderOrder ?? 2;
    mesh.receiveShadow = true;
    mesh.visible = true;
    return mesh;
  }

  /** Hide every dynamic decal (their slots return to the pool). */
  clearDynamic(): void {
    for (const mesh of this.dynamic) {
      mesh.visible = false;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
    }
    this.pool.clear();
  }

  private project(options: DecalOptions): THREE.BufferGeometry {
    if (typeof options.size === 'number') _size.set(options.size, options.size, options.size * 0.5);
    else _size.copy(options.size);
    decalOrientation(options.normal, options.rotation ?? 0, _euler);
    options.target.updateMatrixWorld();
    const geometry = new DecalGeometry(options.target, options.position, _euler, _size);
    geometry.computeBoundingSphere();
    return geometry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.statics) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.statics.length = 0;
    for (const mesh of this.dynamic) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.dynamic.length = 0;
    this.pool.clear();
  }
}
