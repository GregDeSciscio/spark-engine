import type { EntityWorld } from './EntityWorld';

/** Which loop phase a system runs in. Mirrors the engine loop. */
export type SystemStage = 'fixed' | 'update' | 'late';

export interface System {
  readonly name: string;
  readonly stage: SystemStage;
  /** Lower runs first within a stage. Default 0. */
  readonly order?: number;
  run(world: EntityWorld, dt: number): void;
  dispose?(): void;
}

/** Ordered system lists per stage. */
export class SystemRegistry {
  private readonly stages: Record<SystemStage, System[]> = { fixed: [], update: [], late: [] };
  private readonly timings = new Map<string, number>();

  add(system: System): () => void {
    const list = this.stages[system.stage];
    if (list.some((s) => s.name === system.name)) {
      throw new Error(`SystemRegistry: a system named "${system.name}" already exists in stage "${system.stage}"`);
    }
    list.push(system);
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return () => this.remove(system.name);
  }

  remove(name: string): boolean {
    for (const list of Object.values(this.stages)) {
      const i = list.findIndex((s) => s.name === name);
      if (i !== -1) {
        list[i]?.dispose?.();
        list.splice(i, 1);
        this.timings.delete(name);
        return true;
      }
    }
    return false;
  }

  has(name: string): boolean {
    return Object.values(this.stages).some((list) => list.some((s) => s.name === name));
  }

  list(stage?: SystemStage): readonly System[] {
    if (stage) return this.stages[stage];
    return [...this.stages.fixed, ...this.stages.update, ...this.stages.late];
  }

  run(stage: SystemStage, world: EntityWorld, dt: number): void {
    for (const system of this.stages[stage]) {
      const start = performance.now();
      system.run(world, dt);
      this.timings.set(system.name, performance.now() - start);
    }
  }

  /** Last measured wall time per system in ms. Debug stat. */
  lastTimings(): ReadonlyMap<string, number> {
    return this.timings;
  }

  dispose(): void {
    for (const list of Object.values(this.stages)) {
      for (const s of list) s.dispose?.();
      list.length = 0;
    }
    this.timings.clear();
  }
}
