import { describe, expect, it, vi } from 'vitest';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { SystemRegistry, type System, type SystemStage } from '../src/ecs/System';

/**
 * The registry decides what runs, in which loop phase, and in what order —
 * the thing every scene's `entities.addSystem` hands its work to. Ordering and
 * teardown are the parts a scene can be broken by, so they are what is pinned
 * here.
 */

function system(name: string, stage: SystemStage, order?: number, run: (dt: number) => void = () => {}): System {
  return { name, stage, ...(order === undefined ? {} : { order }), run: (_world, dt) => run(dt) };
}

describe('SystemRegistry', () => {
  it('runs a stage in ascending order, and only that stage', () => {
    const registry = new SystemRegistry();
    const world = new EntityWorld({ capacity: 8 });
    const seen: string[] = [];
    registry.add(system('late', 'fixed', 10, () => seen.push('late')));
    registry.add(system('early', 'fixed', -5, () => seen.push('early')));
    registry.add(system('middle', 'fixed', undefined, () => seen.push('middle')));
    registry.add(system('other-stage', 'update', -100, () => seen.push('other-stage')));
    registry.run('fixed', world, 1 / 60);
    expect(seen).toEqual(['early', 'middle', 'late']);
    registry.run('update', world, 1 / 60);
    expect(seen).toEqual(['early', 'middle', 'late', 'other-stage']);
  });

  it('keeps the order when a system is added after the first run', () => {
    const registry = new SystemRegistry();
    const world = new EntityWorld({ capacity: 8 });
    const seen: string[] = [];
    registry.add(system('b', 'update', 2, () => seen.push('b')));
    registry.run('update', world, 0.016);
    registry.add(system('a', 'update', 1, () => seen.push('a')));
    seen.length = 0;
    registry.run('update', world, 0.016);
    expect(seen).toEqual(['a', 'b']);
  });

  it('passes the world and the delta through', () => {
    const registry = new SystemRegistry();
    const world = new EntityWorld({ capacity: 8 });
    const run = vi.fn();
    registry.add({ name: 'spy', stage: 'late', run });
    registry.run('late', world, 0.25);
    expect(run).toHaveBeenCalledWith(world, 0.25);
  });

  it('refuses two systems with the same name in one stage', () => {
    const registry = new SystemRegistry();
    registry.add(system('physics', 'fixed'));
    expect(() => registry.add(system('physics', 'fixed'))).toThrow(/already exists/);
    // The same name in a different stage is allowed: stages are separate lists.
    expect(() => registry.add(system('physics', 'update'))).not.toThrow();
    expect(registry.list()).toHaveLength(2);
  });

  it('hands back a remover that disposes the system', () => {
    const registry = new SystemRegistry();
    const dispose = vi.fn();
    const remove = registry.add({ name: 'temp', stage: 'update', run: () => {}, dispose });
    expect(registry.has('temp')).toBe(true);
    remove();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.has('temp')).toBe(false);
    // A scene that disposes twice must not double-dispose.
    remove();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports whether a removal found anything', () => {
    const registry = new SystemRegistry();
    registry.add(system('render-sync', 'late'));
    expect(registry.remove('render-sync')).toBe(true);
    expect(registry.remove('render-sync')).toBe(false);
  });

  it('lists every stage in loop order when no stage is named', () => {
    const registry = new SystemRegistry();
    registry.add(system('l', 'late'));
    registry.add(system('f', 'fixed'));
    registry.add(system('u', 'update'));
    expect(registry.list().map((s) => s.name)).toEqual(['f', 'u', 'l']);
    expect(registry.list('update').map((s) => s.name)).toEqual(['u']);
  });

  it('times each system it runs and forgets a removed one', () => {
    const registry = new SystemRegistry();
    const world = new EntityWorld({ capacity: 8 });
    registry.add(system('a', 'fixed'));
    registry.add(system('b', 'fixed'));
    registry.run('fixed', world, 0.016);
    expect([...registry.lastTimings().keys()].sort()).toEqual(['a', 'b']);
    for (const ms of registry.lastTimings().values()) expect(ms).toBeGreaterThanOrEqual(0);
    registry.remove('a');
    expect([...registry.lastTimings().keys()]).toEqual(['b']);
  });

  it('disposes everything it holds, in every stage', () => {
    const registry = new SystemRegistry();
    const disposed: string[] = [];
    for (const stage of ['fixed', 'update', 'late'] as const) {
      registry.add({ name: stage, stage, run: () => {}, dispose: () => disposed.push(stage) });
    }
    registry.dispose();
    expect(disposed.sort()).toEqual(['fixed', 'late', 'update']);
    expect(registry.list()).toHaveLength(0);
    expect(registry.lastTimings().size).toBe(0);
    // And it is reusable afterwards, which is what a scene swap needs.
    expect(() => registry.add(system('fresh', 'fixed'))).not.toThrow();
  });
});
