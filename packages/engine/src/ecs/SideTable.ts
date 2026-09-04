import type { Entity } from './EntityWorld';

/**
 * Per-entity storage for things that are not numbers: three.js objects, Rapier
 * handles, strings, asset references. Keyed by entity id; entries are removed
 * automatically when the entity is destroyed (the world calls `onDestroy`).
 *
 * If a value owns a resource, pass `onDelete` so it is released when the entry
 * goes away for any reason (explicit delete, entity destroyed, world disposed).
 */
export class SideTable<T> {
  private readonly map = new Map<Entity, T>();
  private readonly onDelete: ((value: T, eid: Entity) => void) | undefined;
  private readonly detach: () => void;

  constructor(
    world: { registerSideTable(table: SideTable<unknown>): () => void },
    onDelete?: (value: T, eid: Entity) => void,
  ) {
    this.onDelete = onDelete;
    this.detach = world.registerSideTable(this as SideTable<unknown>);
  }

  get(eid: Entity): T | undefined {
    return this.map.get(eid);
  }

  /** Like `get` but throws if missing; use when the invariant is "this entity has one". */
  require(eid: Entity): T {
    const value = this.map.get(eid);
    if (value === undefined) throw new Error(`SideTable: entity ${eid} has no entry`);
    return value;
  }

  has(eid: Entity): boolean {
    return this.map.has(eid);
  }

  set(eid: Entity, value: T): void {
    const previous = this.map.get(eid);
    if (previous !== undefined && previous !== value) this.onDelete?.(previous, eid);
    this.map.set(eid, value);
  }

  delete(eid: Entity): boolean {
    const previous = this.map.get(eid);
    if (previous === undefined) return false;
    this.map.delete(eid);
    this.onDelete?.(previous, eid);
    return true;
  }

  get size(): number {
    return this.map.size;
  }

  forEach(fn: (value: T, eid: Entity) => void): void {
    for (const [eid, value] of this.map) fn(value, eid);
  }

  entries(): IterableIterator<[Entity, T]> {
    return this.map.entries();
  }

  /** Called by the world when an entity is destroyed. */
  onDestroy(eid: Entity): void {
    this.delete(eid);
  }

  clear(): void {
    if (this.onDelete) for (const [eid, value] of this.map) this.onDelete(value, eid);
    this.map.clear();
  }

  dispose(): void {
    this.clear();
    this.detach();
  }
}
