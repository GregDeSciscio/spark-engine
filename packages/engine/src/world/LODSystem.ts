import type * as THREE from 'three/webgpu';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import type { System } from '../ecs/System';
import type { InstancedBatch } from '../ecs/systems/InstancedRenderSync';
import { LOD, LOD_UNASSIGNED } from './components';

export interface LODGroupDefinition {
  /**
   * Switch distances, nearest first: level `i` is used while the distance is
   * below `distances[i]`; beyond the last one the final level applies. Level
   * count is `distances.length + 1`. Scaled by the LOD bias at runtime.
   */
  readonly distances: readonly number[];
  /**
   * Hysteresis as a fraction of each threshold (default 0.1): an entity steps
   * up a level only past `d × (1 + h)` and back down only under `d × (1 − h)`,
   * so objects sitting on a boundary do not flicker.
   */
  readonly hysteresis?: number | undefined;
  /**
   * Instanced route: one batch per level (or null for "not drawn"). Switching
   * moves the entity's slot between batches. Entities in a batch group must not
   * also use the object route.
   */
  readonly batches?: ReadonlyArray<InstancedBatch | null> | undefined;
}

export interface LODStats {
  entities: number;
  /** Level changes applied in the last run. */
  switches: number;
  /** Entities whose target batch was full in the last run (they retry next frame). */
  overflow: number;
  /** Entities per level in the last run (index = level). */
  perLevel: number[];
}

/**
 * Pure level selection with hysteresis, exported for tests.
 *
 * @param distance distance from the camera
 * @param thresholds switch distances, nearest first (already bias-scaled)
 * @param current current level, or `LOD_UNASSIGNED`
 * @param hysteresis fraction of each threshold, ≥ 0
 */
export function selectLOD(distance: number, thresholds: ArrayLike<number>, current: number, hysteresis: number): number {
  const levels = thresholds.length + 1;
  if (current >= levels || current === LOD_UNASSIGNED) {
    // No history: plain threshold walk.
    let level = 0;
    while (level < thresholds.length && distance >= (thresholds[level] as number)) level++;
    return level;
  }
  let level = current;
  // Step further away while the distance clears the next threshold with margin.
  while (level < thresholds.length && distance >= (thresholds[level] as number) * (1 + hysteresis)) level++;
  // Step closer while the distance is under the previous threshold with margin.
  while (level > 0 && distance < (thresholds[level - 1] as number) * (1 - hysteresis)) level--;
  return level;
}

interface LODGroup {
  readonly base: Float32Array;
  readonly scaled: Float32Array;
  /** Squared "step further" thresholds: scaled × (1 + h), squared. */
  readonly upSq: Float32Array;
  /** Squared "step closer" thresholds: scaled × (1 − h), squared. */
  readonly downSq: Float32Array;
  /** Squared plain thresholds for entities without history. */
  readonly plainSq: Float32Array;
  readonly hysteresis: number;
  batches: ReadonlyArray<InstancedBatch | null> | null;
}

function rescale(g: LODGroup, bias: number): void {
  for (let i = 0; i < g.base.length; i++) {
    const d = (g.base[i] as number) * bias;
    g.scaled[i] = d;
    g.plainSq[i] = d * d;
    g.upSq[i] = d * (1 + g.hysteresis) * (d * (1 + g.hysteresis));
    g.downSq[i] = d * (1 - g.hysteresis) * (d * (1 - g.hysteresis));
  }
}

/**
 * Per-entity level of detail. Groups define distance thresholds (scaled by
 * `quality.lodBias`) and either an instanced batch per level or, per entity,
 * one Object3D per level (`attachObjects`). Runs in the late stage before
 * culling so a newly chosen level is culled and uploaded in the same frame.
 *
 * Entities are `add`-ed with a group; the level is chosen on the next run.
 * When an entity is destroyed it is removed from its batch automatically.
 */
export class LODSystem implements System {
  readonly name = 'LODSystem';
  readonly stage = 'late' as const;
  readonly order = 890;

  /** Object route: per-entity Object3Ds, index = level. Toggled via `visible`. */
  readonly objects: SideTable<ReadonlyArray<THREE.Object3D | null>>;

  private readonly groups: LODGroup[] = [];
  private camera: THREE.Camera | null = null;
  private bias: number;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = 0;
  private readonly detach: () => void;
  private readonly statsValue: LODStats = { entities: 0, switches: 0, overflow: 0, perLevel: [] };

  constructor(world: EntityWorld, options: { lodBias?: number | undefined } = {}) {
    this.bias = options.lodBias ?? 1;
    this.objects = new SideTable<ReadonlyArray<THREE.Object3D | null>>(world);
    // bitecs fires onRemove for a destroyed entity too, so batch slots are
    // always given back.
    this.detach = world.onRemove(LOD, (eid) => this.releaseSlot(world, eid));
  }

  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  /** Pass `quality.lodBias`: >1 keeps detail further out, <1 drops it sooner. */
  setLODBias(bias: number): void {
    if (bias === this.bias) return;
    this.bias = bias;
    for (const g of this.groups) rescale(g, bias);
  }

  getLODBias(): number {
    return this.bias;
  }

  defineGroup(definition: LODGroupDefinition): number {
    const base = Float32Array.from(definition.distances);
    for (let i = 1; i < base.length; i++) {
      if ((base[i] as number) < (base[i - 1] as number)) throw new Error('LODSystem: distances must be ascending');
    }
    const hysteresis = definition.hysteresis ?? 0.1;
    if (definition.batches && definition.batches.length !== base.length + 1) {
      throw new Error(`LODSystem: group has ${base.length + 1} levels but ${definition.batches.length} batches`);
    }
    const n = base.length;
    const group: LODGroup = {
      base,
      scaled: new Float32Array(n),
      upSq: new Float32Array(n),
      downSq: new Float32Array(n),
      plainSq: new Float32Array(n),
      hysteresis,
      batches: definition.batches ?? null,
    };
    rescale(group, this.bias);
    this.groups.push(group);
    return this.groups.length - 1;
  }

  /** Replace a group's batches (e.g. when an asset's batches are rebuilt). Entities keep their level. */
  setGroupBatches(group: number, batches: ReadonlyArray<InstancedBatch | null> | null): void {
    const g = this.requireGroup(group);
    if (batches && batches.length !== g.base.length + 1) throw new Error('LODSystem: batch count does not match level count');
    g.batches = batches;
  }

  levelCount(group: number): number {
    return this.requireGroup(group).base.length + 1;
  }

  /** Put an entity in a group. Its level is chosen on the next run. */
  add(world: EntityWorld, eid: Entity, group: number): void {
    this.requireGroup(group);
    world.add(eid, LOD, { group, level: LOD_UNASSIGNED });
  }

  /** Object route: one Object3D per level (null = nothing at that level). Only the current level is visible. */
  attachObjects(world: EntityWorld, eid: Entity, objects: ReadonlyArray<THREE.Object3D | null>): void {
    const lod = world.store(LOD);
    if (!world.has(eid, LOD)) throw new Error(`LODSystem: entity ${eid} is not in a group; call add() first`);
    const g = this.requireGroup(lod.group[eid] as number);
    if (objects.length !== g.base.length + 1) throw new Error('LODSystem: object count does not match level count');
    this.objects.set(eid, objects);
    const level = lod.level[eid] as number;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      if (o) o.visible = i === level;
    }
  }

  /** Remove an entity from its group and batch. */
  remove(world: EntityWorld, eid: Entity): void {
    if (!world.has(eid, LOD)) return;
    world.remove(eid, LOD); // onRemove releases the slot
    this.objects.delete(eid);
  }

  private releaseSlot(world: EntityWorld, eid: Entity): void {
    const lod = world.store(LOD);
    const level = lod.level[eid] as number;
    if (level === LOD_UNASSIGNED) return;
    const g = this.groups[lod.group[eid] as number];
    g?.batches?.[level]?.remove(eid);
    lod.level[eid] = LOD_UNASSIGNED;
  }

  stats(): LODStats {
    return this.statsValue;
  }

  run(world: EntityWorld): void {
    const camera = this.camera;
    const s = this.statsValue;
    s.entities = 0;
    s.switches = 0;
    s.overflow = 0;
    for (let i = 0; i < s.perLevel.length; i++) s.perLevel[i] = 0;
    if (!camera) return;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this.cameraX = e[12] as number;
    this.cameraY = e[13] as number;
    this.cameraZ = e[14] as number;
    const cx = this.cameraX;
    const cy = this.cameraY;
    const cz = this.cameraZ;
    const lod = world.store(LOD);
    const t = world.store(Transform);
    const groups = this.groups;
    const perLevel = s.perLevel;
    const list = world.query(LOD, Transform);
    let switches = 0;
    let overflow = 0;
    for (let i = 0; i < list.length; i++) {
      const eid = list[i] as number;
      const g = groups[lod.group[eid] as number];
      if (!g) continue;
      const dx = (t.x[eid] as number) - cx;
      const dy = (t.y[eid] as number) - cy;
      const dz = (t.z[eid] as number) - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const current = lod.level[eid] as number;
      const count = g.base.length;
      // Same walk as selectLOD, on squared distances (no sqrt per entity).
      let level: number;
      if (current === LOD_UNASSIGNED || current > count) {
        level = 0;
        while (level < count && d2 >= (g.plainSq[level] as number)) level++;
      } else {
        level = current;
        while (level < count && d2 >= (g.upSq[level] as number)) level++;
        while (level > 0 && d2 < (g.downSq[level - 1] as number)) level--;
      }
      if (level !== current) {
        if (this.switch(eid, g, current, level)) {
          lod.level[eid] = level;
          switches++;
        } else {
          // Target batch full: out of every batch for now, retried next run.
          lod.level[eid] = LOD_UNASSIGNED;
          overflow++;
          continue;
        }
      }
      perLevel[level] = (perLevel[level] ?? 0) + 1;
    }
    s.entities = list.length;
    s.switches = switches;
    s.overflow = overflow;
  }

  /** Returns false when the destination batch is full (the entity is left in no batch). */
  private switch(eid: Entity, g: LODGroup, from: number, to: number): boolean {
    const batches = g.batches;
    if (batches) {
      if (from !== LOD_UNASSIGNED) batches[from]?.remove(eid);
      const target = batches[to];
      if (target && target.tryAdd(eid) === -1) return false;
    }
    const objects = this.objects.get(eid);
    if (objects) {
      if (from !== LOD_UNASSIGNED) {
        const o = objects[from];
        if (o) o.visible = false;
      }
      const o = objects[to];
      if (o) o.visible = true;
    }
    return true;
  }

  private requireGroup(group: number): LODGroup {
    const g = this.groups[group];
    if (!g) throw new Error(`LODSystem: unknown group ${group}`);
    return g;
  }

  dispose(): void {
    this.detach();
    this.objects.dispose();
    this.groups.length = 0;
  }
}
