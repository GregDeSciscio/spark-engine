import {
  addComponent,
  addEntity,
  createWorld,
  deleteWorld,
  entityExists,
  getAllEntities,
  hasComponent,
  Not,
  observe,
  onAdd,
  onRemove,
  Or,
  query,
  removeComponent,
  removeEntity,
  type World as BitWorld,
} from 'bitecs';
import type { Disposable } from '../core/Disposable';
import {
  createStore,
  writeRow,
  type ComponentData,
  type ComponentSchema,
  type ComponentStore,
  type ComponentType,
} from './Component';
import type { SideTable } from './SideTable';
import { SystemRegistry, type System, type SystemStage } from './System';

export type Entity = number;

/** A query term: a component type, or `not(type)` / `or(a, b)`. */
export type QueryTerm = ComponentType | QueryOperatorTerm;

export interface QueryOperatorTerm {
  readonly __op: 'not' | 'or';
  readonly types: readonly ComponentType[];
}

export function not(type: ComponentType): QueryOperatorTerm {
  return { __op: 'not', types: [type] };
}

export function or(...types: ComponentType[]): QueryOperatorTerm {
  return { __op: 'or', types };
}

/** `[type, data]` pairs for `create()`: spawn with initial field values. */
export type ComponentInit<S extends ComponentSchema = ComponentSchema> = ComponentType<S> | [ComponentType<S>, ComponentData<S>];

export interface EntityWorldOptions {
  /** Maximum simultaneous entities. Component arrays are sized to this. */
  capacity?: number;
}

/**
 * The engine's entity model: a thin, typed wrapper over bitecs (ADR-003).
 * Nothing outside `ecs/` imports bitecs.
 *
 * - entities are integers
 * - components are typed-array stores resolved per world from a ComponentType
 * - resources live in SideTables, cleared automatically on destroy
 * - systems run in ordered stages driven by the engine loop
 */
export class EntityWorld implements Disposable {
  readonly capacity: number;
  readonly systems = new SystemRegistry();

  private world: BitWorld;
  private readonly stores = new Map<string, ComponentStore>();
  private readonly types = new Map<string, ComponentType>();
  private readonly sideTables = new Set<SideTable<unknown>>();
  private readonly destroyListeners = new Set<(eid: Entity) => void>();
  private disposed = false;

  constructor(options: EntityWorldOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
    this.world = createWorld();
  }

  // ---- components --------------------------------------------------------

  /** Resolve (and lazily create) the store for a component type in this world. */
  store<S extends ComponentSchema>(type: ComponentType<S>): ComponentStore<S> {
    const existing = this.stores.get(type.name);
    if (existing) {
      if (this.types.get(type.name) !== type) {
        throw new Error(`EntityWorld: two different component types share the name "${type.name}"`);
      }
      return existing as ComponentStore<S>;
    }
    // bitecs entity ids start at 1, so a world holding `capacity` entities needs
    // capacity + 1 rows.
    const store = createStore(type, this.capacity + 1);
    this.stores.set(type.name, store as ComponentStore);
    this.types.set(type.name, type as ComponentType);
    return store;
  }

  // ---- entities ----------------------------------------------------------

  create(...components: ComponentInit[]): Entity {
    this.assertLive();
    const eid = addEntity(this.world);
    if (eid > this.capacity) {
      removeEntity(this.world, eid);
      throw new Error(`EntityWorld: capacity ${this.capacity} exceeded`);
    }
    for (const init of components) {
      if (Array.isArray(init)) this.add(eid, init[0], init[1]);
      else this.add(eid, init);
    }
    return eid;
  }

  destroy(eid: Entity): void {
    if (this.disposed || !entityExists(this.world, eid)) return;
    for (const listener of this.destroyListeners) listener(eid);
    for (const table of this.sideTables) table.onDestroy(eid);
    removeEntity(this.world, eid);
  }

  exists(eid: Entity): boolean {
    return !this.disposed && entityExists(this.world, eid);
  }

  get count(): number {
    return this.disposed ? 0 : getAllEntities(this.world).length;
  }

  /** Every component type that has a store in this world, in registration order. Debug/inspector use. */
  componentTypes(): readonly ComponentType[] {
    return this.disposed ? [] : [...this.types.values()];
  }

  all(): readonly Entity[] {
    return this.disposed ? [] : getAllEntities(this.world);
  }

  /** Destroy every entity. Component stores and side tables are cleared. */
  clear(): void {
    if (this.disposed) return;
    for (const eid of [...getAllEntities(this.world)]) this.destroy(eid);
  }

  /** Listener runs before an entity's side-table entries are released. */
  onDestroy(listener: (eid: Entity) => void): () => void {
    this.destroyListeners.add(listener);
    return () => this.destroyListeners.delete(listener);
  }

  // ---- component membership ---------------------------------------------

  add<S extends ComponentSchema>(eid: Entity, type: ComponentType<S>, data?: ComponentData<S>): ComponentStore<S> {
    this.assertLive();
    const store = this.store(type);
    const added = addComponent(this.world, eid, store);
    if (added || data !== undefined) writeRow(store, eid, type.defaults, data);
    return store;
  }

  remove(eid: Entity, type: ComponentType): void {
    if (this.disposed) return;
    removeComponent(this.world, eid, this.store(type));
  }

  has(eid: Entity, type: ComponentType): boolean {
    return !this.disposed && hasComponent(this.world, eid, this.store(type));
  }

  // ---- queries -----------------------------------------------------------

  /** Entities matching every term. The array is owned by the query; do not mutate or retain it across frames. */
  query(...terms: QueryTerm[]): readonly Entity[] {
    if (this.disposed) return [];
    return query(this.world, terms.map((t) => this.term(t))) as readonly Entity[];
  }

  private term(t: QueryTerm): unknown {
    if ('__op' in t) {
      const stores = t.types.map((type) => this.store(type));
      return t.__op === 'not' ? Not(...stores) : Or(...stores);
    }
    return this.store(t);
  }

  /** Fires when a component is added to any entity. */
  onAdd(type: ComponentType, listener: (eid: Entity) => void): () => void {
    return observe(this.world, onAdd(this.store(type)), listener);
  }

  /** Fires when a component is removed from any entity, including on destroy. */
  onRemove(type: ComponentType, listener: (eid: Entity) => void): () => void {
    return observe(this.world, onRemove(this.store(type)), listener);
  }

  // ---- systems -----------------------------------------------------------

  addSystem(system: System): () => void {
    return this.systems.add(system);
  }

  runStage(stage: SystemStage, dt: number): void {
    if (this.disposed) return;
    this.systems.run(stage, this, dt);
  }

  // ---- side tables -------------------------------------------------------

  registerSideTable(table: SideTable<unknown>): () => void {
    this.sideTables.add(table);
    return () => this.sideTables.delete(table);
  }

  // ---- lifecycle ---------------------------------------------------------

  private assertLive(): void {
    if (this.disposed) throw new Error('EntityWorld: disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.systems.dispose();
    for (const table of [...this.sideTables]) table.clear();
    this.sideTables.clear();
    this.destroyListeners.clear();
    deleteWorld(this.world);
    this.stores.clear();
    this.types.clear();
    this.disposed = true;
  }
}
